#!/usr/bin/env node

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { loadConfig, loadEnv, settingsFromConfig } from "./config.js";
import { runExtract } from "./extract-video-metadata.js";
import { runDownloadVtt } from "./download-vtt.js";
import { runGenerateMarkdown } from "./generate-markdown.js";
import { runMarkdownStats } from "./markdown-stats.js";
import { runReorganize } from "./organize-files.js";
import { runDoctor } from "./doctor.js";

const { version } = createRequire(import.meta.url)("../package.json");

const SETTING_KEYS = [
  "model",
  "endpoint",
  "apiKey",
  "session",
  "concurrency",
  "ytdlpConcurrency",
  "retryDelays",
  "maxOutputTokens",
  "chunkTargetTokens",
  "reasoning",
];

const handle = (run) => async (argv) => {
  try {
    await run(argv);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
};

const config = {
  describe: "Path to the YAML configuration file",
  type: "string",
  default: "youtube_to_markdown.yaml",
};

const project = (argv) => {
  const yaml = loadConfig(argv.config);
  const settings = { ...settingsFromConfig(yaml) };
  for (const key of SETTING_KEYS) {
    if (argv[key] !== undefined) settings[key] = argv[key];
  }
  const dir = resolve(dirname(argv.config), yaml.contents_path ?? "contents");
  return { path: argv.config, config: yaml, feed: yaml.feed ?? [], settings, dir };
};

const cli = yargs(hideBin(process.argv))
  .scriptName("")
  .usage("youtube-to-markdown <command>")
  .config(loadEnv())
  .option("config", config)
  .command(
    "extract-video-metadata",
    "Fetch the videos of each feed source (channel or playlist) from YouTube into the configuration file",
    (yargs) =>
      yargs
        .option("force-dates", {
          describe: "Fetch every upload date again, ignoring the known ones",
          type: "boolean",
          default: false,
        }),
    handle(async (argv) => {
      const { path, config: yaml } = project(argv);
      await runExtract({ path, config: yaml, forceDates: argv.forceDates });
    }),
  )
  .command(
    "download-vtt",
    "Download the VTT transcripts of the marked videos",
    () => {},
    handle(async (argv) => {
      const { feed, dir } = project(argv);
      await runDownloadVtt({ feed, dir });
    }),
  )
  .command(
    "generate-markdown",
    "Turn the VTT transcripts into Markdown prose with an LLM",
    (yargs) =>
      yargs
        .option("model", {
          describe: "LLM model id (default: model_id in the configuration)",
          type: "string",
        })
        .option("endpoint", {
          describe: "OpenAI-compatible chat completions endpoint",
          type: "string",
        })
        .option("api-key", {
          describe: "API key (defaults to OPENAI_API_KEY)",
          type: "string",
        })
        .option("session", {
          describe: "Value of the X-OpenCode-Session header",
          type: "string",
        })
        .option("concurrency", {
          describe: "Maximum number of concurrent LLM calls (default: 6)",
          type: "number",
        })
        .option("ytdlp-concurrency", {
          describe: "Maximum number of concurrent transcript downloads (default: 2)",
          type: "number",
        })
        .option("retry-delays", {
          describe: "Comma-separated retry delays in seconds (default: 10,30,60)",
          type: "string",
        })
        .option("max-output-tokens", {
          describe: "Override the computed output token budget",
          type: "number",
        })
        .option("chunk-target-tokens", {
          describe: "Target input tokens per chunk when a transcript is split (default: 8000)",
          type: "number",
        })
        .option("reasoning", {
          describe: "Reasoning effort: provider-default, none, minimal, low, medium, high or xhigh (default: low)",
          type: "string",
        })
        .option("force", {
          describe: "Regenerate every Markdown file",
          type: "boolean",
          default: false,
        }),
    handle(async (argv) => {
      const { feed, settings, dir } = project(argv);
      await runGenerateMarkdown({ feed, ...settings, dir, force: argv.force });
    }),
  )
  .command(
    "markdown-stats",
    "Report global tokens, cost and time from the Markdown frontmatter",
    () => {},
    handle(async (argv) => {
      const { dir } = project(argv);
      await runMarkdownStats({ dir });
    }),
  )
  .command(
    "reorganize",
    "Move the transcripts and Markdown into their folder_slug folders",
    (yargs) =>
      yargs.option("dry-run", {
        describe: "Show the moves without doing them",
        type: "boolean",
        default: false,
      }),
    handle(async (argv) => {
      const { feed, dir } = project(argv);
      await runReorganize({ feed, dir, dryRun: argv.dryRun });
    }),
  )
  .command(
    "doctor",
    "Check the runtime dependencies and the LLM access",
    (yargs) =>
      yargs
        .option("model", {
          describe: "LLM model id to test (default: model_id in the configuration)",
          type: "string",
        })
        .option("endpoint", {
          describe: "OpenAI-compatible chat completions endpoint to test",
          type: "string",
        })
        .option("api-key", {
          describe: "API key to test (defaults to OPENAI_API_KEY)",
          type: "string",
        })
        .option("session", {
          describe: "Value of the X-OpenCode-Session header",
          type: "string",
        })
        .option("reasoning", {
          describe: "Reasoning effort to test (default: low)",
          type: "string",
        })
        .option("llm", {
          describe: "Run a minimal LLM request to test the API access",
          type: "boolean",
          default: true,
        })
        .option("timeout", {
          describe: "Timeout in seconds for the LLM request (default: 30)",
          type: "number",
          default: 30,
        }),
    handle(async (argv) => {
      await runDoctor({
        configPath: argv.config,
        overrides: {
          model: argv.model,
          endpoint: argv.endpoint,
          apiKey: argv.apiKey,
          session: argv.session,
          reasoning: argv.reasoning,
        },
        llm: argv.llm,
        timeoutMs: argv.timeout * 1000,
      });
    }),
  )
  .command(
    "completion",
    "Generate a shell completion script for bash or zsh",
    () => {},
    () => cli.showCompletionScript("youtube-to-markdown", "completion"),
  )
  .demandCommand(
    1,
    "Use one of the available commands, or run `youtube-to-markdown doctor` " +
      "first.",
  )
  .strictCommands()
  .recommendCommands()
  .version(version)
  .help();

cli.parse();
