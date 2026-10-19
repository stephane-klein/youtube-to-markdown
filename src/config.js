import { readFileSync } from "node:fs";
import { parse } from "yaml";

export function loadConfig(path) {
  return parse(readFileSync(path, "utf8")) ?? {};
}

const YAML_KEYS = {
  model: "model_id",
  endpoint: "openaiapi_endpoint",
  apiKey: "api_key",
  session: "x_opencode_session",
  concurrency: "concurrency",
  ytdlpConcurrency: "ytdlp_concurrency",
  retryDelays: "retry_delays",
  maxOutputTokens: "max_output_tokens",
  chunkTargetTokens: "chunk_target_tokens",
  reasoning: "reasoning",
};

export function settingsFromConfig(config) {
  return Object.fromEntries(
    Object.entries(YAML_KEYS)
      .map(([key, yamlKey]) => [key, config[yamlKey]])
      .filter(([, value]) => value !== undefined),
  );
}

const ENV = {
  config: "YT_TO_MD_CONFIG",
  model: "YT_TO_MD_MODEL_ID",
  endpoint: "YT_TO_MD_OPENAIAPI_ENDPOINT",
  apiKey: "YT_TO_MD_API_KEY",
  session: "YT_TO_MD_X_OPENCODE_SESSION",
  concurrency: "YT_TO_MD_CONCURRENCY",
  ytdlpConcurrency: "YT_TO_MD_YTDLP_CONCURRENCY",
  retryDelays: "YT_TO_MD_RETRY_DELAYS",
  maxOutputTokens: "YT_TO_MD_MAX_OUTPUT_TOKENS",
  chunkTargetTokens: "YT_TO_MD_CHUNK_TARGET_TOKENS",
  reasoning: "YT_TO_MD_REASONING",
  debugLlm: "YT_TO_MD_DEBUG_LLM",
};

export function loadEnv(env = process.env) {
  return Object.fromEntries(
    Object.entries(ENV)
      .map(([key, name]) => [key, env[name]])
      .filter(([, value]) => value !== undefined),
  );
}
