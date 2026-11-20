import { readFile } from "node:fs/promises";
import { extractText, getDocumentProxy } from "unpdf";

function normalizeText(text) {
  return `${text ?? ""}`
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function comparable(text) {
  return `${text ?? ""}`
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The first line of a PDF transcript often repeats the video title. Remove it
// only when the two strings clearly match, so a real first sentence stays.
export function stripLeadingTitle(text, title = "") {
  const lines = `${text ?? ""}`.split("\n");
  let index = 0;
  while (index < lines.length && !lines[index].trim()) index++;

  const first = lines[index]?.trim() ?? "";
  if (first.length < 10) return text;

  const candidate = comparable(first);
  const expected = comparable(title);
  if (!candidate || !expected || expected.length < 10) return text;

  const match =
    candidate === expected ||
    expected.startsWith(candidate) ||
    candidate.startsWith(expected);
  if (!match) return text;

  lines.splice(index, 1);
  return lines.join("\n").replace(/^\s+/, "");
}

export async function extractPdfText(path, { title = "" } = {}) {
  let data;
  try {
    data = new Uint8Array(await readFile(path));
  } catch (error) {
    throw new Error(`cannot read transcript PDF ${path}: ${error.message}`);
  }

  let text;
  let pages;
  try {
    const pdf = await getDocumentProxy(data);
    const result = await extractText(pdf, { mergePages: true });
    text = result.text;
    pages = result.totalPages;
  } catch (error) {
    throw new Error(
      `cannot extract text from transcript PDF ${path}: ${error.message}`,
    );
  }

  const cleaned = normalizeText(
    stripLeadingTitle(normalizeText(text), title),
  );
  if (!cleaned) {
    throw new Error(
      `transcript PDF ${path} has no text layer (scanned document? OCR is not supported)`,
    );
  }

  return { text: cleaned, pages };
}
