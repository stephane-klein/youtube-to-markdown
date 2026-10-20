import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { DEFAULT_DIR } from "./vtt.js";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LANGUAGE = /\.([^./]+)\.md$/;
const DIALOGUE = /\.dialogue\.md$/i;

async function markdownFiles(dir, base = dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await markdownFiles(path, base)));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      !DIALOGUE.test(entry.name)
    ) {
      files.push(relative(base, path));
    }
  }
  return files;
}

const numberOrNull = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function safeParse(text) {
  try {
    return parse(text);
  } catch {
    return null;
  }
}

function bump(map, key, { input, cached, output, cost }) {
  const entry = map.get(key) ??
    { files: 0, input: 0, cached: 0, output: 0, cost: 0, unknownCost: 0 };
  entry.files++;
  entry.input += input ?? 0;
  entry.cached += cached ?? 0;
  entry.output += output ?? 0;
  if (cost === null) entry.unknownCost++;
  else entry.cost += cost;
  map.set(key, entry);
}

const int = new Intl.NumberFormat("en-US");
const seconds = (value) => `${value.toFixed(1)}s`;
const usd = (value) => `$${value.toFixed(6)}`;
const row = (label, value) => `  ${label.padEnd(20)} ${value}`;

export async function runMarkdownStats({ dir = DEFAULT_DIR } = {}) {
  const stats = {
    files: 0,
    withFrontmatter: 0,
    withoutFrontmatter: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    cost: 0,
    unknownCost: 0,
    durationSum: 0,
    durationCount: 0,
    durationMin: null,
    durationMax: null,
    firstGeneratedAt: null,
    lastGeneratedAt: null,
    models: new Map(),
    languages: new Map(),
    folders: new Map(),
  };

  const names = (await markdownFiles(dir)).sort();

  for (const name of names) {
    stats.files++;

    const match = FRONTMATTER.exec(await readFile(join(dir, name), "utf8"));
    const parsed = match ? safeParse(match[1]) : null;
    const data =
      parsed && typeof parsed === "object" && "generated_at" in parsed
        ? parsed
        : null;

    if (!data) {
      stats.withoutFrontmatter++;
      continue;
    }
    stats.withFrontmatter++;

    const llm = data.llm ?? {};
    const input = numberOrNull(llm.input_tokens);
    const cached = numberOrNull(llm.cached_input_tokens);
    const output = numberOrNull(llm.output_tokens);
    const cost = numberOrNull(llm.estimated_cost_usd);
    const duration = numberOrNull(llm.duration_seconds);

    stats.inputTokens += input ?? 0;
    stats.cachedInputTokens += cached ?? 0;
    stats.outputTokens += output ?? 0;
    if (cost === null) stats.unknownCost++;
    else stats.cost += cost;

    if (duration !== null) {
      stats.durationSum += duration;
      stats.durationCount++;
      stats.durationMin = stats.durationMin === null
        ? duration
        : Math.min(stats.durationMin, duration);
      stats.durationMax = stats.durationMax === null
        ? duration
        : Math.max(stats.durationMax, duration);
    }

    if (typeof data.generated_at === "string") {
      const at = data.generated_at;
      if (!stats.firstGeneratedAt || at < stats.firstGeneratedAt) {
        stats.firstGeneratedAt = at;
      }
      if (!stats.lastGeneratedAt || at > stats.lastGeneratedAt) {
        stats.lastGeneratedAt = at;
      }
    }

    bump(stats.models, llm.model ?? "unknown", { input, cached, output, cost });
    bump(stats.languages, LANGUAGE.exec(name)?.[1] ?? "unknown", {
      input,
      cached,
      output,
      cost,
    });
    const segments = name.split(/[\\/]/);
    bump(stats.folders, segments.length > 1 ? segments[0] : "(root)", {
      input,
      cached,
      output,
      cost,
    });
  }

  const lines = [
    `${dir}/ — ${int.format(stats.files)} file(s)`,
    row("with frontmatter", int.format(stats.withFrontmatter)),
    row("without frontmatter", int.format(stats.withoutFrontmatter)),
    "",
    "tokens",
    row("input", int.format(stats.inputTokens)),
    row("cached input", int.format(stats.cachedInputTokens)),
    row("output", int.format(stats.outputTokens)),
    row("total", int.format(stats.inputTokens + stats.outputTokens)),
    "",
    "cost",
    row("estimated", usd(stats.cost)),
    row("unknown prices", `${int.format(stats.unknownCost)} file(s)`),
    "",
    "processing time",
    row("total", seconds(stats.durationSum)),
    row(
      "mean",
      seconds(
        stats.durationCount ? stats.durationSum / stats.durationCount : 0,
      ),
    ),
    row(
      "min / max",
      stats.durationCount
        ? `${seconds(stats.durationMin)} / ${seconds(stats.durationMax)}`
        : "—",
    ),
    "",
    "generated_at",
    row("first", stats.firstGeneratedAt ?? "—"),
    row("last", stats.lastGeneratedAt ?? "—"),
  ];

  const breakdown = (title, map) => {
    lines.push("", title);
    if (map.size === 0) {
      lines.push("  (none)");
      return;
    }
    for (const key of [...map.keys()].sort()) {
      const entry = map.get(key);
      const unknown = entry.unknownCost > 0
        ? `  (+${int.format(entry.unknownCost)} unknown)`
        : "";
      lines.push(
        `  ${key.padEnd(16)} ${int.format(entry.files).padStart(4)} file(s)  ` +
          `${int.format(entry.input).padStart(9)} in / ` +
          `${int.format(entry.output).padStart(9)} out  ` +
          `${usd(entry.cost)}${unknown}`,
      );
    }
  };

  breakdown("models", stats.models);
  breakdown("languages", stats.languages);
  breakdown("folders", stats.folders);

  console.log(lines.join("\n"));
}
