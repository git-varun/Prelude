import type { Cell, Line } from "./types";

export const CELL_SEPARATOR = "   ";

export function splitCells(raw: string): Cell[] {
  return raw.trim().split(/\s{2,}/).map((t) => t.trim()).filter(Boolean).map((text) => ({ text }));
}

export function linesFromText(pageText: string, page: number): Line[] {
  const out: Line[] = [];
  for (const rawLine of pageText.split("\n")) {
    const raw = rawLine.trim();
    if (!raw) continue;
    out.push({ page, raw, cells: splitCells(raw) });
  }
  return out;
}

export function renderLines(lines: Line[]): string {
  return lines.map((l) => l.cells.map((c) => c.text).join(CELL_SEPARATOR)).join("\n");
}
