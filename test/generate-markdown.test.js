import assert from "node:assert/strict";
import test from "node:test";
import { APICallError } from "ai";
import {
  budgetForPart,
  chunkPrompt,
  cleanBody,
  createLimiter,
  DEFAULT_REASONING,
  describeCause,
  describeError,
  estimateCost,
  metricsLine,
  plannedBudget,
  reasoningOptions,
  smoothPrompt,
  sumUsage,
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

test("budgetForPart prefers an explicit max_output_tokens override", () => {
  const text = "x".repeat(35000);
  assert.equal(budgetForPart(text, { maxOutputTokens: "4000", ceiling: 384000 }), 4000);
  assert.equal(budgetForPart(text, { ceiling: 384000 }), 20000);
  assert.equal(budgetForPart(text, { maxOutputTokens: "", ceiling: 5000 }), 5000);
});

test("chunkPrompt keeps the single-part prompt unchanged", () => {
  assert.equal(
    chunkPrompt("Title", "body", 0, 1),
    "Title: Title\n\nTranscript:\nbody",
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
