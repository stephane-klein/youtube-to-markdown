import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { extractPdfText, stripLeadingTitle } from "../src/pdf.js";

const fixture = fileURLToPath(
  new URL("./fixtures/simple.pdf", import.meta.url),
);

test("extractPdfText reads accents and line breaks", async () => {
  const { text, pages } = await extractPdfText(fixture);
  assert.equal(pages, 1);
  assert.equal(text, "Bonjour à tous.\nDeuxième ligne.");
});

test("stripLeadingTitle removes a title repeated at the top of the PDF", () => {
  assert.equal(
    stripLeadingTitle(
      "Example Channel – Example episode\nBonjour à tous.",
      "Example Channel - Example episode: a subtitle",
    ),
    "Bonjour à tous.",
  );
});

test("stripLeadingTitle keeps an unrelated first line", () => {
  assert.equal(
    stripLeadingTitle("Bonjour à tous.\nDeuxième ligne.", "Un titre"),
    "Bonjour à tous.\nDeuxième ligne.",
  );
});

test("extractPdfText reports a missing file", async () => {
  await assert.rejects(
    () => extractPdfText("/nonexistent/transcript.pdf"),
    /cannot read transcript PDF/,
  );
});
