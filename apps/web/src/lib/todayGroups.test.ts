import { expect, test } from "bun:test";
import { ageOn, changeItemText, changeSummaryLine, groupPatients, localToday, todayGroupOf, truncationNote, PATIENT_FETCH_LIMIT, type GroupInput } from "./todayGroups";

const TODAY = "2026-10-15";
const p = (id: string, o: Partial<GroupInput> = {}): GroupInput => ({
  id, name: id, prep_status: "preparing", changed_since_ready: false, current_visit_document_count: 0, sign_off_count: 0,
  unchecked_fact_count: 0, needs_attention_count: 0, held_document_count: 0, change_summary_items: [], has_plan_items_expected: false, ...o,
});

test("ready: the latest visit is marked ready, however old, whatever else is true", () => {
  expect(todayGroupOf(p("a", { prep_status: "ready" }))).toBe("ready");
  expect(todayGroupOf(p("a", { prep_status: "ready", has_plan_items_expected: true }))).toBe("ready");
  expect(todayGroupOf(p("a", { prep_status: "ready", current_visit_document_count: 3, unchecked_fact_count: 2 }))).toBe("ready");
});

test("staff preparing: documents in preparation, sign-off, review items, held documents or a change", () => {
  expect(todayGroupOf(p("a", { current_visit_document_count: 2 }))).toBe("preparing");
  expect(todayGroupOf(p("a", { sign_off_count: 1 }))).toBe("preparing");
  expect(todayGroupOf(p("a", { needs_attention_count: 2 }))).toBe("preparing");
  expect(todayGroupOf(p("a", { held_document_count: 1 }))).toBe("preparing");
  expect(todayGroupOf(p("a", { change_summary_items: [{ kind: "sources_disagree", name: "CEA" }] }))).toBe("preparing");
  expect(todayGroupOf(p("a", { change_summary_items: [{ kind: "marker_changed", name: "CEA", from: "3.0", to: "3.2" }] }))).toBe("preparing");
  expect(todayGroupOf(p("a", { change_summary_items: [{ kind: "new_report", type: "blood", modality: null }] }))).toBe("preparing");
});

test("an OLD last visit with unchecked facts is staff preparing, not nothing new", () => {
  expect(todayGroupOf(p("a", { prep_status: null, current_visit_document_count: 1, unchecked_fact_count: 2 }))).toBe("preparing");
  expect(todayGroupOf(p("a", { current_visit_document_count: 1, unchecked_fact_count: 2 }))).toBe("preparing");
});

test("an old fully signed-off visit with no changes is nothing new; plan or elsewhere items alone do not change that", () => {
  expect(todayGroupOf(p("a"))).toBe("nothing_new");
  expect(todayGroupOf(p("a", { change_summary_items: [{ kind: "plan_past", count: 1 }, { kind: "elsewhere", facility: "Apollo", date: "2026-09-22" }] }))).toBe("nothing_new");
});

test("no visits yet is nothing new", () => {
  expect(todayGroupOf(p("a", { prep_status: null }))).toBe("nothing_new");
});

test("ready but changed since marked ready goes back to staff preparing", () => {
  expect(todayGroupOf(p("a", { prep_status: "ready", changed_since_ready: true }))).toBe("preparing");
});

test("a truncated list says so; a complete one does not", () => {
  expect(truncationNote(PATIENT_FETCH_LIMIT - 1)).toBeNull();
  expect(truncationNote(PATIENT_FETCH_LIMIT)).toContain("first 500 patients");
});

test("expected from plan: only when not already preparing or ready, and a plan item is near or past its date", () => {
  expect(todayGroupOf(p("a", { prep_status: null, has_plan_items_expected: true }))).toBe("expected");
  expect(todayGroupOf(p("a", { has_plan_items_expected: true }))).toBe("expected");
  expect(todayGroupOf(p("a", { sign_off_count: 1, has_plan_items_expected: true }))).toBe("preparing");
});

test("every patient lands in exactly one group, and each group is ordered by name (then id), not by need", () => {
  const all = [
    p("3", { name: "zed", prep_status: "ready" }),
    p("1", { name: "Amy", prep_status: "ready", sign_off_count: 9 }),
    p("2", { name: "amy", prep_status: "ready" }),
    p("4", { name: "Bea", current_visit_document_count: 1 }),
    p("5", { name: null }),
    p("6", { name: "Cy", prep_status: null, has_plan_items_expected: true }),
  ];
  const g = groupPatients(all);
  expect(g.ready.map((x) => x.id)).toEqual(["1", "2", "3"]);
  expect(g.preparing.map((x) => x.id)).toEqual(["4"]);
  expect(g.nothing_new.map((x) => x.id)).toEqual(["5"]);
  expect(g.expected.map((x) => x.id)).toEqual(["6"]);
  expect(groupPatients([...all].reverse()).ready.map((x) => x.id)).toEqual(["1", "2", "3"]);
});

test("change items read from data only, joined by ' · '", () => {
  expect(changeSummaryLine([
    { kind: "marker_changed", name: "CA-125", from: "188", to: "412" },
    { kind: "new_report", type: "radiology", modality: "ct" },
    { kind: "new_report", type: "blood", modality: null },
    { kind: "sources_disagree", name: "CEA" },
    { kind: "plan_past", count: 1 },
    { kind: "elsewhere", facility: "Apollo", date: "2026-09-22" },
  ])).toBe("CA-125 changed 188 → 412 · new CT · new blood report · CEA sources disagree · 1 plan item past advised date · visit elsewhere: Apollo 22 Sep");
  expect(changeItemText({ kind: "plan_past", count: 2 })).toBe("2 plan items past advised date");
  expect(changeSummaryLine([])).toBe("");
});

test("age in whole years and the local day", () => {
  expect(ageOn("1972-10-15", TODAY)).toBe(54);
  expect(ageOn("1972-10-16", TODAY)).toBe(53);
  expect(ageOn(null, TODAY)).toBeNull();
  expect(localToday(new Date(2026, 9, 5))).toBe("2026-10-05");
});
