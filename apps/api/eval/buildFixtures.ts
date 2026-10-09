import { readdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { OcrResult } from "@prelude/shared";

const REPORTS = new URL("../../../docs/reports/", import.meta.url);
const OUT = new URL("./fixtures/", import.meta.url);

export function slugFor(filename: string): string {
  return filename.replace(/\.(pdf|jpe?g|png)$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
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

const IMAGE_MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

// Images have no text layer, so they go through the configured OCR provider (a cloud call).
// A key saved as <slug>.expected.json.pending-ocr is activated once its fixture exists.
async function buildImageFixture(file: string): Promise<void> {
  const ext = file.split(".").pop()!.toLowerCase();
  try {
    const { getOcrProvider } = await import("../src/services/providerFactory");
    const bytes = Buffer.from(await Bun.file(fileURLToPath(new URL(file, REPORTS))).arrayBuffer());
    const ocr = await getOcrProvider().extractText(bytes, IMAGE_MIME[ext]!);
    const slug = slugFor(file);
    await Bun.write(new URL(`${slug}.ocr.json`, OUT), JSON.stringify({ ...ocr, providerRaw: null }, null, 2));
    const pending = new URL(`${slug}.expected.json.pending-ocr`, OUT);
    if (await Bun.file(pending).exists()) await rename(fileURLToPath(pending), fileURLToPath(new URL(`${slug}.expected.json`, OUT)));
    console.log(`${file} -> ${slug}.ocr.json via ${ocr.providerName} (${ocr.pages.length} pages)`);
  } catch (err) {
    console.warn(`SKIPPED ${file}: ${err instanceof Error ? err.message : err} (set OCR_PROVIDER and its credentials to include images)`);
  }
}

if (import.meta.main) {
  const all = await readdir(REPORTS);
  const pdfs = all.filter((f) => f.toLowerCase().endsWith(".pdf")).sort();
  const images = all.filter((f) => /\.(jpe?g|png)$/i.test(f)).sort();
  if (pdfs.length + images.length === 0) throw new Error(`No reports in ${REPORTS.pathname}`);
  for (const image of images) await buildImageFixture(image);
  for (const pdf of pdfs) {
    const path = fileURLToPath(new URL(pdf, REPORTS));
    const text = await Bun.$`pdftotext -layout ${path} -`.text();
    const ocr = toOcrResult(text);
    await Bun.write(new URL(`${slugFor(pdf)}.ocr.json`, OUT), JSON.stringify(ocr, null, 2));
    console.log(`${pdf} -> ${slugFor(pdf)}.ocr.json (${ocr.pages.length} pages)`);
  }
}
