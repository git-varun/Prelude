import { test, expect } from "bun:test";
import type { ExtractedFactCandidate, FieldType } from "@prelude/shared";
import { AnthropicExtractionProvider, normalizeAsOfDate } from "./anthropicExtraction";

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
