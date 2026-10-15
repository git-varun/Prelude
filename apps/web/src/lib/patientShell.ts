import type { Sex } from "../api/client";

export function ageFromDob(dob: string | null, now: Date = new Date()): number | null {
  if (dob === null) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const hasHadBirthdayThisYear =
    now.getUTCMonth() > birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() >= birth.getUTCDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

const SEX_LETTER: Record<Sex, string> = { female: "F", male: "M", other: "O", unknown: "" };

/** "54F · MRN 123": only what the record holds. An unknown MRN, age or sex leaves its part out. */
export function demographicsLine(p: { date_of_birth: string | null; sex: Sex | null; mrn: string | null }, now: Date = new Date()): string {
  const age = ageFromDob(p.date_of_birth, now);
  const head = `${age ?? ""}${p.sex ? SEX_LETTER[p.sex] : ""}`;
  return [head, p.mrn ? `MRN ${p.mrn}` : ""].filter(Boolean).join(" · ");
}

export type NavKey = "summary" | "snapshot" | "history" | "plan" | "markers" | "edit";

export const NAV_ITEMS: { key: NavKey; label: string; path: string }[] = [
  { key: "summary", label: "Summary", path: "summary" },
  { key: "snapshot", label: "Snapshot · this visit", path: "snapshot" },
  { key: "history", label: "History", path: "history" },
  { key: "plan", label: "Plan", path: "plan" },
  { key: "markers", label: "Markers", path: "markers" },
  { key: "edit", label: "Edit info", path: "edit" },
];

/** Which sidebar item is current for a route. The trends screen (timeline) belongs to History. */
export function activeNav(route: string): NavKey | null {
  const m = route.split("?")[0]!.match(/^\/patients\/[^/]+\/([^/]+)$/);
  switch (m?.[1]) {
    case "summary": return "summary";
    case "snapshot": return "snapshot";
    case "history":
    case "timeline": return "history";
    case "plan": return "plan";
    case "markers": return "markers";
    case "edit": return "edit";
    default: return null;
  }
}
