import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMarkdownStats } from "../src/markdown-stats.js";

const frontmatter = (input) => [
  "---",
  "generated_at: 2026-10-20T10:00:00.000Z",
  "llm:",
  "  model: mimo-v2.5",
  `  input_tokens: ${input}`,
  "  output_tokens: 10",
  "  estimated_cost_usd: 0.001",
  "  duration_seconds: 2",
  "---",
  "",
  "# Title",
  "",
  "Body.",
  "",
].join("\n");

test("markdown-stats ignores dialogue derivatives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yt-to-md-stats-"));
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  try {
    await writeFile(join(dir, "2026-10-18_video.fr.md"), frontmatter(100));
    await writeFile(
      join(dir, "2026-10-18_video.fr.dialogue.md"),
      frontmatter(999999),
    );
    await runMarkdownStats({ dir });
  } finally {
    console.log = original;
    await rm(dir, { recursive: true, force: true });
  }

  const output = logs.join("\n");
  assert.match(output, /1 file\(s\)/);
  assert.doesNotMatch(output, /999999/);
  assert.match(output, /100 in/);
});
