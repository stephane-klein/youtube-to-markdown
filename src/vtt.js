import {
  copyFile,
  mkdtemp,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { runYtDlp } from "./ytdlp.js";

export const DEFAULT_DIR = resolve("contents");
export const ORPHANS_DIR = "_orphans";

export function assertFolderSlug(folderSlug) {
  if (folderSlug === undefined || folderSlug === null || folderSlug === "") {
    return null;
  }
  if (typeof folderSlug !== "string") {
    throw new Error("folder_slug must be a string");
  }

  const segments = folderSlug.split(/[\\/]+/).filter(Boolean);
  if (isAbsolute(folderSlug) || segments.includes("..")) {
    throw new Error(
      `folder_slug must be a relative path inside contents_path: ${folderSlug}`,
    );
  }
  if (segments.length === 0) {
    throw new Error("folder_slug must not be empty");
  }
  if (segments[0] === ORPHANS_DIR) {
    throw new Error(`folder_slug must not be "${ORPHANS_DIR}" (reserved)`);
  }

  return segments.join("/");
}

export const slugify = (text) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const primaryTitle = (video) => {
  const title = video.title;
  if (typeof title === "string") return title;
  return title?.fr ?? title?.en ?? "";
};

export const titleForLang = (title, lang) => {
  if (typeof title === "string") return title;
  return title?.[lang] ?? title?.fr ?? title?.en ?? "";
};

export async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function findVtt(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const entry = entries.find(
    (item) => item.isFile && item.name.endsWith(".vtt"),
  );
  return entry ? join(dir, entry.name) : null;
}

export async function writeMarker(path, url) {
  await writeFile(path, `${url}\n${new Date().toISOString()}\n`);
}

export async function downloadVtt(url, lang, dest) {
  const tmp = await mkdtemp(join(tmpdir(), "yt-to-md-"));
  let failed = false;
  try {
    for (const mode of ["--write-subs", "--write-auto-subs"]) {
      const { success } = await runYtDlp(
        [
          "--skip-download",
          "--sleep-requests",
          "2",
          mode,
          "--sub-langs",
          `^${lang}$`,
          "--sub-format",
          "vtt",
          "-o",
          join(tmp, "sub.%(ext)s"),
          url,
        ],
        { allowFailure: true },
      );
      if (!success) failed = true;
      const vtt = await findVtt(tmp);
      if (vtt) {
        await copyFile(vtt, dest);
        return "downloaded";
      }
    }
    return failed ? "error" : "missing";
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

export function videoJobs(video, dir = DEFAULT_DIR, folderSlug = null) {
  if (
    video.dialogue !== undefined &&
    video.dialogue !== null &&
    typeof video.dialogue !== "boolean"
  ) {
    throw new Error("dialogue must be a boolean");
  }
  if (video.speakers !== undefined && !Array.isArray(video.speakers)) {
    throw new Error("speakers must be an array");
  }

  const folder = assertFolderSlug(folderSlug);
  const langs = Object.entries(video.download_vtt ?? {})
    .filter(([, on]) => on)
    .map(([lang]) => lang);
  if (langs.length === 0 || !video.url) return [];

  const slug = slugify(primaryTitle(video));
  if (!slug) return [];

  const prefix = Number.isInteger(video.index) ? `${video.index}-` : "";

  return langs.map((lang) => {
    const name = `${prefix}${video.date}_${slug}.${lang}`;
    const base = folder ? join(dir, folder, name) : join(dir, name);
    return {
      url: video.url,
      lang,
      title: primaryTitle(video),
      titles: video.title,
      dialogue: video.dialogue,
      speakers: video.speakers,
      base,
      vtt: `${base}.vtt`,
      marker: `${base}.vtt.missing`,
      labeled: `${base}.dialogue.md`,
    };
  });
}
