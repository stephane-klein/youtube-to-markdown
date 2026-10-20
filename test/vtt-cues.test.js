import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTextPreserved,
  countSpeakerLabels,
  cueHints,
  cueTranscript,
  hasSpeakerLabels,
  normalizeForComparison,
  parseVttCues,
  splitMarkdown,
  stripSpeakerLabels,
  vttToText,
} from "../src/vtt-cues.js";

const VTT = `WEBVTT
Kind: captions
Language: fr

00:00:00.000 --> 00:00:01.500 align:start position:0%

Bonsoir,<00:00:00.400><c> Jean-Luc</c><00:00:00.680><c> Mélenchon.</c>

00:00:01.500 --> 00:00:01.560 align:start position:0%
Bonsoir, Jean-Luc Mélenchon.


00:00:01.560 --> 00:00:02.150 align:start position:0%
Bonsoir, Jean-Luc Mélenchon.
Bonsoir.

00:00:02.160 --> 00:00:04.550 align:start position:0%
Bonsoir.
Hier, la France a montré deux visages.
`;

test("parseVttCues extracts timestamps and text lines", () => {
  const cues = parseVttCues(VTT);
  assert.equal(cues.length, 4);
  assert.equal(cues[0].start, 0);
  assert.equal(cues[0].end, 1.5);
  assert.equal(cues[0].text, "Bonsoir, Jean-Luc Mélenchon.");
  assert.deepEqual(cues[0].lines, ["Bonsoir, Jean-Luc Mélenchon."]);
});

test("cueTranscript deduplicates rolling lines and adds timestamps", () => {
  const transcript = cueTranscript(parseVttCues(VTT));
  assert.equal(
    transcript,
    [
      "[00:00:00] Bonsoir, Jean-Luc Mélenchon.",
      "Bonsoir.",
      "Hier, la France a montré deux visages.",
    ].join("\n"),
  );
});

test("vttToText keeps unique cue lines", () => {
  assert.equal(
    vttToText(VTT),
    [
      "Bonsoir, Jean-Luc Mélenchon.",
      "Bonsoir.",
      "Hier, la France a montré deux visages.",
    ].join("\n"),
  );
});

test("splitMarkdown separates frontmatter, title and body", () => {
  const source = [
    "---",
    "likely_dialogue: true",
    "---",
    "",
    "# Title",
    "",
    "Body.",
    "",
  ].join("\n");
  const parts = splitMarkdown(source);
  assert.equal(parts.data.likely_dialogue, true);
  assert.equal(parts.title, "\n# Title\n");
  assert.equal(parts.body, "\nBody.\n");
  assert.equal(
    `${parts.front}${parts.title}${parts.body}`,
    source,
  );
});

test("stripSpeakerLabels only removes speaker labels", () => {
  assert.equal(
    stripSpeakerLabels("**Journaliste :** Bonjour.\n\n**Guest :** Salut."),
    "Bonjour.\n\nSalut.",
  );
  assert.equal(
    stripSpeakerLabels("**Important.**\n\nTexte."),
    "**Important.**\n\nTexte.",
  );
});

test("assertTextPreserved accepts labels and blank lines", () => {
  assert.equal(
    assertTextPreserved(
      "Bonjour. Salut.",
      "**Journaliste :** Bonjour.\n\n**Guest :** Salut.",
    ),
    true,
  );
});

test("assertTextPreserved ignores emphasis formatting", () => {
  assert.equal(
    assertTextPreserved(
      "**Bonsoir, Jean-Luc Mélenchon.** Bonsoir.",
      "**Journaliste :** Bonsoir, Jean-Luc Mélenchon.\n\n**Jean-Luc Mélenchon :** Bonsoir.",
    ),
    true,
  );
});

test("assertTextPreserved rejects text changes", () => {
  assert.throws(
    () => assertTextPreserved("Bonjour.", "**Journaliste :** Salut."),
    /changed the text/,
  );
  assert.throws(
    () => assertTextPreserved("Bonjour.", "Bonjour. Ajout."),
    /changed the text/,
  );
});

test("normalizeForComparison collapses whitespace", () => {
  assert.equal(normalizeForComparison(" a\n\n b "), "a b");
});

test("countSpeakerLabels and hasSpeakerLabels detect speaker turns", () => {
  const body =
    "**Journaliste :** Bonjour.\n\n**Jean-Luc Mélenchon :** Bonsoir.";
  assert.equal(countSpeakerLabels(body), 2);
  assert.equal(hasSpeakerLabels(body), true);
  assert.equal(hasSpeakerLabels("**Important.** Texte."), false);
});

test("cueHints keeps only short cue lines", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:00.000 --> 00:00:01.000",
    "Bonjour.",
    "",
    "00:00:02.000 --> 00:00:03.000",
    "Ceci est une phrase beaucoup trop longue pour un indice court.",
    "",
    "00:00:04.000 --> 00:00:05.000",
    "Bonsoir.",
    "",
  ].join("\n");
  const hints = cueHints(parseVttCues(vtt), { maxLineChars: 20 });
  assert.match(hints, /^\[00:00:00\] Bonjour\./);
  assert.match(hints, /Bonsoir\./);
  assert.doesNotMatch(hints, /beaucoup trop longue/);
});
