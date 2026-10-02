import { test, expect } from "bun:test";
import { assignCoverageStatus, EXTRACTION_CONFIDENCE_THRESHOLD } from "./rules";
import type { ExtractedFactCandidate } from "@prelude/shared";

function candidate(overrides: Partial<ExtractedFactCandidate> = {}): ExtractedFactCandidate {
  return {
    fieldType: "marker_value",
    trackedMarkerLabel: "CEA",
    value: "4.2",
    unit: "ng/mL",
    referenceRange: "0-5",
    asOfDate: "2026-01-01",
    coverageStatus: "value_found",
    sourcePage: 1,
    sourceLocation: null,
    sourceSnippet: "CEA 4.2 ng/mL",
    confidence: 0.95,
    ...overrides,
  };
}

test("assignCoverageStatus returns value_found for a confident, valued candidate", () => {
  expect(assignCoverageStatus(candidate())).toBe("value_found");
});

test("assignCoverageStatus returns not_applicable when the extraction pass says so, even with a value", () => {
  expect(assignCoverageStatus(candidate({ coverageStatus: "not_applicable", value: "n/a", confidence: 0.99 }))).toBe(
    "not_applicable",
  );
});

test("assignCoverageStatus returns not_assessed when no value was extracted", () => {
  expect(assignCoverageStatus(candidate({ value: null, coverageStatus: "value_found", confidence: 0.99 }))).toBe(
    "not_assessed",
  );
});

test("assignCoverageStatus returns not_assessed when the extraction pass found no evidence, regardless of confidence", () => {
  expect(assignCoverageStatus(candidate({ coverageStatus: "not_assessed", confidence: 0.99 }))).toBe("not_assessed");
});

test("assignCoverageStatus returns extraction_uncertain below the confidence threshold", () => {
  expect(assignCoverageStatus(candidate({ confidence: EXTRACTION_CONFIDENCE_THRESHOLD - 0.01 }))).toBe(
    "extraction_uncertain",
  );
});

test("assignCoverageStatus returns value_found at exactly the confidence threshold", () => {
  expect(assignCoverageStatus(candidate({ confidence: EXTRACTION_CONFIDENCE_THRESHOLD }))).toBe("value_found");
});

test("assignCoverageStatus returns extraction_uncertain when the extraction pass flagged ambiguity, even at high confidence", () => {
  expect(assignCoverageStatus(candidate({ coverageStatus: "extraction_uncertain", confidence: 0.99 }))).toBe(
    "extraction_uncertain",
  );
});

test("assignCoverageStatus never returns conflicting_sources", () => {
  // conflicting_sources is only ever set by conflict-detection logic
  // (M7), never by the per-candidate rules engine.
  const result = assignCoverageStatus(candidate());
  expect(result).not.toBe("conflicting_sources");
});
