import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Cell, Line } from "./types";
import { CELL_SEPARATOR } from "./lines";

// A page counts as "text layer" at or above this many extracted characters; below it the page goes to OCR.
export const TEXT_LAYER_MIN_CHARS = Number(process.env.TEXT_LAYER_MIN_CHARS ?? 200);

// Gaps are relative to the item height h: within a word, same cell with a space, new cell (column).
const JOIN_GAP = 0.25;
const COL_GAP = 2.2;

export interface TextLayerPage {
  pageNumber: number;
  lines: Line[];
  charCount: number;
  hasTextLayer: boolean;
}

export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

function toLine(row: PdfTextItem[], page: number): Line {
  const cells: Cell[] = [];
  let cur: Cell | null = null;
  let prevEnd = 0;
  for (const it of row) {
    const h = it.h || 9;
    const gap = it.x - prevEnd;
    if (cur && gap <= COL_GAP * h) {
      const needsSpace = gap > JOIN_GAP * h && !/\s$/.test(cur.text) && !/^\s/.test(it.str);
      cur.text += (needsSpace ? " " : "") + it.str;
      cur.x1 = it.x + it.w;
    } else {
      cur = { text: it.str, x0: it.x, x1: it.x + it.w };
      cells.push(cur);
    }
    prevEnd = it.x + it.w;
  }
  for (const c of cells) c.text = c.text.replace(/\s+/g, " ").trim();
  const kept = cells.filter((c) => c.text);
  return { page, raw: kept.map((c) => c.text).join(CELL_SEPARATOR), cells: kept };
}

// Items within ~half a line height of each other's baseline are the same row.
export function groupItemsIntoLines(items: PdfTextItem[], page: number): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: PdfTextItem[][] = [];
  let refY = 0;
  let tol = 0;
  for (const it of sorted) {
    const cur = rows[rows.length - 1];
    if (cur && Math.abs(it.y - refY) <= tol) {
      cur.push(it);
    } else {
      rows.push([it]);
      refY = it.y;
      tol = Math.max(2, 0.45 * (it.h || 9));
    }
  }
  return rows.map((row) => toLine(row.sort((a, b) => a.x - b.x), page)).filter((l) => l.cells.length > 0);
}

export async function extractTextLayer(data: Uint8Array): Promise<TextLayerPage[]> {
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false, verbosity: 0 }).promise;
  const pages: TextLayerPage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const raw of content.items as { str?: string; transform: number[]; width: number; height: number }[]) {
        if (typeof raw.str !== "string" || !raw.str.trim()) continue;
        items.push({ str: raw.str, x: raw.transform[4]!, y: raw.transform[5]!, w: raw.width, h: raw.height || Math.abs(raw.transform[3]!) || 9 });
      }
      const lines = groupItemsIntoLines(items, n);
      const charCount = lines.reduce((sum, l) => sum + l.raw.length, 0);
      pages.push({ pageNumber: n, lines, charCount, hasTextLayer: charCount >= TEXT_LAYER_MIN_CHARS });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}
