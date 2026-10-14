import { expect, test } from "bun:test";
import { ageOn, changeItemText, changeSummaryLine, groupPatients, localToday, todayGroupOf, type GroupInput } from "./todayGroups";

const TODAY = "2026-10-15";
const p = (id: string, o: Partial<GroupInput> = {}): GroupInput => ({
  id, name: id, last_visit_date: TODAY, prep_status: "preparing", current_visit_document_count: 0, sign_off_count: 0,
  change_summary_items: [], has_plan_items_expected: false, ...o,
});

test("ready: a visit today marked ready, whatever else is true", () => {
  expect(todayGroupOf(p("a", { prep_status: "ready" }), TODAY)).toBe("ready");
  expect(todayGroupOf(p("a", { prep_status: "ready", has_plan_items_expected: true }), TODAY)).toBe("ready");
});

test("staff preparing: preparing with documents, or something to sign off, or a change", () => {
  expect(todayGroupOf(p("a", { current_visit_document_count: 2 }), TODAY)).toBe("preparing");
  expect(todayGroupOf(p("a", { sign_off_count: 1 }), TODAY)).toBe("preparing");
  expect(todayGroupOf(p("a", { change_summary_items: [{ kind: "plan_past", count: 1 }] }), TODAY)).toBe("preparing");
});

test("nothing new: a visit today with no documents, changes or sign-off; or a patient with no visit today and nothing expected", () => {
  expect(todayGroupOf(p("a"), TODAY)).toBe("nothing_new");
  expect(todayGroupOf(p("a", { last_visit_date: "2026-10-01", prep_status: "ready", current_visit_document_count: 3 }), TODAY)).toBe("nothing_new");
  expect(todayGroupOf(p("a", { last_visit_date: null, prep_status: null }), TODAY)).toBe("nothing_new");
});

test("expected from plan: no visit today and a plan item near or past its date", () => {
  expect(todayGroupOf(p("a", { last_visit_date: "2026-09-01", has_plan_items_expected: true }), TODAY)).toBe("expected");
  expect(todayGroupOf(p("a", { last_visit_date: null, prep_status: null, has_plan_items_expected: true }), TODAY)).toBe("expected");
});

test("every patient lands in exactly one group, and each group is ordered by name (then id), not by need", () => {
  const all = [
    p("3", { name: "zed", prep_status: "ready" }),
    p("1", { name: "Amy", prep_status: "ready", sign_off_count: 9 }),
    p("2", { name: "amy", prep_status: "ready" }),
    p("4", { name: "Bea", current_visit_document_count: 1 }),
    p("5", { name: null }),
    p("6", { name: "Cy", last_visit_date: null, has_plan_items_expected: true }),
  ];
  const g = groupPatients(all, TODAY);
  expect(g.ready.map((x) => x.id)).toEqual(["1", "2", "3"]);
  expect(g.preparing.map((x) => x.id)).toEqual(["4"]);
  expect(g.nothing_new.map((x) => x.id)).toEqual(["5"]);
  expect(g.expected.map((x) => x.id)).toEqual(["6"]);
  expect(groupPatients([...all].reverse(), TODAY).ready.map((x) => x.id)).toEqual(["1", "2", "3"]);
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
