import type { ExtractedFactCandidate, OcrResult } from "@prelude/shared";
import { parseHeader, type HeaderFields } from "./header";
import { linesFromText } from "./lines";
import { parseRows, type ParsedRow, type RowShape } from "./rows";
import type { Line } from "./types";

export interface ParsedDocument {
  header: HeaderFields;
  rows: ParsedRow[];
  unplacedNumeric: Line[];
  lineCount: number;
}

export function parseDocument(ocr: OcrResult): ParsedDocument {
  const lines = ocr.pages.flatMap((p) => linesFromText(p.text, p.pageNumber));
  const header = parseHeader(lines);
  const { rows, unplacedNumeric } = parseRows(lines);
  return { header, rows, unplacedNumeric, lineCount: lines.length };
}

// Confidence comes from how completely the row parsed (structure), never from a model.
export function rowConfidence(shape: RowShape): number {
  return { full: 0.95, value_unit: 0.85, dash: 0.85, qualitative: 0.8, value_only: 0.7 }[shape];
}

export function toCandidates(parsed: ParsedDocument): ExtractedFactCandidate[] {
  const asOfDate = parsed.header.collectedOn ?? parsed.header.reportedOn ?? null;
  return parsed.rows.map((row) => ({
    fieldType: "marker_value",
    trackedMarkerLabel: row.label,
    value: row.value,
    unit: row.unit,
    referenceRange: row.range,
    asOfDate,
    coverageStatus: "value_found",
    sourcePage: row.page,
    sourceLocation: null,
    sourceSnippet: row.snippet,
    confidence: rowConfidence(row.shape),
  }));
}
