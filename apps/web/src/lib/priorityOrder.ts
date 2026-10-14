import type { PlanItem, SnapshotField, WatchlistEntry } from "../api/client";
import { flagForRange } from "./referenceRange";

// AM-05: the one fixed order for "For this visit", the same for every patient. No score, weighting or model:
// each item gets the FIRST rule it matches, and the list is sorted by rule number.
export type Rule = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const RULES: { rule: Rule; label: string; tag: string }[] = [
  { rule: 1, label: "Conflict between sources", tag: "Conflict between sources" },
  { rule: 2, label: "Pinned marker, changed or new", tag: "Pinned · changed" },
  { rule: 3, label: "New radiology report", tag: "New radiology report" },
  { rule: 4, label: "Changed or new, outside lab range", tag: "Outside range" },
  { rule: 5, label: "Plan item past advised date", tag: "Plan item past advised date" },
  { rule: 6, label: "Pinned marker not in this visit", tag: "Pinned · not in this visit" },
  { rule: 7, label: "Other changed or new", tag: "Changed or new" },
];

export type FactSection = "treatment" | "marker" | "radiology";

export type PriorityItem = { rule: Rule | null; date: string | null; id: string; marker_name: string | null } & (
  | { kind: "fact"; section: FactSection; field: SnapshotField }
  | { kind: "plan"; plan: PlanItem }
  | { kind: "missing_pin"; entry: WatchlistEntry }
);

export interface PriorityInput {
  treatment: SnapshotField[];
  markers: SnapshotField[];
  radiology: SnapshotField[];
  watchlist: WatchlistEntry[];
  planItems: PlanItem[];
}

const hasOpenConflict = (f: SnapshotField) => f.conflicts.some((c) => c.status === "open" || c.status === "annotated");
// A live fact is "unchanged" only when the API says so. With no delta status there is no baseline to say it
// stayed the same, so it is treated as new rather than folded away.
const isChangedOrNew = (f: SnapshotField) => f.delta_status !== "unchanged";

// Pure and deterministic: the same input always gives the same output.
// Tie order within a rule (AM-05 "ties keep document date order"): as_of_date ascending (older document date
// first, undated last), then id so the order is total and stable.
// Facts without a fact_id (not found in this document set) are not items; the caller shows them as placeholders.
// Unchanged facts get rule null and sort after every ruled item, in the same order.
export function deltaPriority(input: PriorityInput): PriorityItem[] {
  const pinned = new Set(input.watchlist.map((w) => w.tracked_marker_id));
  const items: PriorityItem[] = [];

  const addFacts = (fields: SnapshotField[], section: FactSection) => {
    for (const field of fields) {
      if (field.fact_id === null) continue;
      const changed = isChangedOrNew(field);
      let rule: Rule | null = null;
      if (hasOpenConflict(field)) rule = 1;
      else if (section === "marker" && changed && field.tracked_marker_id !== null && pinned.has(field.tracked_marker_id)) rule = 2;
      else if (section === "radiology" && changed) rule = 3;
      else if (section === "marker" && changed && flagForRange(field.value, field.reference_range) !== null) rule = 4;
      else if (changed) rule = 7;
      items.push({ kind: "fact", section, field, rule, date: field.as_of_date, id: field.fact_id, marker_name: field.marker_name });
    }
  };
  addFacts(input.treatment, "treatment");
  addFacts(input.markers, "marker");
  addFacts(input.radiology, "radiology");

  for (const plan of input.planItems) {
    if (plan.past_advised) items.push({ kind: "plan", plan, rule: 5, date: plan.advised_at, id: plan.id, marker_name: null });
  }
  for (const entry of input.watchlist) {
    if (entry.missing) {
      items.push({
        kind: "missing_pin", entry, rule: 6, date: entry.last_seen?.as_of_date ?? null, id: entry.tracked_marker_id,
        marker_name: entry.marker_name,
      });
    }
  }

  return items.sort(
    (a, b) =>
      (a.rule ?? 8) - (b.rule ?? 8) ||
      (a.date === b.date ? 0 : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
