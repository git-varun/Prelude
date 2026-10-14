import { test, expect } from "bun:test";
import type { PlanItem, SnapshotField, WatchlistEntry } from "../api/client";
import { deltaPriority, RULES, type PriorityInput } from "./priorityOrder";

function field(over: Partial<SnapshotField> = {}): SnapshotField {
  return {
    fact_id: "f1", field_type: "marker_value", tracked_marker_id: "m1", marker_name: "CEA", value: "3", unit: "ng/mL",
    reference_range: "0-5", as_of_date: "2026-02-01", coverage_status: "value_found", verification_state: "unverified",
    check_state: "correct", delta_status: "unchanged", conflicts: [], provenance: null, imaging_modality: null, ...over,
  };
}
const conflict = (status = "open") =>
  ({ conflict_id: "c1", status, other_fact_id: "f9", other_value: "9", other_source: null, authoritative_fact_id: null, historical: false }) as unknown as SnapshotField["conflicts"][number];
function pin(over: Partial<WatchlistEntry> = {}): WatchlistEntry {
  return { tracked_marker_id: "m1", marker_name: "CEA", missing: false, conflict: false, ...over } as WatchlistEntry;
}
function plan(over: Partial<PlanItem> = {}): PlanItem {
  return { id: "p1", type: "test", text: "MRI", advised_at: "2026-01-01", past_advised: true, ...over } as PlanItem;
}
function input(over: Partial<PriorityInput> = {}): PriorityInput {
  return { treatment: [], markers: [], radiology: [], watchlist: [], planItems: [], ...over };
}
const ruleOf = (i: PriorityInput, id: string) => deltaPriority(i).find((x) => x.id === id)?.rule;

test("rule 1: a fact party to an open or annotated conflict, even if unchanged", () => {
  expect(ruleOf(input({ markers: [field({ conflicts: [conflict("open")] })] }), "f1")).toBe(1);
  expect(ruleOf(input({ markers: [field({ conflicts: [conflict("annotated")] })] }), "f1")).toBe(1);
  expect(ruleOf(input({ markers: [field({ conflicts: [conflict("resolved")] })] }), "f1")).toBeNull();
});

test("rule 2: pinned marker, changed or new", () => {
  const w = [pin()];
  expect(ruleOf(input({ markers: [field({ delta_status: "changed" })], watchlist: w }), "f1")).toBe(2);
  expect(ruleOf(input({ markers: [field({ delta_status: "new" })], watchlist: w }), "f1")).toBe(2);
  expect(ruleOf(input({ markers: [field({ delta_status: "changed" })] }), "f1")).toBe(7);
});

test("rule 3: new or changed radiology fact", () => {
  const r = field({ fact_id: "r1", field_type: "radiology_impression", tracked_marker_id: null, marker_name: null, delta_status: "new" });
  expect(ruleOf(input({ radiology: [r] }), "r1")).toBe(3);
  expect(ruleOf(input({ radiology: [{ ...r, delta_status: "changed" }] }), "r1")).toBe(3);
  expect(ruleOf(input({ radiology: [{ ...r, delta_status: "unchanged" }] }), "r1")).toBeNull();
});

test("rule 4: changed or new marker outside its range", () => {
  expect(ruleOf(input({ markers: [field({ delta_status: "changed", value: "9" })] }), "f1")).toBe(4);
  expect(ruleOf(input({ markers: [field({ delta_status: "new", value: "3" })] }), "f1")).toBe(7);
  // outside range but unchanged: not a rule 4 item
  expect(ruleOf(input({ markers: [field({ delta_status: "unchanged", value: "9" })] }), "f1")).toBeNull();
});

test("rule 5: plan item past advised date, from the plan flag", () => {
  const out = deltaPriority(input({ planItems: [plan(), plan({ id: "p2", past_advised: false })] }));
  expect(out.map((i) => [i.id, i.rule])).toEqual([["p1", 5]]);
});

test("rule 6: pinned marker not in this visit", () => {
  const out = deltaPriority(input({ watchlist: [pin({ missing: true }), pin({ tracked_marker_id: "m2", marker_name: "PSA" })] }));
  expect(out.map((i) => [i.id, i.rule])).toEqual([["m1", 6]]);
});

test("rule 7: other changed or new, including treatment", () => {
  const t = field({ fact_id: "t1", field_type: "treatment_regimen", tracked_marker_id: null, marker_name: null, delta_status: "changed" });
  expect(ruleOf(input({ treatment: [t] }), "t1")).toBe(7);
});

test("first matching rule wins", () => {
  const w = [pin()];
  const base = field({ delta_status: "changed", value: "9" }); // pinned, changed and out of range
  expect(ruleOf(input({ markers: [base], watchlist: w }), "f1")).toBe(2);
  expect(ruleOf(input({ markers: [{ ...base, conflicts: [conflict()] }], watchlist: w }), "f1")).toBe(1);
  const r = field({ fact_id: "r1", field_type: "radiology_impression", tracked_marker_id: null, delta_status: "new", conflicts: [conflict()] });
  expect(ruleOf(input({ radiology: [r] }), "r1")).toBe(1);
  expect(ruleOf(input({ markers: [base] }), "f1")).toBe(4);
});

test("order is by rule number across all kinds", () => {
  const out = deltaPriority(input({
    markers: [
      field({ fact_id: "a", tracked_marker_id: "m1", delta_status: "changed" }), // 2
      field({ fact_id: "b", tracked_marker_id: "m2", delta_status: "changed", value: "9" }), // 4
      field({ fact_id: "c", tracked_marker_id: "m3", delta_status: "changed" }), // 7
      field({ fact_id: "d", tracked_marker_id: "m4", delta_status: "unchanged" }), // null
      field({ fact_id: "e", tracked_marker_id: "m5", conflicts: [conflict()] }), // 1
    ],
    radiology: [field({ fact_id: "r", field_type: "radiology_impression", tracked_marker_id: null, delta_status: "new" })], // 3
    watchlist: [pin(), pin({ tracked_marker_id: "m9", marker_name: "PSA", missing: true })], // 6
    planItems: [plan()], // 5
  }));
  expect(out.map((i) => i.rule)).toEqual([1, 2, 3, 4, 5, 6, 7, null]);
  expect(out.map((i) => i.id)).toEqual(["e", "a", "r", "b", "p1", "m9", "c", "d"]);
});

test("ties within a rule: older document date first, then id; undated last", () => {
  const f = (id: string, date: string | null) => field({ fact_id: id, tracked_marker_id: id, delta_status: "changed", as_of_date: date });
  const out = deltaPriority(input({ markers: [f("z", "2026-01-01"), f("b", "2026-03-01"), f("a", "2026-03-01"), f("u", null), f("c", "2025-12-01")] }));
  expect(out.map((i) => i.id)).toEqual(["c", "z", "a", "b", "u"]);
});

test("unchanged facts get no rule and come after every ruled item, in date then id order", () => {
  const out = deltaPriority(input({
    markers: [
      field({ fact_id: "u2", delta_status: "unchanged", as_of_date: "2026-02-02" }),
      field({ fact_id: "u1", delta_status: "unchanged", as_of_date: "2026-02-01" }),
      field({ fact_id: "x", delta_status: "changed" }),
    ],
  }));
  expect(out.map((i) => [i.id, i.rule])).toEqual([["x", 7], ["u1", null], ["u2", null]]);
});

test("a fact with no delta status is not folded away", () => {
  expect(ruleOf(input({ markers: [field({ delta_status: null })] }), "f1")).toBe(7);
});

test("facts without a fact_id are not items", () => {
  expect(deltaPriority(input({ markers: [field({ fact_id: null, coverage_status: "not_found_in_document_set" })] }))).toEqual([]);
});

test("pure and stable: same input, same output, input untouched", () => {
  const i = input({
    markers: [field({ fact_id: "b", delta_status: "changed" }), field({ fact_id: "a", delta_status: "changed" })],
    watchlist: [pin({ missing: true })], planItems: [plan()],
  });
  const snapshot = JSON.stringify(i);
  expect(deltaPriority(i)).toEqual(deltaPriority(i));
  expect(JSON.stringify(i)).toBe(snapshot);
});

test("every item carries exactly one rule and rule numbers match the published list", () => {
  expect(RULES.map((r) => r.rule)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  const out = deltaPriority(input({
    markers: [field({ delta_status: "changed", value: "9", conflicts: [conflict()] })], watchlist: [pin()],
  }));
  expect(out).toHaveLength(1);
  expect(out[0]!.rule).toBe(1);
});
