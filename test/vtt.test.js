import assert from "node:assert/strict";
import test from "node:test";
import { videoJobs } from "../src/vtt.js";

const video = (overrides = {}) => ({
  url: "https://www.youtube.com/watch?v=test",
  date: "2026-10-18",
  title: "17 octobre : Macron joue le pourrissement",
  download_vtt: { fr: true },
  ...overrides,
});

test("videoJobs exposes dialogue settings and the labelled path", () => {
  const [job] = videoJobs(
    video({ dialogue: true, speakers: ["Journaliste"] }),
    "/contents",
    "jean-luc-melenchon",
  );
  assert.equal(job.dialogue, true);
  assert.deepEqual(job.speakers, ["Journaliste"]);
  assert.equal(
    job.labeled,
    "/contents/jean-luc-melenchon/2026-10-18_17-octobre-macron-joue-le-pourrissement.fr.dialogue.md",
  );
});

test("videoJobs rejects an invalid dialogue flag", () => {
  assert.throws(
    () => videoJobs(video({ dialogue: "yes" }), "/contents"),
    /dialogue must be a boolean/,
  );
});

test("videoJobs rejects invalid speakers", () => {
  assert.throws(
    () => videoJobs(video({ speakers: "Journaliste" }), "/contents"),
    /speakers must be an array/,
  );
});
