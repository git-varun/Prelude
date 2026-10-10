import { test, expect } from "bun:test";
import type { OcrResult } from "@prelude/shared";
import { parseDocument, toCandidates, rowConfidence } from "./pipeline";
import { DeterministicExtractionProvider } from "./provider";

const ocr = (text: string): OcrResult => ({ fullText: text, pages: [{ pageNumber: 1, text }], providerName: "test", providerRaw: null });
const TEXT = [
  "SYNTHETIC DIAGNOSTIC LABS",
  "Patient Name : Mr. TEST PERSON      Collected On : 08/Apr/2026 10:00 AM",
  "Reported Date : 09/Apr/2026 05:29 AM",
  "Test Name   Result   Unit   Bio. Ref. Interval",
  "HAEMOGLOBIN (Hb)      10.1      g/dL      13.0-17.0",
  "Weird Test      4.5 gm      note",
].join("\n");

test("candidates carry the collection date, verbatim snippets and structure-based confidence", () => {
  const c = toCandidates(parseDocument(ocr(TEXT)));
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ fieldType: "marker_value", trackedMarkerLabel: "HAEMOGLOBIN (Hb)", value: "10.1", unit: "g/dL", referenceRange: "13.0-17.0", asOfDate: "2026-04-08", sourcePage: 1 });
  expect(TEXT).toContain(c[0]!.sourceSnippet!);
  expect(c[0]!.confidence).toBe(rowConfidence("full"));
});

test("report date is the fallback date", () => {
  const c = toCandidates(parseDocument(ocr("Reported Date : 09/Apr/2026\nHb      10.1      g/dL      13-17")));
  expect(c[0]!.asOfDate).toBe("2026-04-09");
});

test("provider reports stats including unplaced lines, and never says 'nothing extractable' for unplaced content", async () => {
  const r = await new DeterministicExtractionProvider().extractFacts(ocr(TEXT), "blood");
  expect(r.candidates).toHaveLength(1);
  expect(r.failedFieldTypes).toEqual([]);
  expect(r.stats).toMatchObject({ rows: 1, unplacedNumericLines: 1 });
});

test("non-blood documents are reported as not handled, not as empty", async () => {
  const r = await new DeterministicExtractionProvider().extractFacts(ocr("IMPRESSION: normal"), "radiology");
  expect(r.candidates).toEqual([]);
  expect(r.failedFieldTypes).toEqual(["radiology_impression", "disease_status_trend"]);
});
