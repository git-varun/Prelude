import { test, expect } from "bun:test";
import type { ExtractedFactCandidate, FieldType } from "@opd/shared";
import { AnthropicExtractionProvider } from "./anthropicExtraction";

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
  constructor(private readonly outcomes: Partial<Record<FieldType, "ok" | "fail">>) {
    super("test-key");
  }

  protected override async extractForFieldType(
    _client: unknown,
    fieldType: FieldType,
  ): Promise<ExtractedFactCandidate[]> {
    if (this.outcomes[fieldType] === "fail") throw new Error(`${fieldType} call failed`);
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
