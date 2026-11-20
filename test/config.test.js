import assert from "node:assert/strict";
import test from "node:test";
import { loadEnv, resolveContentsDir } from "../src/config.js";

test("loadEnv reads the contents path from YT_TO_MD_CONTENTS_PATH", () => {
  const env = loadEnv({ YT_TO_MD_CONTENTS_PATH: "/var/lib/yt-artifacts" });
  assert.equal(env.contentsPath, "/var/lib/yt-artifacts");
});

test("resolveContentsDir falls back to contents next to the configuration", () => {
  assert.equal(
    resolveContentsDir({ configDir: "/project/config" }),
    "/project/config/contents",
  );
});

test("resolveContentsDir uses contents_path from the configuration", () => {
  assert.equal(
    resolveContentsDir({
      configDir: "/project/config",
      config: { contents_path: "artifacts" },
    }),
    "/project/config/artifacts",
  );
});

test("resolveContentsDir prefers the override over the configuration", () => {
  assert.equal(
    resolveContentsDir({
      configDir: "/project/config",
      override: "out",
      config: { contents_path: "artifacts" },
    }),
    "/project/config/out",
  );
});

test("resolveContentsDir keeps an absolute override", () => {
  assert.equal(
    resolveContentsDir({
      configDir: "/project/config",
      override: "/srv/yt-artifacts",
      config: { contents_path: "artifacts" },
    }),
    "/srv/yt-artifacts",
  );
});
