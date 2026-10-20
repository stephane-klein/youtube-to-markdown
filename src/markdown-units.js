const ABBREVIATIONS = new Set([
  "m",
  "mm",
  "mme",
  "mmes",
  "dr",
  "pr",
  "etc",
  "cf",
  "p",
  "pp",
  "art",
  "vol",
  "chap",
  "ex",
  "fig",
  "ed",
  "trad",
  "av",
  "no",
  "st",
  "ste",
  "c",
]);

const SENTENCE_END =
  /[.!?…]+\s*[»”](?=\s+[A-ZÀ-ÖØ-Þ«"“0-9])|[.!?…]+(?=\s+[A-ZÀ-ÖØ-Þ«"“0-9])|[»”](?=\s+[A-ZÀ-ÖØ-Þ«"“0-9])|…+(?=\s+(?![»”])\S)/g;

const isHeading = (text) => /^#{1,6}\s/.test(text);
const isStructured = (text) =>
  /^\s*(-|\*|\d+\.)\s/.test(text) || /^\s*\|/.test(text);

function splitSentences(text) {
  const out = [];
  let start = 0;

  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    const before = text.slice(start, match.index);
    const token = before.match(/([A-Za-zÀ-ÖØ-öø-ÿ0-9.]+)$/)?.[1] ?? "";

    if (
      match[0].startsWith(".") &&
      (ABBREVIATIONS.has(token.toLowerCase()) ||
        /^[A-ZÀ-ÖØ-Þ]$/.test(token))
    ) {
      continue;
    }

    const sentence = text.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = end;
  }

  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

export function splitMarkdownUnits(body) {
  const blocks = `${body ?? ""}`.trim().split(/\n{2,}/);
  const raw = [];

  for (const block of blocks) {
    const text = block.trim();
    if (!text) continue;

    if (isHeading(text)) {
      raw.push({ kind: "heading", text });
      continue;
    }

    const unwrapped = text.replace(/\s*\n\s*/g, " ").replace(/\s+/g, " ").trim();
    const parts = isStructured(unwrapped) ? [unwrapped] : splitSentences(unwrapped);
    for (const sentence of parts) {
      raw.push({ kind: "sentence", text: sentence });
    }
  }

  const merged = [];
  for (const unit of raw) {
    const punctuationOnly =
      unit.kind === "sentence" && !/[\p{L}\p{N}]/u.test(unit.text);
    const previous = merged[merged.length - 1];
    if (punctuationOnly && previous?.kind === "sentence") {
      previous.text += ` ${unit.text}`;
    } else {
      merged.push({ ...unit });
    }
  }

  const units = [];
  const sentences = [];
  let index = 0;
  for (const unit of merged) {
    if (unit.kind === "heading") {
      units.push({ kind: "heading", text: unit.text, index: null });
      continue;
    }
    const sentence = { kind: "sentence", text: unit.text, index };
    units.push(sentence);
    sentences.push({ index, text: unit.text });
    index++;
  }

  return { units, sentences };
}

export function indexUnits(units) {
  return units
    .map((unit) =>
      unit.kind === "heading" ? unit.text : `[${unit.index}] ${unit.text}`,
    )
    .join("\n");
}

export function normalizeTurns(
  turns,
  sentenceCount,
  { minSpeakers = 2 } = {},
) {
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new Error("turns must be a non-empty array");
  }

  const out = [];
  for (const turn of turns) {
    const start = Number(turn?.start);
    const speaker = `${turn?.speaker ?? ""}`.trim().replace(/\s*:$/, "");

    if (!Number.isInteger(start) || start < 0 || start >= sentenceCount) {
      throw new Error(`invalid turn start: ${turn?.start}`);
    }
    if (!speaker || speaker.length > 80) {
      throw new Error(`invalid speaker: ${turn?.speaker}`);
    }
    if (out.length === 0 && start !== 0) {
      throw new Error("the first turn must start at 0");
    }
    if (out.length > 0 && start <= out[out.length - 1].start) {
      throw new Error("turn starts must be strictly increasing");
    }
    if (out.length > 0 && out[out.length - 1].speaker === speaker) {
      continue;
    }

    out.push({ start, speaker });
  }

  const speakers = new Set(out.map((turn) => turn.speaker));
  if (speakers.size < minSpeakers) {
    throw new Error("the labeler returned a single speaker");
  }

  return out;
}

export function renderMarkdownUnits(units, turns) {
  const sentenceCount = units.filter((unit) => unit.kind === "sentence").length;
  const normalized = normalizeTurns(turns, sentenceCount, {
    minSpeakers: 1,
  });
  const blocks = [];
  let turnIndex = 0;
  let current = null;
  let lastWasHeading = false;

  for (const unit of units) {
    if (unit.kind === "heading") {
      blocks.push({ type: "heading", text: unit.text });
      lastWasHeading = true;
      continue;
    }

    while (
      turnIndex < normalized.length &&
      normalized[turnIndex].start === unit.index
    ) {
      current = normalized[turnIndex].speaker;
      turnIndex++;
    }

    if (!current) {
      throw new Error(`no speaker declared for sentence ${unit.index}`);
    }

    const last = blocks[blocks.length - 1];
    if (
      lastWasHeading ||
      !last ||
      last.type !== "turn" ||
      last.speaker !== current
    ) {
      blocks.push({ type: "turn", speaker: current, sentences: [unit.text] });
    } else {
      last.sentences.push(unit.text);
    }
    lastWasHeading = false;
  }

  return blocks
    .map((block) =>
      block.type === "heading"
        ? block.text
        : `**${block.speaker} :** ${block.sentences.join(" ")}`,
    )
    .join("\n\n");
}
