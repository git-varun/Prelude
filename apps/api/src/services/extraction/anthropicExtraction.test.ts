import { test, expect } from "bun:test";
import type { ExtractedFactCandidate, FieldType } from "@opd/shared";
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

test("keeps the successful field types' candidates when another field type's call fails", async () => {
  const provider = new FakeProvider({ marker_value: "ok", reference_range: "fail" });
  const candidates = await provider.extractFacts(ocr, "blood");
  expect(candidates.map((c) => c.fieldType)).toEqual(["marker_value"]);
});

test("throws when every field type's call fails, so a total outage is not mistaken for an empty document", async () => {
  const provider = new FakeProvider({ marker_value: "fail", reference_range: "fail" });
  await expect(provider.extractFacts(ocr, "blood")).rejects.toThrow();
});

test("throws when one field type fails and the other returns nothing, so a partial failure is not shown as 'no facts'", async () => {
  const provider = new FakeProvider({ marker_value: "fail", reference_range: "empty" });
  await expect(provider.extractFacts(ocr, "blood")).rejects.toThrow();
});

test("returns surviving candidates when one field type fails and the other returns candidates", async () => {
  const provider = new FakeProvider({ radiology_impression: "ok", disease_status_trend: "fail" });
  const candidates = await provider.extractFacts(ocr, "radiology");
  expect(candidates.map((c) => c.fieldType)).toEqual(["radiology_impression"]);
});

test("normalizeAsOfDate keeps valid ISO dates (trimmed) and nulls everything else", () => {
  expect(normalizeAsOfDate("2026-08-01")).toBe("2026-08-01");
  expect(normalizeAsOfDate("  2026-08-01\n")).toBe("2026-08-01");
  expect(normalizeAsOfDate(null)).toBeNull();
  for (const bad of ["01/08/2026", "2026-13-45", "2026-02-30", "0000-01-01", "", "August 2026"]) {
    expect(normalizeAsOfDate(bad)).toBeNull();
  }
});
