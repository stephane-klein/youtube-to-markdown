import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runReorganize } from "../src/organize-files.js";

test("reorganize moves dialogue derivatives with their base file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yt-to-md-organize-"));
  const date = "2026-10-18";
  const slug = "17-octobre-macron-joue-le-pourrissement";
  const name = `${date}_${slug}`;
  for (const suffix of ["fr.md", "fr.dialogue.md", "fr.vtt"]) {
    await writeFile(join(dir, `${name}.${suffix}`), "x");
  }

  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  try {
    await runReorganize({
      dir,
      dryRun: true,
      feed: [
        {
          folder_slug: "jean-luc-melenchon",
          videos: [
            {
              date,
              title: "17 octobre : Macron joue le pourrissement",
              url: "https://example.com",
            },
          ],
        },
      ],
    });
  } finally {
    console.error = original;
    await rm(dir, { recursive: true, force: true });
  }

  const output = logs.join("\n");
  assert.match(
    output,
    /jean-luc-melenchon\/2026-10-18_17-octobre-macron-joue-le-pourrissement\.fr\.dialogue\.md/,
  );
  assert.match(
    output,
    /jean-luc-melenchon\/2026-10-18_17-octobre-macron-joue-le-pourrissement\.fr\.md/,
  );
  assert.match(output, /summary: 3 to move/);
});
