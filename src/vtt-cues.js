import { parse } from "yaml";

const TIMESTAMP =
  /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const TITLE = /^(\s*#\s+.*(?:\r?\n|$))/;
const SPEAKER_LABEL =
  /(^|[.!?…]\s+)[ \t]*\*\*[^*\n]{1,80}\s?:\*\*[ \t]*/gm;

const seconds = (h, m, s, ms) => +h * 3600 + +m * 60 + +s + +ms / 1000;

const cleanLine = (line) => line.replace(/<[^>]*>/g, "").trim();

export function parseVttCues(vtt) {
  const cues = [];
  let current = null;

  for (const raw of `${vtt ?? ""}`.split(/\r?\n/)) {
    const line = raw.trim();
    const match = TIMESTAMP.exec(line);

    if (match) {
      current = {
        start: seconds(match[1], match[2], match[3], match[4]),
        end: seconds(match[5], match[6], match[7], match[8]),
        lines: [],
      };
      cues.push(current);
      continue;
    }

    if (!current) continue;
    if (
      !line ||
      line.startsWith("WEBVTT") ||
      line.startsWith("Kind:") ||
      line.startsWith("Language:") ||
      line.startsWith("NOTE") ||
      /^\d+$/.test(line)
    ) {
      continue;
    }

    current.lines.push(cleanLine(line));
  }

  return cues.map(({ start, end, lines }) => {
    const kept = lines.filter(Boolean);
    return {
      start,
      end,
      text: kept.join(" ").replace(/\s+/g, " ").trim(),
      lines: kept,
    };
  });
}

function dedupeLines(cues) {
  const out = [];
  for (const cue of cues) {
    for (const raw of cue.lines ?? []) {
      const line = cleanLine(raw);
      if (!line) continue;
      if (out[out.length - 1]?.text === line) continue;
      out.push({ start: cue.start, text: line });
    }
  }
  return out;
}

const timestamp = (value) => {
  const total = Math.max(0, Math.floor(value));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

export function cueTranscript(cues, { timestampEvery = 30 } = {}) {
  const lines = dedupeLines(cues);
  const interval = Math.max(1, Number(timestampEvery) || 30);
  let lastStamp = -Infinity;

  return lines
    .map(({ start, text }) => {
      if (start - lastStamp >= interval) {
        lastStamp = start;
        return `[${timestamp(start)}] ${text}`;
      }
      return text;
    })
    .join("\n");
}

export function vttToText(vtt) {
  return dedupeLines(parseVttCues(vtt))
    .map((line) => line.text)
    .join("\n");
}

export function cueHints(
  cues,
  { maxLineChars = 30, timestampEvery = 30 } = {},
) {
  const lines = dedupeLines(cues).filter(
    (line) => line.text.length <= maxLineChars,
  );
  const interval = Math.max(1, Number(timestampEvery) || 30);
  let lastStamp = -Infinity;

  return lines
    .map(({ start, text }) => {
      if (start - lastStamp >= interval) {
        lastStamp = start;
        return `[${timestamp(start)}] ${text}`;
      }
      return text;
    })
    .join("\n");
}

export function splitMarkdown(text) {
  const source = `${text ?? ""}`;
  const match = FRONTMATTER.exec(source);
  const front = match ? match[0] : "";
  let data = {};
  if (match) {
    try {
      data = parse(match[1]) ?? {};
    } catch {
      data = {};
    }
  }

  let rest = source.slice(front.length);
  const titleMatch = TITLE.exec(rest);
  const title = titleMatch ? titleMatch[1] : "";
  rest = rest.slice(title.length);

  return { data, front, title, body: rest };
}

export function stripSpeakerLabels(text) {
  return `${text ?? ""}`.replace(SPEAKER_LABEL, "$1");
}

const SPEAKER_TURN = /^\*\*[^*\n]{1,80}\s?:\*\*/gm;

export function countSpeakerLabels(body) {
  return (`${body ?? ""}`.match(SPEAKER_TURN) ?? []).length;
}

export function hasSpeakerLabels(body) {
  return countSpeakerLabels(body) >= 2;
}

export function normalizeForComparison(text) {
  return `${text ?? ""}`
    .replace(/\r\n/g, "\n")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function assertTextPreserved(baseBody, labeledBody) {
  const expected = normalizeForComparison(baseBody);
  const actual = normalizeForComparison(stripSpeakerLabels(labeledBody));
  if (expected === actual) return true;

  let index = 0;
  while (
    index < expected.length &&
    index < actual.length &&
    expected[index] === actual[index]
  ) {
    index++;
  }

  const start = Math.max(0, index - 80);
  const excerpt = (value) => JSON.stringify(value.slice(start, index + 160));
  throw new Error(
    `speaker labels changed the text at character ${index}: ` +
      `expected ${excerpt(expected)}, got ${excerpt(actual)}`,
  );
}
