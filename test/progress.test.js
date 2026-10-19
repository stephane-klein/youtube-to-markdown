import assert from "node:assert/strict";
import test from "node:test";
import { formatDuration, progressLine, progressStats } from "../src/progress.js";

test("formatDuration switches between milliseconds, seconds, minutes and hours", () => {
  assert.equal(formatDuration(0), "0ms");
  assert.equal(formatDuration(850), "850ms");
  assert.equal(formatDuration(1200), "1.2s");
  assert.equal(formatDuration(125000), "2m 05s");
  assert.equal(formatDuration(3780000), "1h 03m");
});

test("progressStats extrapolates the remaining time linearly", () => {
  assert.deepEqual(
    progressStats({ done: 50, total: 200, startedAt: 0, now: 10000 }),
    { elapsed: 10000, eta: 30000 },
  );
  assert.deepEqual(
    progressStats({ done: 200, total: 200, startedAt: 0, now: 10000 }),
    { elapsed: 10000, eta: 0 },
  );
  assert.deepEqual(
    progressStats({ done: 0, total: 200, startedAt: 0, now: 10000 }),
    { elapsed: 10000, eta: null },
  );
});

test("progressLine reports the elapsed time and the remaining time", () => {
  assert.equal(
    progressLine({
      label: "exact dates",
      done: 50,
      total: 200,
      startedAt: 0,
      now: 10000,
    }),
    "  exact dates 50/200  10.0s elapsed  ~30.0s left",
  );
  assert.equal(
    progressLine({
      label: "exact dates",
      done: 200,
      total: 200,
      startedAt: 0,
      now: 10000,
    }),
    "  exact dates 200/200  10.0s elapsed",
  );
});
