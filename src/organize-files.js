import { mkdir, readdir, rename } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import {
  DEFAULT_DIR,
  ORPHANS_DIR,
  assertFolderSlug,
  exists,
  primaryTitle,
  slugify,
} from "./vtt.js";

const MARKER = /^(.*)\.([^.]+)\.vtt\.missing$/;
const VTT = /^(.*)\.([^.]+)\.vtt$/;
const DIALOGUE = /^(.*)\.([^.]+)\.dialogue\.md$/;
const MD = /^(.*)\.([^.]+)\.md$/;

function prefixOf(name) {
  for (const pattern of [DIALOGUE, MARKER, VTT, MD]) {
    const match = pattern.exec(name);
    if (match) return match[1];
  }
  return null;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ORPHANS_DIR) continue;
      files.push(...(await walk(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function foldersByPrefix(feed) {
  const targets = new Map();
  for (const channel of feed) {
    const folder = assertFolderSlug(channel.folder_slug) ?? "";
    for (const video of channel.videos ?? []) {
      const slug = slugify(primaryTitle(video));
      if (!video.date || !slug) continue;
      const prefix = Number.isInteger(video.index)
        ? `${video.index}-${video.date}_${slug}`
        : `${video.date}_${slug}`;
      const folders = targets.get(prefix) ?? new Set();
      folders.add(folder);
      targets.set(prefix, folders);
    }
  }
  return targets;
}

export async function runReorganize({
  feed = [],
  dir = DEFAULT_DIR,
  dryRun = false,
} = {}) {
  const targets = foldersByPrefix(feed);
  const files = (await exists(dir)) ? (await walk(dir)).sort() : [];
  const claimed = new Set();

  const moves = [];
  const conflicts = [];
  let inPlace = 0;

  for (const file of files) {
    const name = basename(file);
    const folders = targets.get(prefixOf(name));

    let target;
    let orphan = false;
    if (!folders || folders.size === 0) {
      target = join(dir, ORPHANS_DIR, relative(dir, file));
      orphan = true;
    } else if (folders.size > 1) {
      conflicts.push({
        file,
        reason: `ambiguous folder_slug (${[...folders].sort().join(", ")})`,
      });
      continue;
    } else {
      const folder = [...folders][0];
      target = folder ? join(dir, folder, name) : join(dir, name);
    }

    if (target === file) {
      inPlace++;
      continue;
    }
    if (claimed.has(target) || (await exists(target))) {
      conflicts.push({
        file,
        reason: `target already exists: ${relative(dir, target)}`,
      });
      continue;
    }

    claimed.add(target);
    moves.push({ from: file, to: target, orphan });
  }

  const width = String(moves.length).length;
  let moved = 0;
  let orphans = 0;
  for (const [index, move] of moves.entries()) {
    const prefix = `[${String(index + 1).padStart(width)}/${moves.length}]`;
    const status = move.orphan ? "orphan" : "moved";
    if (move.orphan) orphans++;
    else moved++;
    if (dryRun) {
      console.error(
        `${prefix} ${status.padEnd(9)} ${relative(dir, move.to)} (dry run)`,
      );
      continue;
    }
    await mkdir(dirname(move.to), { recursive: true });
    await rename(move.from, move.to);
    console.error(`${prefix} ${status.padEnd(9)} ${relative(dir, move.to)}`);
  }

  for (const { file, reason } of conflicts) {
    console.error(`conflict  ${relative(dir, file)} (${reason})`);
  }

  if (dryRun) {
    console.error(`dry run: no file was moved`);
    console.error(
      `summary: ${moved} to move, ${orphans} to orphan, ${inPlace} already in place, ${conflicts.length} conflict`,
    );
    return;
  }
  console.error(
    `summary: ${moved} moved, ${orphans} orphan, ${inPlace} already in place, ${conflicts.length} conflict`,
  );
}
