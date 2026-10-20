import assert from "node:assert/strict";
import test from "node:test";
import {
  indexUnits,
  normalizeTurns,
  renderMarkdownUnits,
  splitMarkdownUnits,
} from "../src/markdown-units.js";

test("splitMarkdownUnits unwraps lines and splits sentences", () => {
  const body = [
    "## Section",
    "",
    "Bonjour. Comment allez-vous ?",
    "",
    "Bonsoir. M. Dupont est là. Il parle.",
  ].join("\n");
  const { units, sentences } = splitMarkdownUnits(body);

  assert.equal(units[0].kind, "heading");
  assert.equal(units[0].index, null);
  assert.deepEqual(
    sentences.map((sentence) => sentence.text),
    [
      "Bonjour.",
      "Comment allez-vous ?",
      "Bonsoir.",
      "M. Dupont est là.",
      "Il parle.",
    ],
  );
});

test("splitMarkdownUnits joins hard-wrapped sentence lines", () => {
  const body = "Bonjour. La France a montré deux\nvisages. Bonsoir.";
  const { sentences } = splitMarkdownUnits(body);
  assert.deepEqual(
    sentences.map((sentence) => sentence.text),
    ["Bonjour.", "La France a montré deux visages.", "Bonsoir."],
  );
});

test("indexUnits numbers sentences and leaves headings unnumbered", () => {
  const { units } = splitMarkdownUnits("## Section\n\nBonjour.\n\nBonsoir.");
  assert.equal(
    indexUnits(units),
    ["## Section", "[0] Bonjour.", "[1] Bonsoir."].join("\n"),
  );
});

test("renderMarkdownUnits groups consecutive sentences by speaker", () => {
  const body = "Bonjour. Salut.\n\nBonsoir. Au revoir.";
  const { units } = splitMarkdownUnits(body);
  const rendered = renderMarkdownUnits(units, [
    { start: 0, speaker: "Journaliste" },
    { start: 2, speaker: "Jean-Luc Mélenchon" },
  ]);
  assert.equal(
    rendered,
    [
      "**Journaliste :** Bonjour. Salut.",
      "**Jean-Luc Mélenchon :** Bonsoir. Au revoir.",
    ].join("\n\n"),
  );
});

test("renderMarkdownUnits keeps headings and repeats the label after them", () => {
  const body = "## A\n\nBonjour.\n\n## B\n\nBonsoir.";
  const { units } = splitMarkdownUnits(body);
  const rendered = renderMarkdownUnits(units, [
    { start: 0, speaker: "Journaliste" },
    { start: 1, speaker: "Journaliste" },
  ]);
  assert.equal(
    rendered,
    [
      "## A",
      "",
      "**Journaliste :** Bonjour.",
      "",
      "## B",
      "",
      "**Journaliste :** Bonsoir.",
    ].join("\n"),
  );
});

test("normalizeTurns validates the turn list", () => {
  assert.throws(
    () => normalizeTurns([{ start: 1, speaker: "A" }], 2),
    /first turn must start at 0/,
  );
  assert.throws(
    () => normalizeTurns([{ start: 0, speaker: "A" }], 2),
    /single speaker/,
  );
  assert.throws(
    () =>
      normalizeTurns(
        [
          { start: 0, speaker: "A" },
          { start: 0, speaker: "B" },
        ],
        2,
      ),
    /strictly increasing/,
  );
  assert.throws(
    () =>
      normalizeTurns(
        [
          { start: 0, speaker: "A" },
          { start: 3, speaker: "B" },
        ],
        2,
      ),
    /invalid turn start/,
  );
});

test("splitMarkdownUnits splits on ellipsis before a lowercase interruption", () => {
  const { sentences } = splitMarkdownUnits(
    "Alors, bon, le plus urgent… c’est un peu compliqué, Jean-Luc ?",
  );
  assert.deepEqual(
    sentences.map((sentence) => sentence.text),
    ["Alors, bon, le plus urgent…", "c’est un peu compliqué, Jean-Luc ?"],
  );
});

test("splitMarkdownUnits keeps closing quotes with the sentence", () => {
  const { sentences } = splitMarkdownUnits(
    "Il dit : « Bonjour. » Puis il part.",
  );
  assert.deepEqual(
    sentences.map((sentence) => sentence.text),
    ["Il dit : « Bonjour. »", "Puis il part."],
  );
});

test("splitMarkdownUnits merges punctuation-only fragments", () => {
  const { units } = splitMarkdownUnits("Bonjour.\n\n?\n\nBonsoir.");
  assert.deepEqual(
    units.filter((unit) => unit.kind === "sentence").map((unit) => unit.text),
    ["Bonjour. ?", "Bonsoir."],
  );
});
