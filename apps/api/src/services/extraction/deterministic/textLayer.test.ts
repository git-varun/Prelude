import { test, expect } from "bun:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractTextLayer, groupItemsIntoLines } from "./textLayer";

async function makePdf(draw: (page: import("pdf-lib").PDFPage, font: import("pdf-lib").PDFFont) => void): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  draw(doc.addPage([595, 842]), font);
  return await doc.save();
}

test("columns become cells and a slightly offset cell stays on its row", async () => {
  const pdf = await makePdf((p, f) => {
    const t = (text: string, x: number, y: number) => p.drawText(text, { x, y, size: 9, font: f });
    t("Haemoglobin", 40, 700); t("10.1", 300, 700); t("g/dL", 380, 700); t("13.0-17.0", 460, 700);
    t("Total Leukocyte Count", 40, 680); t("7.4", 300, 680); t("10^3/uL", 380, 680); t("4.0-10.0", 460, 682.5);
  });
  const [page] = await extractTextLayer(pdf);
  const rows = page!.lines.map((l) => l.cells.map((c) => c.text));
  expect(rows).toEqual([
    ["Haemoglobin", "10.1", "g/dL", "13.0-17.0"],
    ["Total Leukocyte Count", "7.4", "10^3/uL", "4.0-10.0"],
  ]);
});

test("per-character (letter-spaced) text merges into words", async () => {
  const pdf = await makePdf((p, f) => {
    let x = 40;
    for (const ch of "Sample Collected") {
      const w = f.widthOfTextAtSize(ch, 9);
      if (ch !== " ") p.drawText(ch, { x, y: 700, size: 9, font: f });
      x += ch === " " ? 3.5 : w + 1.0;
    }
    p.drawText("12/Dec/2024", { x: 300, y: 700, size: 9, font: f });
  });
  const [page] = await extractTextLayer(pdf);
  expect(page!.lines).toHaveLength(1);
  expect(page!.lines[0]!.cells.map((c) => c.text)).toEqual(["Sample Collected", "12/Dec/2024"]);
});

test("a page with no text reports no text layer; a short page is also below the threshold", async () => {
  const blank = await makePdf(() => {});
  const short = await makePdf((p, f) => p.drawText("Hb 10.1", { x: 40, y: 700, size: 9, font: f }));
  const [b] = await extractTextLayer(blank);
  const [s] = await extractTextLayer(short);
  expect(b).toMatchObject({ charCount: 0, hasTextLayer: false, lines: [] });
  expect(s!.charCount).toBeGreaterThan(0);
  expect(s!.hasTextLayer).toBe(false);
});

test("groupItemsIntoLines orders rows top to bottom and cells left to right", () => {
  const lines = groupItemsIntoLines(
    [
      { str: "b", x: 200, y: 100, w: 5, h: 9 },
      { str: "a", x: 20, y: 100, w: 5, h: 9 },
      { str: "top", x: 20, y: 300, w: 15, h: 9 },
    ],
    2,
  );
  expect(lines.map((l) => l.cells.map((c) => c.text))).toEqual([["top"], ["a", "b"]]);
  expect(lines[0]!.page).toBe(2);
});
