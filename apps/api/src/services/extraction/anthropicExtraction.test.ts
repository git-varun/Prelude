import { test, expect } from "bun:test";
import type { ExtractedFactCandidate, FieldType, OcrResult } from "@prelude/shared";
import { AnthropicExtractionProvider, normalizeAsOfDate, promptFor, toExtractedFactCandidate, type RawCandidate } from "./anthropicExtraction";

function rawCandidate(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    trackedMarkerLabel: null,
    value: "4.2",
    unit: null,
    referenceRange: null,
    asOfDate: "2026-01-01",
    coverageStatus: "value_found",
    sourcePage: 1,
    sourceLocation: null,
    sourceSnippet: null,
    confidence: 0.9,
    ...overrides,
  };
}

function ocrResult(overrides: Partial<OcrResult> = {}): OcrResult {
  return {
    fullText: "patient report\nCEA 5.9 ng/mL\nreference 0-5",
    pages: [{ pageNumber: 1, text: "patient report\nCEA 5.9 ng/mL\nreference 0-5" }],
    providerName: "test",
    providerRaw: null,
    ...overrides,
  };
}

// provenanceFor labels a fact "exact" source purely from sourceSnippet being
// non-null, promising a highlight that SourceView renders via a plain
// text.indexOf(snippet) against the OCR text -- so a snippet the model didn't
// actually quote verbatim must never reach the database, or the UI silently
// shows no highlight while still claiming "exact" provenance everywhere else.
test("toExtractedFactCandidate drops a sourceSnippet that isn't a verbatim substring of the OCR text", () => {
  const result = toExtractedFactCandidate(
    "marker_value",
    rawCandidate({ sourceSnippet: "CEA: 5.9 ng/mL" }),
    ocrResult({ fullText: "the actual ocr text has CEA : 5.9ng/mL somewhere", pages: [] }),
  );
  expect(result.sourceSnippet).toBeNull();
});

test("toExtractedFactCandidate keeps a sourceSnippet that is a verbatim substring of the OCR text", () => {
  const result = toExtractedFactCandidate("marker_value", rawCandidate({ sourceSnippet: "CEA 5.9 ng/mL", sourcePage: 1 }), ocrResult());
  expect(result.sourceSnippet).toBe("CEA 5.9 ng/mL");
});

// Code review finding: verifying against the whole concatenated document let
// a snippet attributed to page 2 that actually lives on page 1's text pass
// verification, even though SourceView only ever searches the single page
// named by sourcePage -- the highlight would still silently fail to render.
test("toExtractedFactCandidate drops a sourceSnippet that exists on a different page than sourcePage claims", () => {
  const ocr = ocrResult({
    pages: [
      { pageNumber: 1, text: "Header boilerplate: CEA 5.9 ng/mL appears here only" },
      { pageNumber: 2, text: "Different content entirely, no marker mentioned" },
    ],
  });
  const result = toExtractedFactCandidate("marker_value", rawCandidate({ sourceSnippet: "CEA 5.9 ng/mL", sourcePage: 2 }), ocr);
  expect(result.sourceSnippet).toBeNull();
});

test("toExtractedFactCandidate keeps a sourceSnippet found on the page sourcePage actually names", () => {
  const ocr = ocrResult({
    pages: [
      { pageNumber: 1, text: "Unrelated page 1 content" },
      { pageNumber: 2, text: "CEA 5.9 ng/mL appears here" },
    ],
  });
  const result = toExtractedFactCandidate("marker_value", rawCandidate({ sourceSnippet: "CEA 5.9 ng/mL", sourcePage: 2 }), ocr);
  expect(result.sourceSnippet).toBe("CEA 5.9 ng/mL");
});

// Deterministic marker matching (matchMarker, services/facts.ts) is the only place a raw
// extracted label is ever resolved to a controlled canonical name — never the LLM, which
// cannot be trusted to apply the hard-negative rules (Free PSA vs Total PSA, etc.)
// consistently. The prompt must ask for the label verbatim, not attempt the match itself.
test("the marker_value prompt asks for the raw label verbatim, never asking the model to match a controlled list", () => {
  const prompt = promptFor("marker_value", "blood", "some ocr text");
  expect(prompt).not.toMatch(/controlled marker/i);
  expect(prompt).toMatch(/exactly as it appears/i);
});

function candidate(fieldType: FieldType): ExtractedFactCandidate {
  return {
    fieldType,
    value: "4.2",
    unit: null,
    referenceRange: null,
    asOfDate: "2026-01-01",
    coverageStatus: "value_found",
    sourcePage: 1,
    sourceLocation: null,
    sourceSnippet: null,
    confidence: 0.9,
  };
}

// Overrides only the per-field-type LLM call (no network); extractFacts's own
// fan-out/aggregation is the real code under test.
class FakeProvider extends AnthropicExtractionProvider {
  constructor(private readonly outcomes: Partial<Record<FieldType, "ok" | "fail" | "empty">>) {
    super("test-key");
  }

  protected override async extractForFieldType(
    _client: unknown,
    fieldType: FieldType,
  ): Promise<ExtractedFactCandidate[]> {
    if (this.outcomes[fieldType] === "fail") throw new Error(`${fieldType} call failed`);
    if (this.outcomes[fieldType] === "empty") return [];
    return [candidate(fieldType)];
  }
}

const ocr = { fullText: "x", pages: [], providerName: "test" };

test("keeps the successful field types' candidates and reports the failed field type", async () => {
  const provider = new FakeProvider({ marker_value: "ok", reference_range: "fail" });
  const result = await provider.extractFacts(ocr, "blood");
  expect(result.candidates.map((c) => c.fieldType)).toEqual(["marker_value"]);
  expect(result.failedFieldTypes).toEqual(["reference_range"]);
  expect(result.failureMessages?.reference_range).toContain("reference_range call failed");
});

test("reports every field type as failed, without throwing, when all calls fail", async () => {
  const provider = new FakeProvider({ marker_value: "fail", reference_range: "fail" });
  const result = await provider.extractFacts(ocr, "blood");
  expect(result.candidates).toEqual([]);
  expect(result.failedFieldTypes).toEqual(["marker_value", "reference_range"]);
});

test("one field type failing and the other returning nothing is reported as a failure, not 'no facts'", async () => {
  const provider = new FakeProvider({ marker_value: "fail", reference_range: "empty" });
  const result = await provider.extractFacts(ocr, "blood");
  expect(result.candidates).toEqual([]);
  expect(result.failedFieldTypes).toEqual(["marker_value"]);
});

test("reports no failures when every call succeeds, including with nothing extracted", async () => {
  const provider = new FakeProvider({ radiology_impression: "empty", disease_status_trend: "empty" });
  const result = await provider.extractFacts(ocr, "radiology");
  expect(result).toMatchObject({ candidates: [], failedFieldTypes: [] });
});

test("normalizeAsOfDate keeps valid ISO dates (trimmed) and nulls everything else", () => {
  expect(normalizeAsOfDate("2026-08-01")).toBe("2026-08-01");
  expect(normalizeAsOfDate("  2026-08-01\n")).toBe("2026-08-01");
  expect(normalizeAsOfDate(null)).toBeNull();
  for (const bad of ["01/08/2026", "2026-13-45", "2026-02-30", "0000-01-01", "", "August 2026"]) {
    expect(normalizeAsOfDate(bad)).toBeNull();
  }
});
