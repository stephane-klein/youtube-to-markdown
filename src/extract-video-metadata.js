import { writeFile } from "node:fs/promises";
import { stringify } from "yaml";
import { formatDuration, progressLine } from "./progress.js";
import { runYtDlp } from "./ytdlp.js";

const DATE_CHUNK = 50;

const count = (value, word) => `${value} ${word}${value === 1 ? "" : "s"}`;

const toIso = (raw) =>
  /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : "";

async function ytDlp(args, { allowFailure = false } = {}) {
  const { stdout } = await runYtDlp(args, { stderr: "inherit", allowFailure });
  return stdout;
}

async function uploadsPlaylistUrl(channelUrl) {
  const out = await ytDlp([
    "--flat-playlist",
    "--playlist-end",
    "1",
    "-O",
    "%(playlist_channel_id)s",
    channelUrl,
  ]);
  const channelId = out.split("\n").map((line) => line.trim()).filter(Boolean)[0];

  if (!channelId?.startsWith("UC")) {
    throw new Error(`ID de chaîne introuvable pour ${channelUrl}`);
  }

  return `https://www.youtube.com/playlist?list=UU${channelId.slice(2)}`;
}

const isPlaylistUrl = (url) => {
  try {
    return new URL(url).pathname === "/playlist";
  } catch {
    return false;
  }
};

async function listEntries(playlistUrl, lang) {
  const args = [
    "--flat-playlist",
    "-O",
    '{"titre": %(title)j, "url": %(webpage_url)j, "playlist": %(playlist_title)j, "index": %(playlist_index)j}',
    "--extractor-args",
    `youtube:lang=${lang}`,
  ];
  args.push(playlistUrl);

  const out = await ytDlp(args);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const videoId = (url) => /[?&]v=([\w-]+)/.exec(url)?.[1] ?? url;

async function fetchExactDates(urls) {
  const dates = new Map();
  const startedAt = performance.now();

  for (let i = 0; i < urls.length; i += DATE_CHUNK) {
    const chunk = urls.slice(i, i + DATE_CHUNK);
    const out = await ytDlp(
      [
        "--skip-download",
        "--no-playlist",
        "--ignore-errors",
        "--print",
        "%(id)s|%(upload_date)s",
        ...chunk,
      ],
      { allowFailure: true },
    );

    for (const line of out.split("\n").filter(Boolean)) {
      const [id, raw] = line.split("|");
      const iso = toIso(raw ?? "");
      if (id && iso) dates.set(id, iso);
    }

    console.error(
      progressLine({
        label: "exact dates",
        done: Math.min(i + DATE_CHUNK, urls.length),
        total: urls.length,
        startedAt,
      }),
    );
  }

  return dates;
}

async function fetchVideos(sourceUrl, knownDates) {
  const playlist = isPlaylistUrl(sourceUrl);
  const playlistUrl = playlist ? sourceUrl : await uploadsPlaylistUrl(sourceUrl);
  const en = await listEntries(playlistUrl, "en");
  const fr = await listEntries(playlistUrl, "fr");
  const frTitles = new Map(fr.map((entry) => [entry.url, entry.titre]));

  const videos = en
    .filter((entry) => !entry.url.includes("/shorts/"))
    .map((entry) => {
      const enTitle = entry.titre.trim();
      const frTitle = (frTitles.get(entry.url) ?? enTitle).trim();
      const video = {
        title:
          frTitle && enTitle && frTitle !== enTitle
            ? { fr: frTitle, en: enTitle }
            : { fr: frTitle || enTitle },
        url: entry.url,
      };
      if (playlist && Number.isInteger(entry.index)) video.index = entry.index;
      return video;
    });

  const missing = videos
    .filter((video) => !knownDates.has(videoId(video.url)))
    .map((video) => video.url);
  const fetched = await fetchExactDates(missing);

  for (const video of videos) {
    const id = videoId(video.url);
    video.date = knownDates.get(id) ?? fetched.get(id) ?? "";
  }

  const ordered = playlist
    ? [...videos].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    : [...videos].reverse();

  return {
    title: playlist ? (en[0]?.playlist ?? "") : "",
    playlist,
    videos: ordered.map((video) => {
      const fields = { title: video.title, date: video.date, url: video.url };
      return video.index !== undefined
        ? { index: video.index, ...fields }
        : fields;
    }),
  };
}

function normalizeEntry(entry) {
  const { titre, ...rest } = entry;
  if (typeof titre === "string") {
    return { title: { fr: titre }, ...rest };
  }
  return entry;
}

const MANAGED_KEYS = new Set(["title", "date", "url", "titre", "index"]);

function userFields(entry) {
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => !MANAGED_KEYS.has(key)),
  );
}

function mergeVideos(existing, fetched, { sort = true } = {}) {
  const existingByUrl = new Map(
    existing.filter((v) => v.url).map((v) => [v.url, v]),
  );
  const merged = fetched.map((video) => {
    const previous = existingByUrl.get(video.url);
    return previous
      ? { ...video, ...userFields(previous), date: video.date || previous.date }
      : video;
  });
  const fetchedUrls = new Set(fetched.map((v) => v.url));
  const extras = existing
    .filter((v) => v.url && !fetchedUrls.has(v.url))
    .map(normalizeEntry)
    .map(({ index, ...video }) => video);
  const all = [...merged, ...extras];
  return sort
    ? all.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))
    : all;
}

export async function runExtract({
  path = "youtube_to_markdown.yaml",
  config = {},
  forceDates = false,
} = {}) {
  const startedAt = performance.now();
  let sourceCount = 0;
  let videoCount = 0;

  for (const channel of config.feed ?? []) {
    if (typeof channel.url !== "string" || !channel.url) continue;

    const channelStartedAt = performance.now();
    const videos = channel.videos ?? [];
    const knownDates = forceDates
      ? new Map()
      : new Map(
        videos
          .filter((video) => video.url && video.date)
          .map((video) => [videoId(video.url), video.date]),
      );
    console.error(`→ ${channel.url}`);
    const fetched = await fetchVideos(channel.url, knownDates);
    if (fetched.title && !channel.title) channel.title = fetched.title;
    channel.videos = mergeVideos(videos, fetched.videos, {
      sort: !fetched.playlist,
    });

    sourceCount += 1;
    videoCount += channel.videos.length;
    console.error(
      `  done in ${formatDuration(performance.now() - channelStartedAt)}`,
    );
  }

  await writeFile(path, stringify(config, { lineWidth: 0 }));

  console.error(
    `summary: ${count(sourceCount, "source")}, ${count(videoCount, "video")}, ${formatDuration(performance.now() - startedAt)} elapsed`,
  );
}
