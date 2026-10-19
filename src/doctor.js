import { access, constants } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateText } from "ai";
import { loadConfig, settingsFromConfig } from "./config.js";
import {
  createModel,
  DEFAULT_REASONING,
  describeError,
  reasoningOptions,
} from "./generate-markdown.js";
import { loadPricing } from "./pricing.js";
import { exists } from "./vtt.js";
import { runYtDlp } from "./ytdlp.js";

const MIN_NODE_MAJOR = 22;

function resolveApiKey(overrides, config, env = process.env) {
  if (overrides.apiKey !== undefined) {
    const envKey = env.YT_TO_MD_API_KEY;
    const source = envKey !== undefined && envKey === overrides.apiKey
      ? "YT_TO_MD_API_KEY"
      : "--api-key";
    return { key: overrides.apiKey, source };
  }
  if (config?.api_key !== undefined) {
    return { key: config.api_key, source: "api_key (config)" };
  }
  if (env.OPENAI_API_KEY) {
    return { key: env.OPENAI_API_KEY, source: "OPENAI_API_KEY" };
  }
  return { key: undefined, source: null };
}

async function checkContents(dir) {
  try {
    await access(dir, constants.W_OK);
    return { status: "ok", note: null };
  } catch (error) {
    if (error.code !== "ENOENT") {
      return { status: "error", note: "not writable" };
    }
  }
  let parent = dirname(dir);
  while (true) {
    try {
      await access(parent, constants.W_OK);
      return { status: "warn", note: "not created yet" };
    } catch (error) {
      if (error.code !== "ENOENT") {
        return { status: "error", note: "not writable" };
      }
      const next = dirname(parent);
      if (next === parent) return { status: "error", note: "not writable" };
      parent = next;
    }
  }
}

function checkNode() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  return major >= MIN_NODE_MAJOR
    ? { status: "ok", value: `v${version}`, note: null }
    : { status: "error", value: `v${version}`, note: `requires >= ${MIN_NODE_MAJOR}` };
}

async function checkYtDlp() {
  try {
    const { stdout } = await runYtDlp(["--version"]);
    return { status: "ok", value: stdout.trim() || "found", note: null };
  } catch (error) {
    return { status: "error", value: "-", note: error.message };
  }
}

async function loadConfigSafe(configPath) {
  if (!(await exists(configPath))) {
    return {
      config: null,
      row: { status: "warn", value: configPath, note: "not found" },
    };
  }
  try {
    const config = loadConfig(configPath);
    const channels = config.feed?.length ?? 0;
    const videos = (config.feed ?? []).reduce(
      (total, channel) => total + (channel.videos?.length ?? 0),
      0,
    );
    return {
      config,
      row: {
        status: "ok",
        value: configPath,
        note: `${channels} source(s), ${videos} video(s)`,
      },
    };
  } catch (error) {
    return {
      config: null,
      row: { status: "error", value: configPath, note: error.message },
    };
  }
}

function checkEndpoint(endpoint) {
  if (!endpoint) return { status: "error", value: "-", note: "not set" };
  try {
    new URL(endpoint);
    return { status: "ok", value: endpoint, note: null };
  } catch {
    return { status: "error", value: endpoint, note: "not a valid URL" };
  }
}

async function checkLlm({ llm, settings, key, timeoutMs }) {
  if (!llm) {
    return { status: "warn", value: "-", note: "skipped (--no-llm)" };
  }
  if (!settings.model) return { status: "error", value: "-", note: "model not set" };
  if (!settings.endpoint) return { status: "error", value: "-", note: "endpoint not set" };
  if (!key) return { status: "error", value: "-", note: "api key not set" };

  try {
    const model = createModel({
      modelId: settings.model,
      endpoint: settings.endpoint,
      apiKey: key,
      session: settings.session,
    });
    const started = performance.now();
    const reasoning = settings.reasoning ?? DEFAULT_REASONING;
    const { usage } = await generateText({
      model,
      prompt: "ping",
      maxOutputTokens: 8,
      maxRetries: 0,
      ...reasoningOptions(reasoning, settings.endpoint),
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    const elapsed = (performance.now() - started) / 1000;
    return {
      status: "ok",
      value: `${elapsed.toFixed(1)}s`,
      note: `${usage?.inputTokens ?? 0} in / ${usage?.outputTokens ?? 0} out`,
    };
  } catch (error) {
    return { status: "error", value: "-", note: describeError(error, 1) };
  }
}

async function checkPricing({ settings }) {
  if (!settings.endpoint) {
    return { status: "warn", value: "-", note: "endpoint not set" };
  }
  if (!settings.model) {
    return { status: "warn", value: "-", note: "model not set" };
  }

  const pricing = await loadPricing({ endpoint: settings.endpoint });
  if (!pricing) return { status: "warn", value: "-", note: "no pricing source" };

  const price = pricing.priceAt(settings.model);
  if (!price) {
    return { status: "warn", value: pricing.provider, note: "model not priced" };
  }

  const peak = price.peak === null ? "" : price.peak ? " (peak)" : " (off-peak)";
  const usd = (value) => (typeof value === "number" ? `$${value}` : "-");
  return {
    status: "ok",
    value: `${price.source}${peak}`,
    note: `${usd(price.input)} in / ${usd(price.output)} out / ${usd(price.cachedInput)} cached per 1M`,
  };
}

function render(rows) {
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const valueWidth = Math.max(...rows.map((row) => row.value.length));
  return rows.map((row) => {
    const note = row.note ? ` (${row.note})` : "";
    return `${row.label.padEnd(labelWidth)}  ${row.value.padEnd(valueWidth)}  ${row.status}${note}`;
  });
}

export async function runDoctor({
  configPath = "youtube_to_markdown.yaml",
  overrides = {},
  llm = true,
  timeoutMs = 30000,
} = {}) {
  const { config, row: configRow } = await loadConfigSafe(configPath);

  const settings = { ...settingsFromConfig(config ?? {}) };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) settings[key] = value;
  }

  const { key, source } = resolveApiKey(overrides, config);
  const dir = resolve(dirname(configPath), config?.contents_path ?? "contents");

  const rows = [
    { label: "node", ...checkNode() },
    { label: "yt-dlp", ...(await checkYtDlp()) },
  ];
  rows.push({ label: "config", ...configRow });
  rows.push({
    label: "contents",
    value: config?.contents_path ?? "contents",
    ...(await checkContents(dir)),
  });
  rows.push({
    label: "model",
    value: settings.model ?? "-",
    status: settings.model ? "ok" : "error",
    note: settings.model ? null : "not set",
  });
  rows.push({ label: "endpoint", ...checkEndpoint(settings.endpoint) });
  rows.push({
    label: "api key",
    value: source ?? "-",
    status: key ? "ok" : "error",
    note: key ? null : "not set",
  });
  if (settings.session) {
    rows.push({ label: "session", value: "set", status: "info", note: null });
  }
  rows.push({
    label: "reasoning",
    value: settings.reasoning ?? DEFAULT_REASONING,
    status: "info",
    note: null,
  });
  rows.push({ label: "pricing", ...(await checkPricing({ settings })) });
  const llmRow = await checkLlm({ llm, settings, key, timeoutMs });
  rows.push({ label: "llm", ...llmRow });

  const counts = { ok: 0, warn: 0, error: 0 };
  for (const row of rows) {
    if (row.status in counts) counts[row.status]++;
  }

  console.log(`youtube-to-markdown doctor`);
  console.log(render(rows).join("\n"));
  console.log();
  console.log(
    `summary: ${counts.ok} ok, ${counts.warn} warning, ${counts.error} error`,
  );

  if (counts.error > 0) process.exitCode = 1;
}
