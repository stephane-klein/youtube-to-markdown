# youtube-feed-to-markdown

The `youtube-to-markdown` CLI generates Markdown files from YouTube video
transcripts.

I use it to search through the content of popular-science videos and shows of
all kinds. I also use it to feed that corpus into a RAG.

Technically, it is fairly simple: the project relies on
[yt-dlp](https://github.com/yt-dlp/yt-dlp) to fetch the metadata of a YouTube
channel or playlist and then to download its transcripts.

In the final step, I use an LLM through a standard OpenAI-compatible API to
reconstruct a complete text from the video transcripts.

## AI usage in this project

This project was developed using:

- Harness: [OpenCode](https://opencode.ai)
- Models: [DeepSeek-V4.1-Flash](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash) via [OpenCode Go](https://opencode.ai/go)
- I mostly vibe coded this project: I made the implementation, library and architecture choices, but I reviewed the code very little.

The figures below cover the period from the start of the project to version 0.4.0
([de39801](https://github.com/stephane-klein/youtube-to-markdown/commit/de39801f123fa1cfaeaa3b9cfed5071968977474)).

Metrics:

- 16 OpenCode sessions, 1426 interactions;
- 11 h of human time on this project, against 4 h of AI generation time over the same period, so a human/AI time ratio of 2.75 (11 h / 4 h);
- Cost: $2.4958;
- Tokens:
  - input: 7,047,916
  - output: 421,770
  - cache read: 228,841,600
  - total: 236,311,286

Per agent:

| agent   | interactions | share | output tokens | active hours | active share | generation hours | cost   |
|:--------|-------------:|------:|--------------:|-------------:|-------------:|-----------------:|-------:|
| build   |          962 |   68% |       259,706 |         3.71 |          38% |             1.93 | $1.385 |
| plan    |          450 |   32% |       155,136 |         5.91 |          61% |             2.10 | $1.098 |
| explore |           14 |    1% |         6,928 |         0.02 |           0% |             0.02 | $0.013 |


## Requirements

- Node.js 22 or later;
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) on your `PATH`.

The commands call yt-dlp with `--js-runtimes node`: solving YouTube's JavaScript
challenges requires an external JavaScript runtime, and Node.js — already
required here — does the job.

## Install

The package is published on npmjs as `@stephane-klein/youtube-to-markdown`.
Install it globally to get the `youtube-to-markdown` command on your `PATH`:

```sh
$ npm install -g @stephane-klein/youtube-to-markdown
```

Or run it without installing it, with `npx`:

```sh
$ npx @stephane-klein/youtube-to-markdown extract-video-metadata
```

Either way, `yt-dlp` must be on your `PATH` (see Requirements).

Run `youtube-to-markdown --help` to list the available commands:

```sh
$ youtube-to-markdown --help
youtube-to-markdown <command>

Commands:
  extract-video-metadata  Fetch the videos of each feed source (channel or
                          playlist) from YouTube into the configuration file
  download-vtt            Download the VTT transcripts of the marked videos
  generate-markdown       Turn the VTT transcripts into Markdown prose with an
                          LLM
  markdown-stats          Report global tokens, cost and time from the Markdown
                          frontmatter
  reorganize              Move the transcripts and Markdown into their
                          folder_slug folders
  doctor                  Check the runtime dependencies and the LLM access
  completion              Generate a shell completion script for bash or zsh

Options:
  --config   Path to the YAML configuration file
                                  [string] [default: "youtube_to_markdown.yaml"]
  --version  Show version number                                       [boolean]
  --help     Show help                                                 [boolean]
```

Install the shell completion for bash or zsh (`$SHELL` selects the script):

```sh
$ youtube-to-markdown completion >> ~/.zshrc
```

Use `~/.bashrc` on bash.

## Getting started

**1. Create `youtube_to_markdown.yaml`** with the LLM settings and your sources.
The example below uses [OpenCode Go](https://opencode.ai/en/go), an OpenAI-compatible API:

```yaml
x_opencode_session: "youtube-to-markdown/0.1"
model_id: "mimo-v2.5"
openaiapi_endpoint: "https://opencode.ai/zen/go/v1/chat/completions"
feed:
  - title: Science4All
    url: https://www.youtube.com/@le_science4all
    videos: []
```

Only the `url` is required: `extract-video-metadata` fills the titles, the dates
and the video lists. `model_id` and `openaiapi_endpoint` are not specific to
OpenCode Go — point them at any OpenAI-compatible provider. The other settings
are documented below.

**2. Store your API key** in `.secret.sh` and source it. Write it with your editor
so the key never lands in your shell history:

```sh
$ $EDITOR .secret.sh
$ cat .secret.sh
export OPENAI_API_KEY="sk-…"
$ source .secret.sh
```

**3. Check the setup** with `doctor` and fix every `error` (a `warn` is fine):

```sh
$ youtube-to-markdown doctor
node      v24.21.0                                        ok
yt-dlp    2026.08.19                                      ok
config    youtube_to_markdown.yaml                        ok (2 channel(s), 636 video(s))
contents  contents                                        ok
model     mimo-v2.5                                       ok
endpoint  https://opencode.ai/zen/go/v1/chat/completions  ok
api key   OPENAI_API_KEY                                  ok
session   set                                             info
pricing   models.dev                                      ok ($0.14 in / $0.28 out / $0.0028 cached per 1M)
llm       1.0s                                            ok (248 in / 8 out)

summary: 9 ok, 0 warning, 0 error
```

`doctor` exits with a non-zero status as soon as one line is an `error`, so it
can gate a CI job.

**4. Fetch the source videos** into the file:

```sh
$ youtube-to-markdown extract-video-metadata
→ https://www.youtube.com/@le_science4all
  exact dates 50/2217  2.4s elapsed  ~1m 44s left
  exact dates 100/2217  4.8s elapsed  ~1m 42s left
  exact dates 2217/2217  1m 46s elapsed
  done in 1m 46s
→ https://www.youtube.com/@MonsieurPhi
  done in 12.3s
summary: 2 sources, 2678 videos, 2m 05s elapsed
```

The command is idempotent: a new run only adds the missing videos.

**5. Generate the Markdown** with `download-vtt`, then `generate-markdown`. The
other commands are `markdown-stats`, `reorganize` and `doctor`; run
`youtube-to-markdown <command> --help` for their options.

## Configure the settings and the sources

The commands read `youtube_to_markdown.yaml` from the current directory; override
it with `--config` or `YT_TO_MD_CONFIG`. It holds the settings and the sources.
Settings resolve in this order: command-line flags, then `YT_TO_MD_*` environment
variables, then the settings written in the YAML file, then the built-in
defaults. The API key stays a secret: `--api-key` or `OPENAI_API_KEY`. The
settings are `x_opencode_session`, `model_id`, `openaiapi_endpoint`,
`concurrency` and `ytdlp_concurrency` (plus the optional `api_key`,
`retry_delays`, `max_output_tokens` and `chunk_target_tokens`). I only set the
source URLs, and the `extract-video-metadata` command fills the rest:

`x_opencode_session` is the base of the `X-OpenCode-Session` header; it is
optional and specific to OpenCode. A stable per-video suffix is appended to it,
so each video is routed as its own conversation. `model_id` and
`openaiapi_endpoint` are not: point them at any OpenAI-compatible provider.

```yaml
x_opencode_session: "youtube-to-markdown/0.1"
model_id: "mimo-v2.5"
openaiapi_endpoint: "https://opencode.ai/zen/go/v1/chat/completions"
concurrency: "6"
ytdlp_concurrency: "2"
feed:
  - title: Science4All
    folder_slug: science-4-all
    url: https://www.youtube.com/@le_science4all
    videos:
      - title:
          fr: Pourquoi π est-il si fou ? Relativité 1
          en: Why is π so crazy? Relativity 1
        date: 2016-02-12
        url: https://www.youtube.com/watch?v=PxRPpdzmbUQ
  - title: MrPhi
    url: https://www.youtube.com/@MonsieurPhi
    videos: []
```

`contents_path` (optional) chooses the directory that holds the transcripts and
the generated Markdown. It accepts an absolute path or a path relative to the
directory of `youtube_to_markdown.yaml`; it defaults to `contents`. Unlike the
other settings, it can only be set in the YAML file — there is no flag or
environment variable for it. `.gitignore` only ignores the default `contents/`,
so add your own path there if you move it.

`folder_slug` (optional, on a feed entry) stores that source's transcripts and
Markdown in a subdirectory of `contents_path`, for example `science-4-all`.
It is a relative path, so it stays inside `contents_path`; a source without
`folder_slug` keeps its files at the root of `contents_path`. The reserved name
`_orphans` is rejected. Change it whenever you like, then run
`youtube-to-markdown reorganize` to move the existing files.

## Playlists

A feed entry can point to a YouTube playlist instead of a channel:

```yaml
feed:
  - title: Contre-histoire de la philosophie, vol. 9
    folder_slug: contre-histoire-philo-9
    url: https://www.youtube.com/playlist?list=OLAK5uy_lEyjyS840R2OkHNVgOt1fGjPzeBTs1xKI
    videos: []
```

The commands detect a playlist from its URL (the `/playlist` path);
`extract-video-metadata` uses it as is instead of resolving the channel uploads
playlist. `title` is filled with the playlist title when it is empty, and the
videos keep the playlist order instead of being sorted by date. Each video gets
an `index` field (`1`, `2`, …) which becomes the filename prefix:
`contents/contre-histoire-philo-9/1-2019-01-04_quel-xixeme-siecle-i-un-temps-nouveau.fr.vtt`.
The `index` field is written by `extract-video-metadata`; do not edit it by
hand. A video removed from the playlist is kept as an extra, without `index`,
at the end of the list.

## Download the transcripts of the videos

I mark the videos I want as transcripts with a `download_vtt` field:

```yaml
  - title:
      fr: Pourquoi π est-il si fou ? Relativité 1
      en: Why is π so crazy? Relativity 1
    date: 2016-02-12
    url: https://www.youtube.com/watch?v=PxRPpdzmbUQ
    download_vtt:
      fr: true
```

Then:

```sh
$ youtube-to-markdown download-vtt
21 transcript(s) to check
[ 1/21] downloaded         2016-07-14_le-sol-accelere-t-il-vraiment-vers-le-haut-debattonsmieux.fr.vtt
[ 2/21] already downloaded 2016-08-25_les-synonymes-a-connotations-opposees-debattonsmieux.fr.vtt
[ 3/21] missing            2017-06-26_favoriser-l-honnetete-democratie-18.fr.vtt
…
summary: 1 downloaded, 1 already downloaded, 1 missing, 0 error
```

For each marked video, the command writes the subtitle to
`contents/<date>_<slug>.<lang>.vtt`, for example
`contents/2016-02-12_pourquoi-est-il-si-fou-relativite-1.fr.vtt`. It prefers
manual subtitles and falls back to the auto-generated ones. A file that already
exists is left untouched, so running the command again only fetches new
transcripts. The `extract-video-metadata` command keeps the `download_vtt`
field.

When a video has no subtitle at all, the command writes a `<…>.vtt.missing`
marker and stops trying. I delete that marker to force a new attempt.

## Generate Markdown text from the transcripts

I mark the videos I want as Markdown with `generate_markdown`. The transcript is
downloaded first if it is not there yet:

```yaml
    download_vtt:
      fr: true
    generate_markdown:
      fr: true
```

Before the first run, provide your API key through the `OPENAI_API_KEY`
environment variable, or pass it with `--api-key`.

Then:

```sh
$ youtube-to-markdown generate-markdown
74 markdown(s) to generate with mimo-v2.5
✔ Download transcripts (73/74)
  › downloaded  2017-08-04_nietzsche-la-morale-des-winners-genealogie-de-la-morale-1-2.fr.md
  › skipped (no transcript)  2017-06-26_favoriser-l-honnetete-democratie-18.fr.md
✔ Generate markdown (73/74, 37 already)
  › generated  2017-10-13_le-scepticisme-le-trilemme-d-agrippa-grain-de-philo-14-ep-2.fr.md  mimo-v2.5  llm 87.1s  4428 in / 3262 out  ~$0.000927
  …
summary: 36 generated, 37 already generated, 1 skipped, 0 error
total: 3135.6s, 159408 in / 117432 out, ~$0.033372
```

The command sends each transcript to an LLM through ai-sdk, configured with the
API key (`OPENAI_API_KEY` or `--api-key`), the model (`YT_TO_MD_MODEL_ID` or
`--model`) and the endpoint (`YT_TO_MD_OPENAIAPI_ENDPOINT` or `--endpoint`), and
gets back Markdown prose with section headings when the talk needs them.
Paragraphs are hard-wrapped at 80 columns. The result goes to
`contents/<date>_<slug>.<lang>.md`. A second run reports `already generated` and
writes nothing.

The command runs in two sequential phases. `Download transcripts` reports how many
videos have a transcript (`available/total`) and fetches the missing ones, at
most `--ytdlp-concurrency` at a time (default 2); only downloads, skips and errors
are listed. The `Generate markdown` phase then converts the transcripts, at most
`--concurrency` at a time (default 6), reporting the number of up-to-date
Markdown files over the whole feed (`ready/total, N already`). Each phase keeps
only the last 20 events on screen, so it stays bounded even with a large feed.

Retryable API errors (HTTP 408, 409, 429 or >= 500) are retried with growing
delays — 10 s, 30 s, 60 s by default, configurable with `--retry-delays`
(comma-separated seconds, or `YT_TO_MD_RETRY_DELAYS`). A `Retry-After` header
from the server is honored when longer than the schedule. Each retry is shown in
the phase output; after the last attempt the file is reported as an error and is
retried on the next run.

### Output budget and long transcripts

The model must rewrite the whole transcript, so the command asks it for roughly
twice the input size (`maxOutputTokens`). That budget is capped per call: the
command reads the model's advertised output limit from the pricing catalogs and
uses it as the ceiling; if the catalog has no entry it falls back to 32768
tokens. `--max-output-tokens` (or `YT_TO_MD_MAX_OUTPUT_TOKENS`) overrides the
ceiling by hand.

When the projected output would exceed the ceiling — a long video on a model
with a small output limit — the transcript is split into chunks that each fit
the budget, generated independently, then stitched together: immediately
repeated headings are dropped and each junction is smoothed by a small extra
LLM call that rewrites the beginning of the next section so it flows from the
previous one. `--chunk-target-tokens` (or `YT_TO_MD_CHUNK_TARGET_TOKENS`,
default 8000) sets the target input size of each chunk. The generation of a
chunk is guaranteed to stop with `stop`; otherwise the file is reported as an
error and nothing is written. The frontmatter records how many chunks were used.

### Generated frontmatter

Each generated file starts with a YAML frontmatter describing the run:

```yaml
---
source_url: https://www.youtube.com/watch?v=PxRPpdzmbUQ
video_title: Pourquoi π est-il si fou ? Relativité 1
generated_at: 2026-09-19T10:12:33.456Z
llm:
  model: mimo-v2.5
  chunks: 1
  duration_seconds: 87.1
  input_tokens: 4428
  cached_input_tokens: 0
  output_tokens: 3262
  estimated_cost_usd: 0.000927
  finish_reason: stop
  pricing:
    source: models.dev
    peak: null
---
```

`video_title` is the original video title in the file's language and
`generated_at` is the UTC time of the generation. `pricing.source` names the
catalog the rates came from and `pricing.peak` tells whether the peak rate
applied to the first call (`null` when the source has no peak/off-peak pricing).
Existing files are left untouched: run `youtube-to-markdown generate-markdown
--force` to regenerate every file, which is also the way to add the frontmatter
to files generated before it existed.

### Pricing

The estimated cost uses rates fetched at run time from
[models.dev](https://models.dev) and
[LiteLLM](https://github.com/BerriAI/litellm). The provider is resolved from
`openaiapi_endpoint`; LiteLLM is preferred when it prices the model, because it
carries DeepSeek's peak/off-peak windows, otherwise models.dev is used. Both
catalogs are cached for one day under `$XDG_CACHE_HOME/youtube-to-markdown`
(`~/.cache/youtube-to-markdown` by default). When a catalog or the model is
unavailable, `estimated_cost_usd` is `null` and the run continues.

The rate is sampled at the start of every LLM call, so a run that straddles a
peak/off-peak boundary is priced with the right rate on each side. The
`pricing` block in the frontmatter describes the first call of the file.

## Organize the files into folders

A channel may set `folder_slug` to keep its files in their own subdirectory of
`contents_path`. When you add, change or remove that setting, `reorganize` moves
the already downloaded transcripts and generated Markdown to match. It runs for
real by default; add `--dry-run` to preview:

```sh
$ youtube-to-markdown reorganize --dry-run
[ 1/38] moved     science-4-all/2016-07-14_le-sol-accelere….fr.vtt (dry run)
…
dry run: no file was moved
summary: 38 to move, 0 to orphan, 112 already in place, 0 conflict
```

A file that no longer matches any video of the feed is an orphan: the command
moves it under `contents_path/_orphans/`, keeping its relative path. A file whose
target already exists, or a filename shared by two channels with different
`folder_slug`, is reported as a conflict and left untouched.

## Report the tokens, cost and time

`markdown-stats` reads the frontmatter of every `*.md` under `contents_path`
(recursively) and prints global totals — tokens, estimated cost, processing
time — with a breakdown per model, per language and per folder (`folder_slug`,
or `(root)` when the file sits at the root of `contents_path`):

```sh
$ youtube-to-markdown markdown-stats
contents/ — 43 file(s)
  with frontmatter     3
  without frontmatter  40

tokens
  input                16,134
  cached input         16,000
  output               14,486
  total                30,620

cost
  estimated            $0.004120
  unknown prices       0 file(s)

processing time
  total                395.6s
  mean                 131.9s
  min / max            111.8s / 165.3s

generated_at
  first                2026-09-19T08:56:54.497Z
  last                 2026-09-19T08:57:47.976Z

models
  mimo-v2.5           3 file(s)     16,134 in /    14,486 out  $0.004120

languages
  fr                  3 file(s)     16,134 in /    14,486 out  $0.004120

folders
  science-4-all       2 file(s)     10,134 in /     9,486 out  $0.002120
  (root)              1 file(s)      6,000 in /     5,000 out  $0.002000
```

Files without frontmatter (generated before the frontmatter existed) are counted
but left out of the totals.

## Set up the development environment

To work on this project, [mise](https://mise.jdx.dev/) installs both yt-dlp and
Node.js; `npm install` fetches the JavaScript dependencies:

```sh
$ mise install
$ npm install
```

The `enter` hook defines a `youtube-to-markdown` shell function that calls
`node src/cli.js`, and loads the shell completion for bash and zsh; the `leave`
hook removes both. Everything is set when you enter the project from an
interactive bash or zsh shell, so it is only available in interactive shells; in
scripts and CI, call `node src/cli.js <command>` instead. A function, rather than
a shell alias, is what lets `youtube-to-markdown <TAB>` complete the subcommands:
zsh expands aliases before dispatching completion, which would bypass `compdef`.

To generate Markdown without exporting `OPENAI_API_KEY` in your shell, copy
`.secret.sh.example` to `.secret.sh` and put your API key in it; mise sources
that file automatically:

```sh
$ cp .secret.sh.example .secret.sh
$ $EDITOR .secret.sh
```

## Publish the package to npmjs

I publish the package to npmjs from this repository with mise:

```sh
$ npm login
$ npm version patch
$ mise run publish-to-npmjs
```

`npm login` authenticates against npmjs, once per machine. `npm version patch`
bumps the version and creates the matching git tag (use `minor` or `major` for
larger changes). `mise run publish-to-npmjs` first checks the authentication with
`npm whoami`, then runs `npm publish`; it publishes the version written in
`package.json`, so bump it first. The package is scoped, so `publishConfig` in
`package.json` forces public access.

