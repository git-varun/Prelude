import type { ExtractedFactCandidate, OcrResult } from "@prelude/shared";
import { parseHeader, type HeaderFields } from "./header";
import { linesFromText } from "./lines";
import { parseRows, type ParsedRow } from "./rows";
import type { Line } from "./types";
import { applyChecks, rowConfidence } from "./validate";

export { rowConfidence };

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

export function toCandidates(parsed: ParsedDocument): ExtractedFactCandidate[] {
  const asOfDate = parsed.header.collectedOn ?? parsed.header.reportedOn ?? null;
  return applyChecks(parsed.rows).map(({ row, checks, confidence }) => ({
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
    confidence,
    printedFlag: row.flag,
    parseChecks: checks,
  }));
}
