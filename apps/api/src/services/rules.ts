import type { CoverageStatus, ExtractedFactCandidate } from "@prelude/shared";

// Below this confidence, a candidate is treated as extraction_uncertain
// regardless of what the extraction pass itself guessed — a named constant
// per docs/02 M2's rules-engine checklist item, not a magic number.
export const EXTRACTION_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Deterministic coverage_status assignment (docs/02 M2, docs/03 §1). Pure —
 * no DB or network calls — and unit-testable in isolation. The extraction
 * pass's own `coverageStatus` guess is a signal, not authoritative; this
 * function is what actually decides the value that gets stored on a FACT
 * row.
 *
 * Rules, in priority order:
 * 1. Source explicitly states the test/field wasn't performed -> not_applicable
 * 2. No usable evidence extracted -> not_assessed
 * 3. Low-confidence or ambiguous extraction -> extraction_uncertain
 * 4. Usable value, confidently extracted -> value_found
 */
export function assignCoverageStatus(candidate: ExtractedFactCandidate): CoverageStatus {
  if (candidate.coverageStatus === "not_applicable") {
    return "not_applicable";
  }
  if (candidate.value === null || candidate.coverageStatus === "not_assessed") {
    return "not_assessed";
  }
  if (candidate.coverageStatus === "extraction_uncertain" || candidate.confidence < EXTRACTION_CONFIDENCE_THRESHOLD) {
    return "extraction_uncertain";
  }
  return "value_found";
}
