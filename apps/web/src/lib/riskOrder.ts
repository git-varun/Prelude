import type { ReviewFact } from "../api/client";
import { flagForRange } from "./referenceRange";

// Lower = review first. Mirrors how likely an extraction mistake is, so a reviewer who stops early has
// still looked at the riskiest facts.
export function riskRank(f: ReviewFact): number {
  if (f.coverage_status === "extraction_uncertain") return 0;
  if (f.parse_checks?.failed?.length) return 1;
  const computed = flagForRange(f.value, f.reference_range);
  if (f.printed_flag) {
    const printed = f.printed_flag.trim().toUpperCase();
    const printedDirection = ["H", "HH", "HIGH"].includes(printed) ? "above" : ["L", "LL", "LOW"].includes(printed) ? "below" : null;
    if (printedDirection !== null && printedDirection !== computed) return 2;
  }
  if (computed !== null) return 3;
  if (f.field_type === "marker_value" && !f.tracked_marker_id) return 4;
  return 5;
}

export function sortByRisk(facts: ReviewFact[]): ReviewFact[] {
  const key = (f: ReviewFact) => (f.check_state === "unchecked" ? 0 : 1);
  return [...facts].sort(
    (a, b) =>
      key(a) - key(b) ||
      riskRank(a) - riskRank(b) ||
      (a.source_page ?? Infinity) - (b.source_page ?? Infinity) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
