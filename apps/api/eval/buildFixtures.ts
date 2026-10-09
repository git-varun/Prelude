import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { OcrResult } from "@prelude/shared";

const REPORTS = new URL("../../../docs/reports/", import.meta.url);
const OUT = new URL("./fixtures/", import.meta.url);

export function slugFor(filename: string): string {
  return filename.replace(/\.pdf$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// pdftotext separates pages with form feeds.
export function toOcrResult(text: string): OcrResult {
  const pages = text.split("\f").map((t, i) => ({ pageNumber: i + 1, text: t }));
  while (pages.length > 0 && pages[pages.length - 1]!.text.trim() === "") pages.pop();
  return {
    fullText: pages.map((p) => p.text).join("\n"),
    pages,
    providerName: "pdftotext",
    providerRaw: null,
  };
}

if (import.meta.main) {
  const pdfs = (await readdir(REPORTS)).filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  if (pdfs.length === 0) throw new Error(`No PDFs in ${REPORTS.pathname}`);
  for (const pdf of pdfs) {
    const path = fileURLToPath(new URL(pdf, REPORTS));
    const text = await Bun.$`pdftotext -layout ${path} -`.text();
    const ocr = toOcrResult(text);
    await Bun.write(new URL(`${slugFor(pdf)}.ocr.json`, OUT), JSON.stringify(ocr, null, 2));
    console.log(`${pdf} -> ${slugFor(pdf)}.ocr.json (${ocr.pages.length} pages)`);
  }
}
