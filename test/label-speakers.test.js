import assert from "node:assert/strict";
import test from "node:test";
import {
  LABEL_JSON_SYSTEM,
  labelJsonPrompt,
  labelMarkdownJson,
  parseLabelTurns,
  runLabelSpeakers,
  shouldLabelSpeakers,
  speakerLabels,
} from "../src/label-speakers.js";
import { splitMarkdownUnits } from "../src/markdown-units.js";

const usage = (input, output, reasoning = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  inputTokenDetails: { noCacheTokens: input, cacheReadTokens: 0 },
  outputTokenDetails: {
    textTokens: Math.max(output - reasoning, 0),
    reasoningTokens: reasoning,
  },
});

const reply = (text, input = 10, output = 5, reasoning = 0) => ({
  text,
  usage: usage(input, output, reasoning),
  finishReason: "stop",
  rawFinishReason: "stop",
  elapsed: 1,
  price: null,
  cost: 0.001,
});

const unitsFor = (body) => splitMarkdownUnits(body).units;

test("speakerLabels accepts strings and objects", () => {
  assert.deepEqual(
    speakerLabels([
      "Journaliste",
      { label: "Jean-Luc Mélenchon", type: "name" },
      null,
    ]),
    ["Journaliste", "Jean-Luc Mélenchon"],
  );
  assert.deepEqual(speakerLabels(undefined), []);
});

test("LABEL_JSON_SYSTEM describes the JSON contract", () => {
  assert.match(LABEL_JSON_SYSTEM, /Return only a JSON object/);
  assert.match(LABEL_JSON_SYSTEM, /bracketed sentence index/);
  assert.match(LABEL_JSON_SYSTEM, /not a line number/);
  assert.match(LABEL_JSON_SYSTEM, /Do not force strict alternation/);
});

test("labelJsonPrompt includes numbered sentences, cues and explicit labels", () => {
  const units = unitsFor("Bonjour.\n\nBonsoir.");
  const prompt = labelJsonPrompt(
    "Title",
    units,
    "[00:00:00] Bonjour.",
    ["Journaliste", { label: "Jean-Luc Mélenchon" }],
  );
  assert.match(prompt, /Title: Title/);
  assert.match(prompt, /Use these speaker labels exactly: Journaliste, Jean-Luc Mélenchon/);
  assert.match(prompt, /\[0\] Bonjour\./);
  assert.match(prompt, /\[1\] Bonsoir\./);
  assert.match(prompt, /Short cue hints/);
  assert.match(prompt, /Bonjour\./);
});

test("parseLabelTurns accepts valid JSON", () => {
  const turns = parseLabelTurns(
    JSON.stringify({
      turns: [
        { start: 0, speaker: "Journaliste" },
        { start: 1, speaker: "Jean-Luc Mélenchon" },
      ],
    }),
    2,
  );
  assert.deepEqual(turns, [
    { start: 0, speaker: "Journaliste" },
    { start: 1, speaker: "Jean-Luc Mélenchon" },
  ]);
});

test("parseLabelTurns accepts fenced JSON", () => {
  const turns = parseLabelTurns(
    "```json\n{\"turns\":[{\"start\":0,\"speaker\":\"A\"},{\"start\":1,\"speaker\":\"B\"}]}\n```",
    2,
  );
  assert.deepEqual(turns, [
    { start: 0, speaker: "A" },
    { start: 1, speaker: "B" },
  ]);
});

test("parseLabelTurns rejects invalid JSON", () => {
  assert.throws(() => parseLabelTurns("not json", 2), /invalid JSON/);
});

test("parseLabelTurns rejects a single speaker", () => {
  assert.throws(
    () =>
      parseLabelTurns(
        JSON.stringify({ turns: [{ start: 0, speaker: "A" }] }),
        2,
      ),
    /single speaker/,
  );
});

test("parseLabelTurns rejects invalid starts", () => {
  assert.throws(
    () =>
      parseLabelTurns(
        JSON.stringify({
          turns: [
            { start: 1, speaker: "A" },
            { start: 2, speaker: "B" },
          ],
        }),
        2,
      ),
    /first turn must start at 0/,
  );
  assert.throws(
    () =>
      parseLabelTurns(
        JSON.stringify({
          turns: [
            { start: 0, speaker: "A" },
            { start: 0, speaker: "B" },
          ],
        }),
        2,
      ),
    /strictly increasing/,
  );
});

test("shouldLabelSpeakers prioritizes explicit feed settings", () => {
  assert.equal(
    shouldLabelSpeakers({
      dialogue: false,
      speakers: ["Journaliste"],
      likelyDialogue: true,
    }),
    false,
  );
  assert.equal(
    shouldLabelSpeakers({ dialogue: true, likelyDialogue: false }),
    true,
  );
  assert.equal(
    shouldLabelSpeakers({
      dialogue: undefined,
      speakers: ["Journaliste"],
      likelyDialogue: false,
    }),
    true,
  );
});

test("shouldLabelSpeakers follows detection when the feed is silent", () => {
  assert.equal(
    shouldLabelSpeakers({
      dialogue: undefined,
      speakers: [],
      likelyDialogue: true,
    }),
    true,
  );
  assert.equal(
    shouldLabelSpeakers({
      dialogue: undefined,
      speakers: [],
      likelyDialogue: false,
    }),
    false,
  );
  assert.equal(
    shouldLabelSpeakers({
      dialogue: undefined,
      speakers: [],
      likelyDialogue: null,
    }),
    false,
  );
  assert.equal(
    shouldLabelSpeakers({
      dialogue: undefined,
      speakers: [],
      likelyDialogue: null,
      labelUncertain: true,
    }),
    true,
  );
});

test("labelMarkdownJson returns parsed turns", async () => {
  const generate = async () =>
    reply(
      JSON.stringify({
        turns: [
          { start: 0, speaker: "Journaliste" },
          { start: 1, speaker: "Jean-Luc Mélenchon" },
        ],
      }),
    );
  const result = await labelMarkdownJson(
    { generate, maxOutputTokens: 1024, ceiling: 8192 },
    {
      title: "Title",
      body: "Bonjour.\n\nBonsoir.",
      units: unitsFor("Bonjour.\n\nBonsoir."),
      cueText: "Bonjour.\nBonsoir.",
    },
  );
  assert.equal(result.attempts, 1);
  assert.equal(result.turns.length, 2);
});

test("labelMarkdownJson retries invalid JSON", async () => {
  let calls = 0;
  const generate = async () => {
    calls++;
    return calls === 1
      ? reply("not json")
      : reply(
          JSON.stringify({
            turns: [
              { start: 0, speaker: "Journaliste" },
              { start: 1, speaker: "Jean-Luc Mélenchon" },
            ],
          }),
        );
  };
  const result = await labelMarkdownJson(
    { generate, maxOutputTokens: 1024, ceiling: 8192 },
    {
      title: "Title",
      body: "Bonjour.\n\nBonsoir.",
      units: unitsFor("Bonjour.\n\nBonsoir."),
      cueText: "Bonjour.\nBonsoir.",
    },
  );
  assert.equal(result.attempts, 2);
  assert.equal(result.usage.inputTokens, 20);
});

test("labelMarkdownJson fails explicitly on the output limit", async () => {
  let calls = 0;
  const generate = async () => {
    calls++;
    return {
      ...reply("", 10, 26062, 26062),
      finishReason: "length",
      rawFinishReason: "max_tokens",
    };
  };
  await assert.rejects(
    () =>
      labelMarkdownJson(
        { generate, maxOutputTokens: 26062, ceiling: 393216 },
        {
          title: "Title",
          body: "Bonjour.",
          units: unitsFor("Bonjour."),
          cueText: "Bonjour.",
        },
      ),
    (error) => {
      assert.equal(error.code, "OUTPUT_LIMIT");
      assert.match(error.message, /speaker labelling reached the output limit/);
      assert.match(error.message, /wrote no text/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("labelMarkdownJson reports a preview after two invalid answers", async () => {
  let calls = 0;
  const generate = async () => {
    calls++;
    return reply("not json at all");
  };
  await assert.rejects(
    () =>
      labelMarkdownJson(
        { generate, maxOutputTokens: 1024, ceiling: 8192 },
        {
          title: "Title",
          body: "Bonjour.\n\nBonsoir.",
          units: unitsFor("Bonjour.\n\nBonsoir."),
          cueText: "Bonjour.\nBonsoir.",
        },
      ),
    (error) => {
      assert.match(error.message, /invalid JSON/);
      assert.match(error.message, /output preview/);
      assert.match(error.message, /output_tokens=5/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("runLabelSpeakers writes the labelled derivative and preserves the base", async () => {
  const { mkdtemp, readFile, rm, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = await mkdtemp(join(tmpdir(), "yt-to-md-label-"));
  const date = "2026-10-18";
  const slug = "17-octobre-macron-joue-le-pourrissement";
  const base = join(dir, `${date}_${slug}.fr.md`);
  const vtt = join(dir, `${date}_${slug}.fr.vtt`);
  const labeled = join(dir, `${date}_${slug}.fr.dialogue.md`);

  const source = [
    "---",
    "source_url: https://example.com/video",
    'video_title: "17 octobre : Macron joue le pourrissement"',
    "generated_at: 2026-10-20T10:00:00.000Z",
    "likely_dialogue: true",
    "---",
    "",
    "# 17 octobre : Macron joue le pourrissement",
    "",
    "Bonjour.",
    "",
    "Bonsoir.",
    "",
  ].join("\n");

  await writeFile(base, source);
  await writeFile(
    vtt,
    [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:01.000",
      "Bonjour.",
      "",
      "00:00:01.100 --> 00:00:02.000",
      "Bonsoir.",
      "",
    ].join("\n"),
  );

  const generate = async () =>
    reply(
      JSON.stringify({
        turns: [
          { start: 0, speaker: "Journaliste" },
          { start: 1, speaker: "Jean-Luc Mélenchon" },
        ],
      }),
    );

  try {
    await runLabelSpeakers({
      feed: [
        {
          videos: [
            {
              title: "17 octobre : Macron joue le pourrissement",
              date,
              url: "https://example.com/video",
              download_vtt: { fr: true },
              generate_markdown: { fr: true },
              dialogue: true,
            },
          ],
        },
      ],
      dir,
      generate,
      concurrency: 1,
    });

    assert.equal(await readFile(base, "utf8"), source);
    const output = await readFile(labeled, "utf8");
    assert.match(output, /# 17 octobre : Macron joue le pourrissement\n\n\*\*Journaliste :\*\* Bonjour\./);
    assert.match(output, /\*\*Jean-Luc Mélenchon :\*\* Bonsoir\./);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
