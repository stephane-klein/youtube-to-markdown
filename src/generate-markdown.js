import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, generateText } from "ai";
import { Listr, ListrLogger, ProcessOutput } from "listr2";
import { stringify } from "yaml";
import {
  chunkTranscript,
  dedupeAdjacentHeadings,
  estimateTokens,
  firstBlock,
  lastBlock,
  replaceFirstBlock,
} from "./chunk.js";
import { loadPricing } from "./pricing.js";
import { vttToText } from "./vtt-cues.js";
import {
  DEFAULT_DIR,
  downloadVtt,
  exists,
  titleForLang,
  videoJobs,
  writeMarker,
} from "./vtt.js";

const SYSTEM = [
  "You clean up a YouTube video transcript so it can be read, without rewriting it.",
  "- You are not an editor: you do not improve the text and you do not correct the speaker.",
  "- The output is a citable transcript, in the speaker's own words and own word order.",
  "- Write in the same language as the transcript.",
  "- You are transcribing, not summarizing. Preserve the speaker's words and the direct speech.",
  "- Do not summarize and do not add facts that are not in the transcript.",
  "- Never convert direct speech into reported speech: do not write phrases like \"the journalist asks\", \"X says that\" or \"he explains\".",
  "- Keep the repetitions, digressions and examples from the transcript.",
  "- The transcript is spoken language, often improvised. Keep its oral syntax, even when it is loose: repeated words, false starts, unfinished sentences, unusual word order, dropped negations.",
  "- Do not correct, reword, reorder or \"improve\" the speaker's grammar. Never replace an oral turn of phrase by a more formal or more standard one.",
  "- Only fix what comes from the automatic transcription: timestamps, broken cues, missing punctuation, capitalisation and obviously misheard words.",
  "- Example: if the transcript says \"comment vous caractérisez, comment vous qualifiez la journée\", keep \"comment vous caractérisez, comment vous qualifiez la journée\". Do not write \"comment caractérisez-vous, comment qualifiez-vous la journée\".",
  "- Merge the fragmented cues into full sentences and paragraphs.",
  "- Do not add speaker labels, speaker names or dialogue formatting.",
  "- Do not write lines like `**Name :**` or `Name:`, and do not use bold to mark speaker turns.",
  "- If the transcript is a dialogue, keep the original order of the turns but do not label them.",
  "- You may add section headings (##, ###) when the transcript clearly moves between topics.",
  "- Do not add a main title, it is provided separately.",
  "- Do not wrap the output in code fences.",
  "- Output only the Markdown body.",
  "- Before answering, reread your text sentence by sentence and check that no sentence has been turned into a more formal or more standard version of the spoken words.",
].join("\n");

const SMOOTH_SYSTEM = [
  "You improve the transition between two consecutive Markdown sections that were written independently.",
  "- You are given the end of the previous section and the beginning of the next one.",
  "- Rewrite ONLY the beginning of the next section so it flows naturally from the previous one.",
  "- Keep the same language, the same facts and roughly the same length.",
  "- Do not correct the grammar and do not reword the sentences.",
  "- Only change the opening words that are needed to make the section start correctly.",
  "- Keep the Markdown formatting of the beginning.",
  "- Output only the rewritten beginning, without any preamble or code fences.",
].join("\n");

const DETECT_SYSTEM = [
  "You analyze a transcript excerpt to decide whether it is a dialogue between two or more people.",
  "- A dialogue means at least two distinct people speak.",
  "- A monologue, a lecture, a solo commentary or a reading is not a dialogue.",
  "- Use proper names only when they are explicitly present in the title or the excerpt.",
  "- Otherwise use stable role labels in the transcript language.",
  "- If the excerpt is too short or too ambiguous, set likely_dialogue to null.",
  "- Output only JSON, without code fences.",
  "- JSON shape: {\"likely_dialogue\": true|false|null, \"confidence\": \"high\"|\"low\", \"speakers\": [{\"label\": \"...\", \"type\": \"name\"|\"role\"}]}",
].join("\n");

const WIDTH = 80;

function cachedInputTokens(usage) {
  const details = usage?.inputTokenDetails ?? {};
  return details.cacheReadTokens ?? usage?.cachedInputTokens ?? 0;
}

function estimateCost(price, usage) {
  if (!price || !usage) return null;

  const details = usage.inputTokenDetails ?? {};
  const cached = cachedInputTokens(usage);
  const input =
    details.noCacheTokens ?? Math.max((usage.inputTokens ?? 0) - cached, 0);

  return (
    (input / 1e6) * price.input +
    (cached / 1e6) * (price.cachedInput ?? 0) +
    ((usage.outputTokens ?? 0) / 1e6) * price.output
  );
}

const OUTPUT_FACTOR = 2;
const OUTPUT_FLOOR = 2048;
const DEFAULT_CEILING = 32768;
const DEFAULT_REASONING = "low";
const DEFAULT_CHUNK_TARGET_TOKENS = 8000;

function isSet(value) {
  return value !== undefined && value !== null && value !== "";
}

function plannedBudget(transcript, ceiling, factor = OUTPUT_FACTOR) {
  const inputTokens = estimateTokens(transcript);
  return Math.min(
    ceiling,
    Math.max(OUTPUT_FLOOR, Math.ceil(inputTokens * factor)),
  );
}

function budgetForPart(text, { maxOutputTokens, ceiling }) {
  if (isSet(maxOutputTokens)) return Number(maxOutputTokens);
  return plannedBudget(text, ceiling);
}

function metricsLine(modelId, usage, elapsed, cost) {
  const reasoning = usage?.outputTokenDetails?.reasoningTokens;
  return [
    modelId,
    `llm ${elapsed.toFixed(1)}s`,
    usage
      ? `${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out`
      : "usage ?",
    reasoning ? `${reasoning} reasoning` : null,
    cost === null ? null : `~$${cost.toFixed(6)}`,
  ]
    .filter(Boolean)
    .join("  ");
}

function jobAuthors(video, channel) {
  const authors = video.authors ?? channel.authors ?? [];
  if (
    !Array.isArray(authors) ||
    authors.some((author) => typeof author !== "string" || !author.trim())
  ) {
    throw new Error("authors must be an array of non-empty strings");
  }
  return authors;
}

function frontmatter(
  job,
  {
    modelId,
    usage,
    elapsed,
    cost,
    finishReason,
    rawFinishReason,
    price,
    chunks,
    likelyDialogue,
  },
) {
  const data = {
    source_url: job.url,
    video_title: titleForLang(job.titles, job.lang),
    generated_at: new Date().toISOString(),
    authors: job.authors ?? [],
    original_published_date: job.publishedDate || undefined,
    likely_dialogue:
      likelyDialogue === undefined ? null : likelyDialogue,
    llm: {
      model: modelId,
      chunks: chunks ?? 1,
      duration_seconds: Number(elapsed.toFixed(1)),
      input_tokens: usage?.inputTokens ?? null,
      cached_input_tokens: usage ? cachedInputTokens(usage) : null,
      output_tokens: usage?.outputTokens ?? null,
      reasoning_tokens: usage?.outputTokenDetails?.reasoningTokens ?? null,
      text_tokens: usage?.outputTokenDetails?.textTokens ?? null,
      estimated_cost_usd: cost === null ? null : Number(cost.toFixed(6)),
      finish_reason: finishReason,
      raw_finish_reason: rawFinishReason ?? null,
      pricing: price ? { source: price.source, peak: price.peak } : null,
    },
  };

  return `---\n${stringify(data, { lineWidth: 0 }).trimEnd()}\n---\n\n`;
}

export function emptyOutputReason({
  emptyParts,
  chunks,
  finishReason,
  rawFinishReason,
  usage,
}) {
  const raw =
    rawFinishReason && rawFinishReason !== finishReason
      ? `/${rawFinishReason}`
      : "";
  const text = usage?.outputTokenDetails?.textTokens ?? null;
  const reasoning = usage?.outputTokenDetails?.reasoningTokens ?? null;
  return (
    `empty output: part ${emptyParts.join(",")}/${chunks}, ` +
    `finish=${finishReason}${raw}, text_tokens=${text}, ` +
    `reasoning_tokens=${reasoning}`
  );
}

export function outputLimitError({
  label = "LLM call",
  budget,
  ceiling,
  usage,
  finishReason = "length",
  rawFinishReason,
} = {}) {
  const raw =
    rawFinishReason && rawFinishReason !== finishReason
      ? `/${rawFinishReason}`
      : "";
  const output = usage?.outputTokens ?? "unknown";
  const reasoning = usage?.outputTokenDetails?.reasoningTokens ?? 0;
  const text = usage?.outputTokenDetails?.textTokens ?? "unknown";
  const numericBudget = Number(budget);
  const numericCeiling = Number(ceiling);
  const canIncrease =
    Number.isFinite(numericBudget) &&
    (!Number.isFinite(numericCeiling) || numericBudget < numericCeiling);
  const noText = usage?.outputTokenDetails?.textTokens === 0;
  const suggestion = noText
    ? "The model spent the entire output budget on reasoning and wrote no text. Disable reasoning or use a non-reasoning model."
    : canIncrease
      ? `Increase --max-output-tokens (currently ${budget}, try ${
          Number.isFinite(numericCeiling)
            ? Math.min(numericCeiling, numericBudget * 2)
            : numericBudget * 2
        }) or lower the reasoning effort.`
      : "The output budget is the model maximum; lower the reasoning effort or split the input.";
  const error = new Error(
    `${label} reached the output limit (finishReason=${finishReason}${raw}): ` +
      `max_tokens=${budget ?? "unknown"}, output_tokens=${output}, ` +
      `reasoning_tokens=${reasoning}, text_tokens=${text}. ${suggestion}`,
  );
  error.code = "OUTPUT_LIMIT";
  error.usage = usage;
  return error;
}

const isHeading = (text) => /^#{1,6}\s/.test(text);

const isStructured = (text) =>
  text
    .split("\n")
    .some((line) => /^\s*(-|\*|\d+\.)\s/.test(line) || /^\s*\|/.test(line));

function wrapText(text) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    if (!line) {
      line = word;
    } else if (line.length + 1 + word.length <= WIDTH) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.join("\n");
}

const SPEAKER_LABEL = /^\*\*[^*\n]{1,80}\s?:\*\*$/;

function normalizeSpeakerLabels(body) {
  const blocks = `${body ?? ""}`.split(/\n{2,}/);
  const out = [];
  let pendingLabel = "";

  for (const block of blocks) {
    const text = block.trim();
    if (!text) continue;

    if (SPEAKER_LABEL.test(text)) {
      pendingLabel = pendingLabel ? `${pendingLabel} ${text}` : text;
      continue;
    }

    if (pendingLabel && !isHeading(text)) {
      out.push(`${pendingLabel} ${text}`);
      pendingLabel = "";
      continue;
    }

    if (pendingLabel) {
      out.push(pendingLabel);
      pendingLabel = "";
    }
    out.push(text);
  }

  if (pendingLabel) out.push(pendingLabel);
  return out.join("\n\n");
}

function hardWrap(body) {
  return normalizeSpeakerLabels(body)
    .split(/\n{2,}/)
    .map((block) => {
      const text = block.trim();
      if (!text) return "";
      if (isHeading(text) || isStructured(text)) return text;
      return wrapText(text.replace(/\s*\n\s*/g, " "));
    })
    .join("\n\n");
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(error) {
  return APICallError.isInstance(error) && error.isRetryable;
}

function retryDelayMs(error, fallbackMs) {
  const headers = APICallError.isInstance(error)
    ? error.responseHeaders
    : undefined;
  let headerMs;
  if (headers?.["retry-after-ms"] !== undefined) {
    headerMs = Number.parseFloat(headers["retry-after-ms"]);
  } else if (headers?.["retry-after"] !== undefined) {
    const seconds = Number.parseFloat(headers["retry-after"]);
    headerMs = Number.isNaN(seconds)
      ? Date.parse(headers["retry-after"]) - Date.now()
      : seconds * 1000;
  }

  if (!Number.isFinite(headerMs) || headerMs <= 0) return fallbackMs;
  return Math.max(headerMs, fallbackMs);
}

export function describeCause(error) {
  if (!APICallError.isInstance(error)) return `${error.message}`;

  const status = error.statusCode ? `HTTP ${error.statusCode}` : "API error";
  const body = error.responseBody?.trim().replace(/\s+/g, " ").slice(0, 200);
  return `${status} ${error.message}${body ? `: ${body}` : ""}`;
}

export function describeError(error, attempts) {
  return `${describeCause(error)} after ${attempts} attempt(s)`;
}

function parseRetryDelays(value) {
  return `${value}`
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item) * 1000)
    .filter((item) => Number.isFinite(item) && item >= 0);
}

function convertUsage(usage) {
  const prompt = usage?.prompt_tokens ?? 0;
  const completion = usage?.completion_tokens ?? 0;
  const cacheRead =
    usage?.prompt_cache_hit_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    0;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: {
      total: prompt,
      noCache: Math.max(prompt - cacheRead, 0),
      cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: completion,
      text: Math.max(completion - reasoning, 0),
      reasoning,
    },
    raw: usage,
  };
}

export function createModel({ modelId, endpoint, apiKey, session }) {
  const provider = createOpenAICompatible({
    name: "opencode",
    apiKey,
    baseURL: endpoint.replace(/\/chat\/completions\/?$/, ""),
    headers: session ? { "X-OpenCode-Session": session } : {},
    convertUsage,
  });
  return provider(modelId);
}

export function reasoningOptions(reasoning, endpoint = "") {
  if (reasoning === "none") {
    return /deepseek/i.test(endpoint)
      ? {
          providerOptions: {
            opencode: { thinking: { type: "disabled" } },
          },
        }
      : { reasoning: "none" };
  }
  return reasoning ? { reasoning } : {};
}

function logLlmDebug({
  maxOutputTokens,
  reasoning,
  finishReason,
  rawFinishReason,
  text,
  reasoningText,
  warnings,
}) {
  console.error(
    `llm debug: max_tokens=${maxOutputTokens ?? "-"} ` +
      `reasoning=${reasoning ?? "provider-default"} ` +
      `finish=${finishReason} raw=${rawFinishReason ?? "-"} ` +
      `text_chars=${text?.length ?? 0} ` +
      `reasoning_chars=${reasoningText?.length ?? 0}`,
  );
  if (warnings?.length) {
    console.error(`llm debug: warnings=${JSON.stringify(warnings)}`);
  }
  if (!`${text ?? ""}`.trim() && reasoningText) {
    const preview = reasoningText.replace(/\s+/g, " ").slice(0, 300);
    console.error(`llm debug: empty text, reasoning preview: ${preview}`);
  }
}

function videoSession(base, job) {
  const id = createHash("sha256")
    .update(`${job.url}#${job.lang}`)
    .digest("hex")
    .slice(0, 16);
  return `${base || "youtube-to-markdown"}-${id}`;
}

function cleanBody(text) {
  return text
    .trim()
    .replace(/^```[a-z]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

async function generateOnce(
  {
    model,
    retryDelays,
    session,
    limiter,
    priceAt,
    reasoning,
    endpoint,
    debug,
  },
  { system, prompt, maxOutputTokens, onRetry, temperature = 0.2 },
) {
  const totalAttempts = retryDelays.length + 1;

  for (let attempt = 1;; attempt++) {
    const started = performance.now();
    try {
      let at;
      const call = () => {
        at = new Date();
        return generateText({
          model,
          system,
          prompt,
          temperature,
          ...reasoningOptions(reasoning, endpoint),
          maxOutputTokens,
          maxRetries: 0,
          headers: { "X-OpenCode-Session": session },
        });
      };
      const result = await (limiter ? limiter(call) : call());
      const {
        text,
        usage,
        finishReason,
        rawFinishReason,
        reasoningText,
        warnings,
      } = result;
      const elapsed = (performance.now() - started) / 1000;
      const price = priceAt ? priceAt(at) : null;
      const cost = estimateCost(price, usage);

      if (debug) {
        logLlmDebug({
          maxOutputTokens,
          reasoning,
          finishReason,
          rawFinishReason,
          text,
          reasoningText,
          warnings,
        });
      }

      return {
        text,
        usage,
        finishReason,
        rawFinishReason,
        elapsed,
        price,
        cost,
      };
    } catch (error) {
      if (!isRetryable(error) || attempt > retryDelays.length) {
        throw new Error(describeError(error, attempt), { cause: error });
      }
      const waitMs = retryDelayMs(error, retryDelays[attempt - 1]);
      onRetry?.(attempt + 1, totalAttempts, waitMs, error);
      await delay(waitMs);
    }
  }
}

const FIDELITY_REMINDER =
  "Keep the speaker's spoken words and word order: do not correct the grammar.";

function chunkPrompt(title, transcript, index, total) {
  if (total <= 1) {
    return [
      `Title: ${title}`,
      "",
      FIDELITY_REMINDER,
      "",
      `Transcript:\n${transcript}`,
    ].join("\n");
  }
  return [
    `Title: ${title}`,
    "",
    `This is part ${index + 1} of ${total} of the transcript.`,
    "Output only the Markdown body for this part, without the main title.",
    FIDELITY_REMINDER,
    "",
    `Transcript (part ${index + 1}/${total}):`,
    transcript,
  ].join("\n");
}

function smoothPrompt(previousTail, nextHead) {
  return [
    "End of the previous section:",
    "",
    previousTail,
    "",
    "Beginning of the next section:",
    "",
    nextHead,
  ].join("\n");
}

const SUMMARY_MARKERS = [
  ["interview opening", /l['’]entretien s['’]ouvre/i],
  [
    "journalist narration",
    /\b(la|le) journaliste\s+(propose|demande|interroge|explique|souligne|rappelle|questionne)\b/i,
  ],
  [
    "reported answer",
    /\b(il|elle)\s+(répond|explique|souligne|rappelle|indique|précise|ajoute|décrit)\b/i,
  ],
  ["reported example", /\b(il|elle)\s+prend l['’]exemple\b/i],
  ["reported view", /\b(selon|d['’]après)\s+(lui|elle)\b/i],
];

const SUMMARY_MARKER_LIMIT = 3;

export function summaryMarkers(body) {
  const text = `${body ?? ""}`;
  return SUMMARY_MARKERS
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
}

export function looksLikeSummary(body) {
  const markers = summaryMarkers(body);
  return (
    markers.length >= SUMMARY_MARKER_LIMIT &&
    (markers.includes("interview opening") ||
      markers.includes("journalist narration"))
  );
}

const DETECT_HEAD_CHARS = 8000;
const DETECT_TAIL_CHARS = 2000;

export function detectionSample(body) {
  const text = `${body ?? ""}`.trim();
  const limit = DETECT_HEAD_CHARS + DETECT_TAIL_CHARS;
  if (text.length <= limit) return text;
  return [
    text.slice(0, DETECT_HEAD_CHARS),
    "",
    "[...]",
    "",
    text.slice(-DETECT_TAIL_CHARS),
  ].join("\n");
}

export function detectPrompt(title, body) {
  return [
    `Title: ${title}`,
    "",
    "Transcript excerpt:",
    detectionSample(body),
  ].join("\n");
}

function normalizeSpeaker(speaker) {
  if (typeof speaker === "string") {
    const label = speaker.trim();
    return label ? { label, type: "role" } : null;
  }
  if (!speaker || typeof speaker !== "object") return null;
  const label = `${speaker.label ?? ""}`.trim();
  if (!label) return null;
  return {
    label,
    type: speaker.type === "name" ? "name" : "role",
  };
}

export function parseDetection(text) {
  const cleaned = `${text ?? ""}`
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  let data;
  try {
    data = JSON.parse(cleaned);
  } catch {
    return { likelyDialogue: null, confidence: "low", speakers: [] };
  }

  return {
    likelyDialogue:
      typeof data.likely_dialogue === "boolean" ? data.likely_dialogue : null,
    confidence: data.confidence === "high" ? "high" : "low",
    speakers: Array.isArray(data.speakers)
      ? data.speakers.map(normalizeSpeaker).filter(Boolean)
      : [],
  };
}

async function detectDialogue(ctx, { title, body, onRetry }) {
  const result = await generateOnce(ctx, {
    system: DETECT_SYSTEM,
    prompt: detectPrompt(title, body),
    maxOutputTokens: 1024,
    temperature: 0,
    onRetry,
  });
  return {
    ...parseDetection(result.text),
    usage: result.usage,
    elapsed: result.elapsed,
    cost: result.cost,
    price: result.price,
    finishReason: result.finishReason,
    rawFinishReason: result.rawFinishReason,
  };
}

function sumUsage(usages) {
  const present = usages.filter(Boolean);
  if (present.length === 0) return null;

  const total = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0 },
    outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
  };

  for (const usage of present) {
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
    total.totalTokens += usage.totalTokens ?? 0;
    total.inputTokenDetails.noCacheTokens +=
      usage.inputTokenDetails?.noCacheTokens ?? 0;
    total.inputTokenDetails.cacheReadTokens +=
      usage.inputTokenDetails?.cacheReadTokens ?? 0;
    total.outputTokenDetails.textTokens +=
      usage.outputTokenDetails?.textTokens ?? 0;
    total.outputTokenDetails.reasoningTokens +=
      usage.outputTokenDetails?.reasoningTokens ?? 0;
  }

  return total;
}

function createLimiter(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < max && queue.length > 0) {
      active++;
      const { task, resolve, reject } = queue.shift();
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          pump();
        });
    }
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
}

async function toMarkdown(
  {
    model,
    retryDelays,
    maxOutputTokens,
    ceiling,
    chunkTargetTokens,
    session,
    limiter,
    priceAt,
    reasoning,
    endpoint,
    debug,
  },
  title,
  transcript,
  onRetry,
  onProgress,
) {
  const budgetCeiling = isSet(maxOutputTokens)
    ? Number(maxOutputTokens)
    : ceiling;
  const desired = Math.max(
    OUTPUT_FLOOR,
    Math.ceil(estimateTokens(transcript) * OUTPUT_FACTOR),
  );
  const parts =
    desired > budgetCeiling
      ? chunkTranscript(transcript, { targetTokens: chunkTargetTokens })
      : [transcript];

  const total = parts.length;
  const bodies = new Array(total);
  const usages = [];
  let elapsed = 0;
  let finishReason = "stop";
  let rawFinishReason;
  let cost = 0;
  let costKnown = true;
  let price = null;
  let failedBudget = null;
  let failedUsage = null;

  await Promise.all(
    parts.map(async (part, index) => {
      onProgress?.(index + 1, total);
      const budget = budgetForPart(part, { maxOutputTokens, ceiling });
      const result = await generateOnce(
        {
          model,
          retryDelays,
          session,
          limiter,
          priceAt,
          reasoning,
          endpoint,
          debug,
        },
        {
          system: SYSTEM,
          prompt: chunkPrompt(title, part, index, total),
          maxOutputTokens: budget,
          temperature: 0,
          onRetry,
        },
      );
      bodies[index] = cleanBody(result.text);
      usages.push(result.usage);
      elapsed += result.elapsed;
      if (result.cost === null) costKnown = false;
      else cost += result.cost;
      if (price === null && result.price) price = result.price;
      if (rawFinishReason === undefined) {
        rawFinishReason = result.rawFinishReason;
      }
      if (result.finishReason !== "stop" && finishReason === "stop") {
        finishReason = result.finishReason;
        rawFinishReason = result.rawFinishReason;
        failedBudget = budget;
        failedUsage = result.usage;
      }
    }),
  );

  if (finishReason === "stop" && total > 1) {
    for (let index = 0; index + 1 < total; index++) {
      const previousTail = lastBlock(bodies[index]);
      const nextHead = firstBlock(bodies[index + 1]);
      if (!previousTail || !nextHead) continue;

      const smoothing = await generateOnce(
        {
          model,
          retryDelays,
          session,
          limiter,
          priceAt,
          reasoning,
          endpoint,
          debug,
        },
        {
          system: SMOOTH_SYSTEM,
          prompt: smoothPrompt(previousTail, nextHead),
          maxOutputTokens: plannedBudget(nextHead, budgetCeiling),
          temperature: 0,
          onRetry,
        },
      );
      usages.push(smoothing.usage);
      elapsed += smoothing.elapsed;
      if (smoothing.cost === null) costKnown = false;
      else cost += smoothing.cost;
      if (price === null && smoothing.price) price = smoothing.price;
      if (smoothing.finishReason === "stop") {
        const rewritten = cleanBody(smoothing.text);
        if (rewritten) {
          bodies[index + 1] = replaceFirstBlock(bodies[index + 1], rewritten);
        }
      }
    }
  }

  const body = dedupeAdjacentHeadings(
    bodies
      .join("\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
  const emptyParts = bodies.flatMap((part, index) =>
    part ? [] : [index + 1],
  );

  return {
    body,
    usage: sumUsage(usages),
    finishReason,
    rawFinishReason,
    emptyParts,
    elapsed,
    chunks: total,
    cost: costKnown ? cost : null,
    price,
    maxTokens: failedBudget,
    failedUsage,
  };
}

async function forEachConcurrent(items, limit, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next++];
        await worker(item);
      }
    }),
  );
}

export async function runGenerateMarkdown({
  feed = [],
  model: modelId,
  endpoint,
  apiKey,
  session,
  sessionBase = session,
  concurrency = 6,
  ytdlpConcurrency = 2,
  retryDelays = "10,30,60",
  maxOutputTokens,
  chunkTargetTokens = DEFAULT_CHUNK_TARGET_TOKENS,
  reasoning = DEFAULT_REASONING,
  force = false,
  debugLlm = false,
  dir = DEFAULT_DIR,
} = {}) {
  const key = apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error("api key is not set (--api-key or OPENAI_API_KEY)");
  if (!modelId) throw new Error("model is not set (--model)");
  if (!endpoint) throw new Error("endpoint is not set (--endpoint)");

  const debug = debugLlm === true || /^(1|true|yes|on)$/i.test(`${debugLlm}`);
  const RETRY_DELAYS = parseRetryDelays(retryDelays);
  const llmConcurrency = Number(concurrency);
  const vttConcurrency = Number(ytdlpConcurrency);
  const limiter = createLimiter(llmConcurrency);

  const model = createModel({ modelId, endpoint, apiKey: key, session: sessionBase });

  await mkdir(dir, { recursive: true });

  const jobs = feed.flatMap((channel) =>
    (channel.videos ?? [])
      .filter((video) => video.generate_markdown)
      .flatMap((video) => {
        const authors = jobAuthors(video, channel);
        return videoJobs(video, dir, channel.folder_slug).map((job) => ({
          ...job,
          authors,
          publishedDate: video.date,
        }));
      }),
  );

  console.error(`${jobs.length} markdown(s) to generate with ${modelId}`);

  const stats = {
    generated: 0,
    already: 0,
    skipped: 0,
    errors: 0,
    detectionErrors: 0,
    failures: [],
    totalSeconds: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCost: 0,
    costKnown: true,
  };

  const rendererOptions = {
    logger: new ListrLogger({
      processOutput: new ProcessOutput(process.stderr, process.stderr),
    }),
    showErrorMessage: true,
    collapseErrors: false,
    collapseSkips: false,
    icon: {
      SKIPPED: "–",
      SKIPPED_WITH_COLLAPSE: "–",
      SKIPPED_WITHOUT_COLLAPSE: "–",
    },
    color: {
      SKIPPED: (message) => message,
      SKIPPED_WITH_COLLAPSE: (message) => message,
      SKIPPED_WITHOUT_COLLAPSE: (message) => message,
    },
  };

  const phaseOptions = { outputBar: 20, persistentOutput: true };

  const pending = [];
  for (const job of jobs) {
    if (!force && (await exists(`${job.base}.md`))) stats.already++;
    else pending.push(job);
  }

  const prices = pending.length > 0 ? await loadPricing({ endpoint }) : null;
  const modelOutputLimit = prices?.outputLimitAt(modelId) ?? null;
  const ceiling = isSet(maxOutputTokens)
    ? Number(maxOutputTokens)
    : isSet(modelOutputLimit)
      ? Number(modelOutputLimit)
      : DEFAULT_CEILING;
  const priceAt = prices ? (at) => prices.priceAt(modelId, at) : null;
  console.error(
    `output budget: up to ${ceiling} tokens per call, chunk target ${chunkTargetTokens} tokens`,
  );

  const downloadTask = {
    title: "Download transcripts",
    rendererOptions: phaseOptions,
    task: async (_ctx, task) => {
      const total = jobs.length;
      if (total === 0) {
        task.skip("no video");
        return;
      }

      const pendingSet = new Set(pending);
      let available = 0;
      const items = [];
      for (const job of jobs) {
        if (await exists(job.vtt)) {
          available++;
        } else if (pendingSet.has(job)) {
          items.push(job);
        }
      }
      task.title = `Download transcripts (${available}/${total})`;

      await forEachConcurrent(items, vttConcurrency, async (job) => {
        const name = relative(dir, `${job.base}.md`);
        try {
          if (await exists(job.marker)) {
            stats.skipped++;
            task.output = `skipped (no transcript)  ${name}`;
            return;
          }

          await mkdir(dirname(job.vtt), { recursive: true });
          const status = await downloadVtt(job.url, job.lang, job.vtt);
          if (status === "missing") {
            await writeMarker(job.marker, job.url);
            stats.skipped++;
            task.output = `skipped (no transcript)  ${name}`;
          } else if (status === "error") {
            stats.errors++;
            task.output = `error (download failed)  ${name}`;
          } else {
            available++;
            task.output = `downloaded  ${name}`;
          }
        } catch (error) {
          stats.errors++;
          task.output = `error (${error.message})  ${name}`;
        } finally {
          task.title = `Download transcripts (${available}/${total})`;
        }
      });
    },
  };

  const generateTask = {
    title: "Generate markdown",
    rendererOptions: phaseOptions,
    task: async (_ctx, task) => {
      const items = [];
      for (const job of pending) {
        if (await exists(job.vtt)) items.push(job);
      }
      if (items.length === 0) {
        task.skip("nothing to generate");
        return;
      }

      const already = stats.already > 0 ? `, ${stats.already} already` : "";
      task.title =
        `Generate markdown (${stats.already}/${jobs.length}${already})`;
      await forEachConcurrent(items, llmConcurrency, async (job) => {
        const md = `${job.base}.md`;
        const name = relative(dir, md);
        try {
          const transcript = vttToText(await readFile(job.vtt, "utf8"));
          const {
            body,
            usage,
            finishReason,
            rawFinishReason,
            emptyParts,
            elapsed,
            chunks,
            cost,
            price,
            maxTokens,
            failedUsage,
          } = await toMarkdown(
            {
              model,
              retryDelays: RETRY_DELAYS,
              maxOutputTokens,
              ceiling,
              chunkTargetTokens,
              session: videoSession(sessionBase, job),
              limiter,
              priceAt,
              reasoning,
              endpoint,
              debug,
            },
            job.title,
            transcript,
            (nextAttempt, totalAttempts, waitMs, error) => {
              task.output = `retrying in ${Math.round(waitMs / 1000)}s ` +
                `(attempt ${nextAttempt}/${totalAttempts}) ` +
                `${describeCause(error)}  ${name}`;
            },
            (part, totalParts) => {
              task.output = totalParts > 1
                ? `generating part ${part}/${totalParts}  ${name}`
                : `generating  ${name}`;
            },
          );

          stats.totalSeconds += elapsed;
          stats.totalInput += usage?.inputTokens ?? 0;
          stats.totalOutput += usage?.outputTokens ?? 0;
          if (cost === null) stats.costKnown = false;
          else stats.totalCost += cost;
          const metrics = metricsLine(modelId, usage, elapsed, cost);

          if (finishReason !== "stop") {
            const error = finishReason === "length"
              ? outputLimitError({
                  label: "markdown generation",
                  budget: maxTokens,
                  ceiling,
                  usage: failedUsage ?? usage,
                  finishReason,
                  rawFinishReason,
                })
              : new Error(
                  `markdown generation stopped with finishReason=${finishReason}`,
                );
            error.usage = failedUsage ?? usage;
            error.elapsed = elapsed;
            error.cost = cost;
            stats.errors++;
            stats.failures.push({ name, reason: error.message });
            task.output = finishReason === "length"
              ? `error (output limit reached; see failures)  ${name}`
              : `error (${error.message})  ${name}`;
            return;
          }

          if (emptyParts.length > 0) {
            const reason = emptyOutputReason({
              emptyParts,
              chunks,
              finishReason,
              rawFinishReason,
              usage,
            });
            stats.errors++;
            stats.failures.push({ name, reason });
            task.output = `error (${reason})  ${name}`;
            return;
          }

          if (looksLikeSummary(body)) {
            const markers = summaryMarkers(body);
            throw new Error(
              `summary-like output detected (${markers.join(", ")}); ` +
                "pass 1 must preserve the transcript",
            );
          }

          let likelyDialogue;
          if (typeof job.dialogue === "boolean") {
            likelyDialogue = job.dialogue;
          } else if (Array.isArray(job.speakers) && job.speakers.length > 0) {
            likelyDialogue = true;
          } else {
            try {
              const detection = await detectDialogue(
                {
                  model,
                  retryDelays: RETRY_DELAYS,
                  session: videoSession(sessionBase, job),
                  limiter,
                  priceAt,
                  reasoning,
                  endpoint,
                  debug,
                },
                {
                  title: job.title,
                  body,
                  onRetry: (nextAttempt, totalAttempts, waitMs, error) => {
                    task.output = `detecting dialogue, retrying in ` +
                      `${Math.round(waitMs / 1000)}s ` +
                      `(attempt ${nextAttempt}/${totalAttempts}) ` +
                      `${describeCause(error)}  ${name}`;
                  },
                },
              );
              likelyDialogue = detection.likelyDialogue;
              stats.totalSeconds += detection.elapsed;
              stats.totalInput += detection.usage?.inputTokens ?? 0;
              stats.totalOutput += detection.usage?.outputTokens ?? 0;
              if (detection.cost === null) stats.costKnown = false;
              else stats.totalCost += detection.cost;
            } catch (error) {
              stats.detectionErrors++;
              likelyDialogue = null;
              task.output = `dialogue detection failed (${error.message})  ${name}`;
            }
          }

          const front = frontmatter(job, {
            modelId,
            usage,
            elapsed,
            cost,
            finishReason,
            rawFinishReason,
            price,
            chunks,
            likelyDialogue,
          });
          await mkdir(dirname(md), { recursive: true });
          await writeFile(
            md,
            `${front}# ${job.title}\n\n${hardWrap(body)}\n`,
          );
          stats.generated++;
          const dialogueLabel = likelyDialogue === true
            ? "dialogue"
            : likelyDialogue === false
              ? "monologue"
              : "dialogue?";
          task.output = `generated  ${name}  ${dialogueLabel}  ${metrics}`;
        } catch (error) {
          stats.errors++;
          stats.failures.push({ name, reason: error.message });
          task.output = `error (${error.message})  ${name}`;
        } finally {
          const upToDate = stats.already + stats.generated;
          task.title = `Generate markdown (${upToDate}/${jobs.length}${already})`;
        }
      });
    },
  };

  await new Listr([downloadTask, generateTask], {
    exitOnError: false,
    rendererOptions,
    fallbackRenderer: "simple",
    fallbackRendererOptions: rendererOptions,
  }).run();

  console.error(
    `summary: ${stats.generated} generated, ${stats.already} already generated, ${stats.skipped} skipped, ${stats.errors} error` +
      (stats.detectionErrors > 0
        ? `, ${stats.detectionErrors} dialogue detection error(s)`
        : ""),
  );
  const seconds = stats.totalSeconds.toFixed(1);
  console.error(
    `total: ${seconds}s, ${stats.totalInput} in / ${stats.totalOutput} out${
      stats.costKnown ? `, ~$${stats.totalCost.toFixed(6)}` : ""
    }`,
  );

  if (stats.failures.length > 0) {
    console.error("\nfailures:");
    for (const failure of stats.failures) {
      console.error(`  - ${failure.name}: ${failure.reason}`);
    }
  }

  if (stats.errors > 0) process.exitCode = 1;
}

export {
  budgetForPart,
  chunkPrompt,
  cleanBody,
  createLimiter,
  DEFAULT_REASONING,
  detectDialogue,
  estimateCost,
  forEachConcurrent,
  frontmatter,
  generateOnce,
  hardWrap,
  jobAuthors,
  metricsLine,
  normalizeSpeakerLabels,
  parseRetryDelays,
  plannedBudget,
  smoothPrompt,
  sumUsage,
};
