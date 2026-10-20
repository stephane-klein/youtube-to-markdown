import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { Listr, ListrLogger, ProcessOutput } from "listr2";
import {
  createLimiter,
  createModel,
  DEFAULT_REASONING,
  describeCause,
  forEachConcurrent,
  generateOnce,
  hardWrap,
  metricsLine,
  outputLimitError,
  parseRetryDelays,
  plannedBudget,
  sumUsage,
} from "./generate-markdown.js";
import {
  indexUnits,
  normalizeTurns,
  renderMarkdownUnits,
  splitMarkdownUnits,
} from "./markdown-units.js";
import { loadPricing } from "./pricing.js";
import {
  assertTextPreserved,
  cueHints,
  hasSpeakerLabels,
  parseVttCues,
  splitMarkdown,
} from "./vtt-cues.js";
import { DEFAULT_DIR, exists, videoJobs } from "./vtt.js";

const LABEL_OUTPUT_FACTOR = 3;

export const LABEL_JSON_SYSTEM = [
  "You annotate a frozen Markdown transcript with speaker turns.",
  "- Return only a JSON object: {\"turns\":[{\"start\":0,\"speaker\":\"...\"}]}.",
  "- `start` is the bracketed sentence index, not a line number.",
  "- The first turn must start at 0.",
  "- Every sentence belongs to the last declared turn. Do not create a turn for every sentence; only when the speaker changes.",
  "- Do not force strict alternation; consecutive turns by the same speaker are allowed.",
  "- A short question, backchannel or interruption is a separate turn when the cue hints show it.",
  "- A rhetorical question asked by the current speaker stays in that speaker's turn.",
  "- Use a proper name only when it is explicitly present in the title or the transcript. Never invent a name.",
  "- Otherwise use a stable role label in the transcript language.",
  "- If attribution is uncertain, keep the previous speaker.",
  "- Lines starting with # are headings; do not assign a speaker to them.",
  "- Do not add prose, comments or code fences.",
  "- Example: if sentence [0] is the interviewer and [1] is the guest, return {\"turns\":[{\"start\":0,\"speaker\":\"Journaliste\"},{\"start\":1,\"speaker\":\"Invité\"}]}.",
].join("\n");

export function speakerLabels(speakers) {
  if (!Array.isArray(speakers)) return [];
  return speakers
    .map((speaker) =>
      typeof speaker === "string" ? speaker : speaker?.label,
    )
    .map((label) => `${label ?? ""}`.trim())
    .filter(Boolean);
}

export function labelJsonPrompt(title, units, cueText, speakers = []) {
  const lines = [`Title: ${title}`, ""];

  const labels = speakerLabels(speakers);
  if (labels.length > 0) {
    lines.push(`Use these speaker labels exactly: ${labels.join(", ")}`, "");
  }

  lines.push("Numbered sentences:", "", indexUnits(units), "");

  if (`${cueText ?? ""}`.trim()) {
    lines.push(
      "Short cue hints (possible interjections):",
      "",
      `${cueText}`.trim(),
      "",
    );
  }

  lines.push("Return only the JSON object with the speaker turns.");
  return lines.join("\n");
}

export function parseLabelTurns(text, sentenceCount) {
  const raw = `${text ?? ""}`.trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  const json = first >= 0 && last > first
    ? cleaned.slice(first, last + 1)
    : cleaned;

  let data;
  try {
    data = JSON.parse(json);
  } catch (error) {
    throw new Error(`invalid JSON: ${error.message}`);
  }

  return normalizeTurns(data?.turns, sentenceCount);
}

function labelSession(base, job) {
  const id = createHash("sha256")
    .update(`${job.url}#${job.lang}#labels`)
    .digest("hex")
    .slice(0, 16);
  return `${base || "youtube-to-markdown"}-labels-${id}`;
}

export function shouldLabelSpeakers({
  dialogue,
  speakers,
  likelyDialogue,
  labelUncertain = false,
}) {
  if (dialogue === false) return false;
  if (dialogue === true) return true;
  if (speakerLabels(speakers).length > 0) return true;
  if (likelyDialogue === true) return true;
  if (labelUncertain && likelyDialogue !== false) return true;
  return false;
}

export async function labelMarkdownJson(
  ctx,
  { title, body, units, cueText, speakers, onRetry },
) {
  const prompt = labelJsonPrompt(title, units, cueText, speakers);
  const sentenceCount = units.filter((unit) => unit.kind === "sentence").length;
  const budget =
    ctx.maxOutputTokens !== undefined &&
    ctx.maxOutputTokens !== null &&
    ctx.maxOutputTokens !== ""
      ? Number(ctx.maxOutputTokens)
      : plannedBudget(body, ctx.ceiling ?? 32768, LABEL_OUTPUT_FACTOR);

  const generate = ctx.generate ?? generateOnce;
  const usages = [];
  let elapsed = 0;
  let cost = 0;
  let costKnown = true;
  let price = null;
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const result = await generate(ctx, {
      system: LABEL_JSON_SYSTEM,
      prompt:
        attempt === 1
          ? prompt
          : `${prompt}\n\nYour previous answer was invalid: ${lastError.message}. ` +
            "Return only valid JSON matching {\"turns\":[{\"start\":0,\"speaker\":\"...\"}]}.",
      maxOutputTokens: budget,
      temperature: 0,
      onRetry,
    });

    usages.push(result.usage);
    elapsed += result.elapsed;
    if (result.cost === null) costKnown = false;
    else cost += result.cost;
    if (price === null && result.price) price = result.price;

    if (result.finishReason !== "stop") {
      const error = result.finishReason === "length"
        ? outputLimitError({
            label: "speaker labelling",
            budget,
            ceiling: ctx.ceiling,
            usage: result.usage,
            finishReason: result.finishReason,
            rawFinishReason: result.rawFinishReason,
          })
        : new Error(
            `speaker labelling stopped with finishReason=${result.finishReason}`,
          );
      error.usage = sumUsage(usages);
      error.elapsed = elapsed;
      error.cost = costKnown ? cost : null;
      throw error;
    }

    try {
      const turns = parseLabelTurns(result.text, sentenceCount);
      return {
        turns,
        usage: sumUsage(usages),
        elapsed,
        cost: costKnown ? cost : null,
        price,
        finishReason: result.finishReason,
        rawFinishReason: result.rawFinishReason,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt === 2) {
        const textTokens =
          result.usage?.outputTokenDetails?.textTokens ?? "unknown";
        const reasoningTokens =
          result.usage?.outputTokenDetails?.reasoningTokens ?? 0;
        error.message =
          `${error.message} (output_tokens=${result.usage?.outputTokens ?? "unknown"}, ` +
          `reasoning_tokens=${reasoningTokens}, text_tokens=${textTokens}); ` +
          `output preview: ${JSON.stringify(`${result.text ?? ""}`.slice(0, 300))}`;
        error.usage = sumUsage(usages);
        error.elapsed = elapsed;
        error.cost = costKnown ? cost : null;
        throw error;
      }
    }
  }

  throw lastError;
}

function rendererOptions() {
  return {
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
}

function countByDialogue(job) {
  if (typeof job.dialogue === "boolean") return job.dialogue;
  if (speakerLabels(job.speakers).length > 0) return true;
  return undefined;
}

async function prepareJob(job) {
  const base = `${job.base}.md`;
  const labeled = job.labeled;
  if (!(await exists(base))) {
    return { job, base, labeled, skip: "no base markdown" };
  }
  if (!(await exists(job.vtt))) {
    return { job, base, labeled, skip: "no vtt" };
  }

  const source = await readFile(base, "utf8");
  const parts = splitMarkdown(source);
  if (!parts.body.trim()) {
    return { job, base, labeled, skip: "empty base markdown" };
  }
  if (hasSpeakerLabels(parts.body)) {
    return { job, base, labeled, skip: "base already labelled" };
  }

  const { units } = splitMarkdownUnits(parts.body);
  if (!units.some((unit) => unit.kind === "sentence")) {
    return { job, base, labeled, skip: "no sentence" };
  }

  return { job, base, labeled, ...parts, units };
}

export async function runLabelSpeakers({
  feed = [],
  model: modelId,
  endpoint,
  apiKey,
  session,
  sessionBase = session,
  concurrency = 6,
  retryDelays = "10,30,60",
  maxOutputTokens,
  reasoning = DEFAULT_REASONING,
  force = false,
  labelUncertain = false,
  debugLlm = false,
  dryRun = false,
  generate,
  dir = DEFAULT_DIR,
} = {}) {
  const injectedGenerate = typeof generate === "function" ? generate : null;
  let limitModel;
  if (!dryRun && !injectedGenerate) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("api key is not set (--api-key or OPENAI_API_KEY)");
    if (!modelId) throw new Error("model is not set (--model)");
    if (!endpoint) throw new Error("endpoint is not set (--endpoint)");
    limitModel = createModel({
      modelId,
      endpoint,
      apiKey: key,
      session: sessionBase,
    });
  }

  const debug = debugLlm === true || /^(1|true|yes|on)$/i.test(`${debugLlm}`);
  const RETRY_DELAYS = parseRetryDelays(retryDelays);
  const llmConcurrency = Number(concurrency);
  const limiter = createLimiter(llmConcurrency);

  const jobs = feed.flatMap((channel) =>
    (channel.videos ?? [])
      .filter((video) => video.generate_markdown)
      .flatMap((video) => videoJobs(video, dir, channel.folder_slug)),
  );

  const stats = {
    labeled: 0,
    wouldLabel: 0,
    already: 0,
    skipped: 0,
    errors: 0,
    failures: [],
    totalSeconds: 0,
    totalInput: 0,
    totalOutput: 0,
    totalCost: 0,
    costKnown: true,
  };

  const items = [];
  for (const job of jobs) {
    const prepared = await prepareJob(job);
    if (prepared.skip) {
      stats.skipped++;
      continue;
    }

    if (!force && (await exists(job.labeled))) {
      stats.already++;
      continue;
    }

    if (
      !shouldLabelSpeakers({
        dialogue: countByDialogue(job),
        speakers: job.speakers,
        likelyDialogue: prepared.data?.likely_dialogue,
        labelUncertain,
      })
    ) {
      stats.skipped++;
      continue;
    }

    items.push(prepared);
  }

  if (jobs.length > 0) {
    console.error(
      `${items.length} dialogue markdown(s) to label` +
        (modelId ? ` with ${modelId}` : ""),
    );
  }

  const prices =
    !dryRun && !injectedGenerate && items.length > 0
      ? await loadPricing({ endpoint })
      : null;
  const priceAt = prices ? (at) => prices.priceAt(modelId, at) : null;
  const ceiling =
    maxOutputTokens !== undefined &&
    maxOutputTokens !== null &&
    maxOutputTokens !== ""
      ? Number(maxOutputTokens)
      : prices?.outputLimitAt(modelId) ?? 32768;

  const task = {
    title: "Label speakers",
    rendererOptions: { outputBar: 20, persistentOutput: true },
    task: async (_ctx, task) => {
      if (items.length === 0) {
        task.skip("nothing to label");
        return;
      }

      const total = items.length + stats.already;
      const already = stats.already > 0 ? `, ${stats.already} already` : "";
      task.title = `Label speakers (${stats.already}/${total}${already})`;

      await forEachConcurrent(items, llmConcurrency, async (item) => {
        const { job, labeled, front, title, body, units } = item;
        const name = relative(dir, labeled);

        if (dryRun) {
          stats.wouldLabel++;
          task.output = `would label  ${name}`;
          return;
        }

        try {
          const cueText = cueHints(
            parseVttCues(await readFile(job.vtt, "utf8")),
          );
          const result = await labelMarkdownJson(
            {
              model: limitModel,
              generate: injectedGenerate,
              retryDelays: RETRY_DELAYS,
              session: labelSession(sessionBase, job),
              limiter,
              priceAt,
              reasoning,
              endpoint,
              debug,
              maxOutputTokens,
              ceiling,
            },
            {
              title: job.title,
              body,
              units,
              cueText,
              speakers: job.speakers,
              onRetry: (nextAttempt, totalAttempts, waitMs, error) => {
                task.output = `retrying in ${Math.round(waitMs / 1000)}s ` +
                  `(attempt ${nextAttempt}/${totalAttempts}) ` +
                  `${describeCause(error)}  ${name}`;
              },
            },
          );

          stats.totalSeconds += result.elapsed;
          stats.totalInput += result.usage?.inputTokens ?? 0;
          stats.totalOutput += result.usage?.outputTokens ?? 0;
          if (result.cost === null) stats.costKnown = false;
          else stats.totalCost += result.cost;

          const rendered = hardWrap(renderMarkdownUnits(units, result.turns));
          assertTextPreserved(body, rendered);

          const prefix = `${front}${title}`;
          const separator = prefix.endsWith("\n\n") ? "" : "\n";
          const content = `${prefix}${separator}${rendered}\n`;
          await mkdir(dirname(labeled), { recursive: true });
          await writeFile(labeled, content);
          stats.labeled++;
          task.output = `labelled  ${name}  ${
            metricsLine(modelId, result.usage, result.elapsed, result.cost)
          }`;
        } catch (error) {
          stats.errors++;
          if (error.usage) {
            stats.totalSeconds += error.elapsed ?? 0;
            stats.totalInput += error.usage?.inputTokens ?? 0;
            stats.totalOutput += error.usage?.outputTokens ?? 0;
            if (error.cost === null) stats.costKnown = false;
            else stats.totalCost += error.cost ?? 0;
          }
          stats.failures.push({ name, reason: error.message });
          task.output = error.code === "OUTPUT_LIMIT"
            ? `error (output limit reached; see failures)  ${name}`
            : `error (${error.message})  ${name}`;
        } finally {
          const done = stats.already + stats.labeled;
          task.title = `Label speakers (${done}/${items.length + stats.already}${already})`;
        }
      });
    },
  };

  const options = rendererOptions();
  await new Listr([task], {
    exitOnError: false,
    rendererOptions: options,
    fallbackRenderer: "simple",
    fallbackRendererOptions: options,
  }).run();

  console.error(
    `summary: ${
      dryRun ? `${stats.wouldLabel} would be labelled` : `${stats.labeled} labelled`
    }, ${stats.already} already labelled, ${stats.skipped} skipped, ${stats.errors} error`,
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
