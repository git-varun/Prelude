import { test, expect } from "bun:test";
import type { ReviewFact } from "../api/client";
import { riskRank, sortByRisk } from "./riskOrder";

function fact(over: Partial<ReviewFact>): ReviewFact {
  return {
    id: "x", patient_id: "p", visit_id: "v", document_id: "d", tracked_marker_id: "m", tracked_marker_name: "CEA",
    raw_marker_label: null, field_type: "marker_value", value: "3", unit: "ng/mL", reference_range: "0-5",
    as_of_date: "2026-01-01", needs_manual_date: false, coverage_status: "value_found", verification_state: "unverified",
    has_blocking_conflict: false, blocking_conflict_id: null, source_page: 1, source_location: null, source_snippet: null,
    fallback_level: "exact", check_state: "unchecked", checked_by: null, checked_at: null, error_type: null,
    excluded_at: null, printed_flag: null, parse_checks: null, ...over,
  };
}

const facts: ReviewFact[] = [
  fact({ id: "plain", source_page: 1 }),
  fact({ id: "unmapped", tracked_marker_id: null, source_page: 1 }),
  fact({ id: "range", value: "9", source_page: 1 }),
  fact({ id: "printed", value: "3", printed_flag: "H", source_page: 1 }),
  fact({ id: "parse", parse_checks: { failed: ["unit"] }, source_page: 1 }),
  fact({ id: "uncertain", coverage_status: "extraction_uncertain", source_page: 1 }),
  fact({ id: "checked", coverage_status: "extraction_uncertain", check_state: "correct", source_page: 1 }),
];

test("each rank, lower reviews first", () => {
  const rank = Object.fromEntries(facts.map((f) => [f.id, riskRank(f)]));
  expect(rank).toEqual({ uncertain: 0, parse: 1, printed: 2, range: 3, unmapped: 4, plain: 5, checked: 0 });
});

test("sorted by rank; checked facts last regardless of rank", () => {
  expect(sortByRisk(facts).map((f) => f.id)).toEqual(["uncertain", "parse", "printed", "range", "unmapped", "plain", "checked"]);
});

test("equal ranks keep source_page order, then id", () => {
  const out = sortByRisk([
    fact({ id: "b", source_page: 2 }),
    fact({ id: "c", source_page: 1 }),
    fact({ id: "a", source_page: 2 }),
    fact({ id: "n", source_page: null }),
  ]);
  expect(out.map((f) => f.id)).toEqual(["c", "a", "b", "n"]);
});

test("a printed flag that agrees with the range is not rank 2", () => {
  expect(riskRank(fact({ value: "9", printed_flag: "H" }))).toBe(3);
});

test("does not mutate its input", () => {
  const input = [fact({ id: "b" }), fact({ id: "a", coverage_status: "extraction_uncertain" })];
  sortByRisk(input);
  expect(input.map((f) => f.id)).toEqual(["b", "a"]);
});
