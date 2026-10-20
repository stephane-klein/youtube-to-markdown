import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import {
  budgetForPart,
  chunkPrompt,
  cleanBody,
  createLimiter,
  DEFAULT_REASONING,
  detectPrompt,
  detectionSample,
  describeCause,
  describeError,
  emptyOutputReason,
  estimateCost,
  frontmatter,
  looksLikeSummary,
  metricsLine,
  normalizeSpeakerLabels,
  outputLimitError,
  parseDetection,
  plannedBudget,
  reasoningOptions,
  smoothPrompt,
  sumUsage,
  summaryMarkers,
} from "../src/generate-markdown.js";

const usage = (input, output, cached = 0, reasoning = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  inputTokenDetails: { noCacheTokens: input - cached, cacheReadTokens: cached },
  outputTokenDetails: { textTokens: output - reasoning, reasoningTokens: reasoning },
});

test("plannedBudget doubles the input estimate within the ceiling", () => {
  assert.equal(plannedBudget("", 384000), 2048);
  assert.equal(plannedBudget("x".repeat(35000), 384000), 20000);
  assert.equal(plannedBudget("x".repeat(35000), 10000), 10000);
});

test("plannedBudget accepts a larger factor for speaker labelling", () => {
  assert.equal(plannedBudget("x".repeat(35000), 384000, 3), 30000);
  assert.equal(plannedBudget("x".repeat(35000), 10000, 3), 10000);
});

test("budgetForPart prefers an explicit max_output_tokens override", () => {
  const text = "x".repeat(35000);
  assert.equal(budgetForPart(text, { maxOutputTokens: "4000", ceiling: 384000 }), 4000);
  assert.equal(budgetForPart(text, { ceiling: 384000 }), 20000);
  assert.equal(budgetForPart(text, { maxOutputTokens: "", ceiling: 5000 }), 5000);
});

test("chunkPrompt includes the fidelity reminder in the single-part prompt", () => {
  assert.equal(
    chunkPrompt("Title", "body", 0, 1),
    "Title: Title\n\n" +
      "Keep the speaker's spoken words and word order: do not correct the grammar.\n\n" +
      "Transcript:\nbody",
  );
});

test("chunkPrompt includes the fidelity reminder in multi-part prompts", () => {
  assert.match(
    chunkPrompt("Title", "body", 1, 3),
    /do not correct the grammar/,
  );
});

test("chunkPrompt marks multi-part transcripts", () => {
  const prompt = chunkPrompt("Title", "body", 1, 3);
  assert.match(prompt, /part 2 of 3/);
  assert.match(prompt, /part 2\/3/);
});

test("smoothPrompt exposes both sides of the junction", () => {
  const prompt = smoothPrompt("previous", "next");
  assert.match(prompt, /previous/);
  assert.match(prompt, /next/);
});

test("detectionSample keeps the beginning and the end of a long text", () => {
  const body = `${"a".repeat(9000)}${"b".repeat(3000)}`;
  const sample = detectionSample(body);
  assert.match(sample, /^a{8000}/);
  assert.match(sample, /b{2000}$/);
  assert.match(sample, /\[\.\.\.\]/);
});

test("detectionSample keeps a short text unchanged", () => {
  assert.equal(detectionSample("short transcript"), "short transcript");
});

test("detectPrompt includes the title and the sample", () => {
  const prompt = detectPrompt("Title", "Body");
  assert.match(prompt, /Title: Title/);
  assert.match(prompt, /Body/);
});

test("parseDetection reads a JSON answer", () => {
  assert.deepEqual(
    parseDetection(
      JSON.stringify({
        likely_dialogue: true,
        confidence: "high",
        speakers: [
          { label: "Journaliste", type: "role" },
          { label: "Jean-Luc Mélenchon", type: "name" },
        ],
      }),
    ),
    {
      likelyDialogue: true,
      confidence: "high",
      speakers: [
        { label: "Journaliste", type: "role" },
        { label: "Jean-Luc Mélenchon", type: "name" },
      ],
    },
  );
});

test("parseDetection accepts code fences and string speakers", () => {
  const result = parseDetection(
    "```json\n{\"likely_dialogue\": false, \"speakers\": [\"Narrateur\"]}\n```",
  );
  assert.equal(result.likelyDialogue, false);
  assert.deepEqual(result.speakers, [{ label: "Narrateur", type: "role" }]);
});

test("parseDetection falls back to unknown on invalid JSON", () => {
  assert.deepEqual(parseDetection("not json"), {
    likelyDialogue: null,
    confidence: "low",
    speakers: [],
  });
});

test("normalizeSpeakerLabels merges a standalone label with the next block", () => {
  assert.equal(
    normalizeSpeakerLabels("**Journaliste :**\n\nBonjour."),
    "**Journaliste :** Bonjour.",
  );
});

test("normalizeSpeakerLabels keeps distinct speaker turns", () => {
  const body =
    "**Journaliste :** Bonjour.\n\n**Jean-Luc Mélenchon :** Bonsoir.";
  assert.equal(normalizeSpeakerLabels(body), body);
});

test("normalizeSpeakerLabels leaves a bold non-label block untouched", () => {
  assert.equal(
    normalizeSpeakerLabels("**Important.**\n\nTexte."),
    "**Important.**\n\nTexte.",
  );
});

test("normalizeSpeakerLabels does not merge a label with a heading", () => {
  assert.equal(
    normalizeSpeakerLabels("**Journaliste :**\n\n## Suite"),
    "**Journaliste :**\n\n## Suite",
  );
});

test("sumUsage sums every usage field", () => {
  const total = sumUsage([usage(100, 50, 20, 10), usage(10, 5, 0, 2)]);
  assert.equal(total.inputTokens, 110);
  assert.equal(total.outputTokens, 55);
  assert.equal(total.totalTokens, 165);
  assert.equal(total.inputTokenDetails.cacheReadTokens, 20);
  assert.equal(total.outputTokenDetails.reasoningTokens, 12);
});

test("sumUsage returns null without any usage", () => {
  assert.equal(sumUsage([]), null);
  assert.equal(sumUsage([undefined]), null);
});

test("estimateCost applies the rate sampled for the call", () => {
  const u = usage(1000000, 1000000);
  assert.equal(
    estimateCost({ input: 0.3, output: 1.2, cachedInput: 0 }, u),
    1.5,
  );
  assert.equal(
    estimateCost({ input: 0.15, output: 0.6, cachedInput: 0 }, u),
    0.75,
  );
});

test("estimateCost charges cached input tokens at the cached rate", () => {
  const u = usage(1000000, 0, 1000000);
  assert.equal(
    estimateCost({ input: 0.3, output: 1.2, cachedInput: 0.03 }, u),
    0.03,
  );
});

test("estimateCost returns null without a price or usage", () => {
  assert.equal(estimateCost(null, usage(1, 1)), null);
  assert.equal(estimateCost({ input: 1, output: 1 }, null), null);
});

test("cleanBody strips code fences", () => {
  assert.equal(cleanBody("```markdown\nhello\n```"), "hello");
  assert.equal(cleanBody("hello"), "hello");
});

test("createLimiter caps the number of concurrent tasks", async () => {
  const limiter = createLimiter(2);
  let active = 0;
  let peak = 0;
  const task = () =>
    new Promise((resolve) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        resolve("done");
      }, 5);
    });

  const results = await Promise.all(
    Array.from({ length: 6 }, () => limiter(task)),
  );
  assert.deepEqual(results, Array(6).fill("done"));
  assert.equal(peak, 2);
});

test("DEFAULT_REASONING stays low when the setting is absent", () => {
  assert.equal(DEFAULT_REASONING, "low");
});

test("reasoningOptions passes the effort to the provider", () => {
  assert.deepEqual(reasoningOptions("low", "https://api.deepseek.com"), {
    reasoning: "low",
  });
  assert.deepEqual(reasoningOptions("provider-default"), {
    reasoning: "provider-default",
  });
});

test("reasoningOptions leaves the provider default untouched when unset", () => {
  assert.deepEqual(reasoningOptions(undefined), {});
  assert.deepEqual(reasoningOptions(""), {});
});

test("reasoningOptions disables thinking for DeepSeek when none", () => {
  assert.deepEqual(reasoningOptions("none", "https://api.deepseek.com"), {
    providerOptions: {
      opencode: { thinking: { type: "disabled" } },
    },
  });
  assert.deepEqual(reasoningOptions("none", "https://example.com"), {
    reasoning: "none",
  });
});

test("metricsLine reports reasoning tokens when present", () => {
  const line = metricsLine("model", usage(100, 50, 0, 10), 1.25, 0.001);
  assert.match(line, /10 reasoning/);
  assert.match(line, /llm 1\.3s/);
});

const apiError = ({ status, body, message = "request failed" }) =>
  new APICallError({
    message,
    url: "https://api.example.com/chat/completions",
    requestBodyValues: {},
    statusCode: status,
    responseBody: body,
  });

test("describeCause formats a plain error", () => {
  assert.equal(describeCause(new Error("boom")), "boom");
});

test("describeCause reports the status and a compact body", () => {
  const error = apiError({
    status: 429,
    body: "  too   many\nrequests ",
    message: "rate limited",
  });
  assert.equal(describeCause(error), "HTTP 429 rate limited: too many requests");
});

test("describeCause truncates a long response body", () => {
  const error = apiError({ status: 500, body: "x".repeat(300) });
  assert.equal(describeCause(error).endsWith("x".repeat(200)), true);
  assert.equal(describeCause(error).includes("x".repeat(201)), false);
});

test("describeError appends the attempt count", () => {
  const error = apiError({ status: 503, body: "", message: "unavailable" });
  assert.equal(
    describeError(error, 4),
    "HTTP 503 unavailable after 4 attempt(s)",
  );
});

test("emptyOutputReason reports the part and the token breakdown", () => {
  const reason = emptyOutputReason({
    emptyParts: [1],
    chunks: 1,
    finishReason: "stop",
    rawFinishReason: "stop",
    usage: usage(14236, 4002, 14208, 4001),
  });
  assert.match(reason, /part 1\/1/);
  assert.match(reason, /finish=stop/);
  assert.match(reason, /text_tokens=1/);
  assert.match(reason, /reasoning_tokens=4001/);
  assert.equal(reason.includes("/stop"), false);
});

test("emptyOutputReason shows a differing raw finish reason", () => {
  const reason = emptyOutputReason({
    emptyParts: [2, 3],
    chunks: 4,
    finishReason: "length",
    rawFinishReason: "max_tokens",
    usage: usage(100, 10, 0, 9),
  });
  assert.match(reason, /part 2,3\/4/);
  assert.match(reason, /finish=length\/max_tokens/);
});

test("frontmatter records likely_dialogue", () => {
  const output = frontmatter(
    { url: "https://example.com/video", titles: { fr: "Title" }, lang: "fr" },
    {
      modelId: "mimo-v2.5",
      usage: usage(10, 5),
      elapsed: 1.2,
      cost: 0.001,
      finishReason: "stop",
      rawFinishReason: "stop",
      price: null,
      chunks: 1,
      likelyDialogue: true,
    },
  );
  assert.match(output, /likely_dialogue: true/);
  assert.match(output, /^---\n/);
  assert.match(output, /\n---\n\n$/);
});

test("frontmatter writes null when dialogue detection is unknown", () => {
  const output = frontmatter(
    { url: "https://example.com/video", titles: { fr: "Title" }, lang: "fr" },
    {
      modelId: "mimo-v2.5",
      usage: usage(10, 5),
      elapsed: 1.2,
      cost: 0.001,
      finishReason: "stop",
      rawFinishReason: "stop",
      price: null,
      chunks: 1,
      likelyDialogue: null,
    },
  );
  assert.match(output, /likely_dialogue: null/);
});

test("looksLikeSummary detects third-person reported speech", () => {
  const body = [
    "L’entretien s’ouvre sur le constat que la France a montré deux visages.",
    "La journaliste propose de revenir sur cette journée.",
    "Jean-Luc Mélenchon répond qu’il est sous le choc des images.",
    "Il souligne que les personnages sont les mêmes.",
  ].join(" ");
  assert.equal(looksLikeSummary(body), true);
  assert.deepEqual(summaryMarkers(body), [
    "interview opening",
    "journalist narration",
    "reported answer",
  ]);
});

test("looksLikeSummary accepts a faithful first-person transcript", () => {
  const body =
    "Bonsoir, Jean-Luc Mélenchon. Bonsoir. Hier, la France a montré deux visages. " +
    "D'un côté, des centaines de milliers de personnes mobilisées pacifiquement.";
  assert.equal(looksLikeSummary(body), false);
  assert.deepEqual(summaryMarkers(body), []);
});

test("looksLikeSummary needs a strong marker and three markers", () => {
  assert.equal(
    looksLikeSummary("Il répond que oui. Il souligne que non."),
    false,
  );
});

test("outputLimitError explains the output limit and suggests a budget", () => {
  const error = outputLimitError({
    label: "markdown generation",
    budget: 26062,
    ceiling: 393216,
    usage: usage(100, 26062, 0, 9369),
    finishReason: "length",
    rawFinishReason: "max_tokens",
  });
  assert.equal(error.code, "OUTPUT_LIMIT");
  assert.match(error.message, /markdown generation reached the output limit/);
  assert.match(error.message, /finishReason=length\/max_tokens/);
  assert.match(error.message, /max_tokens=26062/);
  assert.match(error.message, /output_tokens=26062/);
  assert.match(error.message, /reasoning_tokens=9369/);
  assert.match(error.message, /text_tokens=16693/);
  assert.match(error.message, /try 52124/);
});

test("outputLimitError points to the model maximum when the budget cannot grow", () => {
  const error = outputLimitError({
    budget: 1000,
    ceiling: 1000,
    usage: usage(10, 1000),
    finishReason: "length",
  });
  assert.match(error.message, /the model maximum/);
  assert.match(error.message, /lower the reasoning effort or split the input/);
});

test("outputLimitError explains a budget spent entirely on reasoning", () => {
  const error = outputLimitError({
    label: "speaker labelling",
    budget: 39207,
    ceiling: 393216,
    usage: usage(100, 39207, 0, 39207),
    finishReason: "length",
  });
  assert.match(error.message, /wrote no text/);
  assert.match(error.message, /non-reasoning model/);
});
