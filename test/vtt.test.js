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

test("videoJobs builds a PDF-only job", () => {
  const [job] = videoJobs(
    video({
      download_vtt: undefined,
      generate_markdown: { fr: true },
      transcript_pdf: { fr: "raws/test.pdf" },
    }),
    "/contents",
  );
  assert.equal(job.source, "pdf");
  assert.equal(job.pdf, "raws/test.pdf");
  assert.equal(job.downloadVtt, false);
  assert.equal(job.generate, true);
  assert.equal(
    job.base,
    "/contents/2026-10-18_17-octobre-macron-joue-le-pourrissement.fr",
  );
});

test("videoJobs does not generate a PDF without generate_markdown", () => {
  const [job] = videoJobs(
    video({
      download_vtt: undefined,
      transcript_pdf: { fr: "raws/test.pdf" },
    }),
    "/contents",
  );
  assert.equal(job.source, "pdf");
  assert.equal(job.generate, false);
});

test("videoJobs gives the PDF precedence for the same language", () => {
  const [job] = videoJobs(
    video({
      download_vtt: { fr: true },
      generate_markdown: { fr: true },
      transcript_pdf: { fr: "raws/test.pdf" },
    }),
    "/contents",
  );
  assert.equal(job.source, "pdf");
  assert.equal(job.pdf, "raws/test.pdf");
  assert.equal(job.downloadVtt, true);
});

test("videoJobs computes generate per language", () => {
  const jobs = videoJobs(
    video({
      download_vtt: { fr: true, en: true },
      generate_markdown: { fr: true },
    }),
    "/contents",
  );
  assert.deepEqual(
    jobs.map((job) => [job.lang, job.generate]),
    [
      ["fr", true],
      ["en", false],
    ],
  );
});

test("videoJobs rejects an invalid transcript_pdf path", () => {
  assert.throws(
    () => videoJobs(video({ transcript_pdf: { fr: true } }), "/contents"),
    /transcript_pdf.fr must be a non-empty path/,
  );
});

test("videoJobs rejects a transcript_pdf that is not an object", () => {
  assert.throws(
    () => videoJobs(video({ transcript_pdf: "raws/test.pdf" }), "/contents"),
    /transcript_pdf must be an object/,
  );
});
