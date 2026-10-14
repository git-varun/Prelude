import type { ChangeSummaryItem, PrepStatus } from "../api/client";
import { documentTypeLabel } from "./documentTypeLabel";

// M3-09: which Today group a patient sits in, in one place. Groups are by state, never ranked: inside a group
// patients keep a stable order by name.
export type TodayGroup = "ready" | "preparing" | "nothing_new" | "expected";
export const TODAY_GROUPS: readonly { key: TodayGroup; title: string }[] = [
  { key: "ready", title: "Ready for you" },
  { key: "preparing", title: "Staff preparing" },
  { key: "nothing_new", title: "Nothing new" },
  { key: "expected", title: "Expected from plan, no visit opened" },
];

export interface GroupInput {
  id: string;
  name: string | null;
  last_visit_date: string | null;
  prep_status: PrepStatus | null;
  /** Marked ready, but a prep check fails now. */
  changed_since_ready: boolean;
  current_visit_document_count: number;
  sign_off_count: number;
  change_summary_items: ChangeSummaryItem[];
  has_plan_items_expected: boolean;
}

export function todayGroupOf(p: GroupInput, today: string): TodayGroup {
  // Only a visit opened today counts for the three visit groups; an older visit is history.
  if (p.last_visit_date !== today) return p.has_plan_items_expected ? "expected" : "nothing_new";
  // A ready visit whose checks fail now is not shown as ready: staff are preparing it again.
  if (p.prep_status === "ready") return p.changed_since_ready ? "preparing" : "ready";
  // Plan-date and visit-elsewhere items only appear in the change line; they do not make a visit "in preparation".
  const hasSomething = p.current_visit_document_count > 0 || p.sign_off_count > 0 ||
    p.change_summary_items.some((i) => i.kind !== "plan_past" && i.kind !== "elsewhere");
  return hasSomething ? "preparing" : "nothing_new";
}

const byName = (a: GroupInput, b: GroupInput) =>
  (a.name ?? "").localeCompare(b.name ?? "", "en", { sensitivity: "base" }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function groupPatients<T extends GroupInput>(patients: T[], today: string): Record<TodayGroup, T[]> {
  const groups: Record<TodayGroup, T[]> = { ready: [], preparing: [], nothing_new: [], expected: [] };
  for (const p of patients) groups[todayGroupOf(p, today)].push(p);
  for (const list of Object.values(groups)) list.sort(byName);
  return groups;
}

const MODALITY: Record<string, string> = {
  ct: "CT", ct_contrast: "CT with contrast", mri: "MRI", mri_contrast: "MRI with contrast", pet_ct: "PET-CT",
  ultrasound: "ultrasound", xray: "X-ray", mammography: "mammography", other: "imaging",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "22 Sep", from a YYYY-MM-DD string (fixed abbreviations: locale data spells September "Sept").
function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]}`;
}

export function changeItemText(item: ChangeSummaryItem): string {
  switch (item.kind) {
    case "marker_changed": return `${item.name} changed ${item.from} → ${item.to}`;
    case "new_report":
      return item.modality ? `new ${MODALITY[item.modality] ?? item.modality}` : `new ${documentTypeLabel(item.type).toLowerCase()} report`;
    case "sources_disagree": return `${item.name} sources disagree`;
    case "plan_past": return `${item.count} plan item${item.count === 1 ? "" : "s"} past advised date`;
    case "elsewhere": return `visit elsewhere: ${item.facility} ${shortDate(item.date)}`;
  }
}

export const changeSummaryLine = (items: ChangeSummaryItem[]) => items.map(changeItemText).join(" · ");

// Whole years, from a YYYY-MM-DD date of birth to the given YYYY-MM-DD day.
export function ageOn(dob: string | null, today: string): number | null {
  if (!dob || !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
  const [by, bm, bd] = dob.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  return ty - by - (tm > bm || (tm === bm && td >= bd) ? 0 : 1);
}

// The device's local day, as YYYY-MM-DD (the Upload screen opens visits on the same local day).
export function localToday(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// The patient list is fetched up to a fixed number of rows; when it fills up, say so rather than show wrong group counts.
export const PATIENT_FETCH_LIMIT = 500;
export const truncationNote = (shown: number): string | null =>
  shown >= PATIENT_FETCH_LIMIT ? `Showing the first ${shown} patients; group counts cover only these. Search by name to find others.` : null;
