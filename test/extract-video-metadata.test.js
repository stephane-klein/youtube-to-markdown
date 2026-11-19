import { test } from "node:test";
import assert from "node:assert/strict";
import { isShort } from "../src/extract-video-metadata.js";

test("isShort matches a watch URL whose id is a known short", () => {
  const shortIds = new Set(["kX6wJ6P8vhE"]);
  assert.equal(
    isShort("https://www.youtube.com/watch?v=kX6wJ6P8vhE", shortIds),
    true,
  );
});

test("isShort keeps a watch URL that is not a known short", () => {
  const shortIds = new Set(["kX6wJ6P8vhE"]);
  assert.equal(
    isShort("https://www.youtube.com/watch?v=PxRPpdzmbUQ", shortIds),
    false,
  );
});

test("isShort matches a /shorts/ URL without the id set", () => {
  assert.equal(
    isShort("https://www.youtube.com/shorts/kX6wJ6P8vhE", new Set()),
    true,
  );
});

test("isShort ignores an empty URL", () => {
  assert.equal(isShort(undefined, new Set()), false);
});
