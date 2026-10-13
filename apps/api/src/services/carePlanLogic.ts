import { MARKER_REGISTRY } from "@prelude/shared";

// Pure care-plan helpers (M3-03). No DB access: everything here is derived from its arguments.

export type PlanItemType = "test" | "procedure" | "review";
export type PlanStatus = "planned" | "report_suggested" | "report_seen" | "past_advised";

const UNIT_DAYS = { day: 1, week: 7 } as const;

function isoFromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Parses only a single simple "N day(s)/week(s)/month(s)" interval in `text` and returns the approximate
// date (YYYY-MM-DD) relative to advisedAt. Anything else -- no interval, two intervals, other phrasing -- is
// null, so no date is shown rather than a guessed one.
export function approximateDate(text: string, advisedAt: string): string | null {
  const matches = [...text.matchAll(/\b(\d{1,3})\s*(day|week|month)s?\b/gi)];
  if (matches.length !== 1) return null;
  const n = Number(matches[0]![1]);
  const unit = matches[0]![2]!.toLowerCase() as "day" | "week" | "month";
  const start = new Date(`${advisedAt}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return null;
  if (unit === "month") {
    const day = start.getUTCDate();
    const d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + n, 1));
    const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, lastDay));
    return isoFromUtc(d);
  }
  return isoFromUtc(new Date(start.getTime() + n * UNIT_DAYS[unit] * 86_400_000));
}

export interface CandidateDocument {
  id: string;
  label: string;
  imaging_modality: string | null;
  // Canonical or raw marker labels of the document's live marker_value facts.
  markers: string[];
  // reported_on, else collected_on, else the latest as_of_date of its live facts.
  date: string | null;
}

const MODALITY_PATTERNS: Record<string, RegExp> = {
  ct: /\b(ct|cect|hrct)\b/i,
  ct_contrast: /\b(ct|cect|hrct)\b/i,
  mri: /\b(mri|mr)\b/i,
  mri_contrast: /\b(mri|mr)\b/i,
  pet_ct: /\bpet(\s*-?\s*ct)?\b/i,
  ultrasound: /\b(ultrasound|usg|sonography)\b/i,
  xray: /\bx-?\s?ray\b/i,
  mammography: /\bmammo(gram|graphy)?\b/i,
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textMentionsMarker(text: string, marker: string): boolean {
  const names = new Set([marker]);
  for (const def of MARKER_REGISTRY) {
    const all = [def.canonical, ...def.aliases];
    if (all.some((a) => a.toLowerCase() === marker.trim().toLowerCase())) all.forEach((a) => names.add(a));
  }
  return [...names].some((n) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(n)}($|[^A-Za-z0-9])`, "i").test(text));
}

// Suggests (never applies) documents that could be the report for a test: dated strictly after the advised
// date, and either an imaging modality or a lab marker named in the item text. Earliest report first.
export function suggestMatches(
  item: { type: PlanItemType; text: string; advised_at: string },
  candidates: CandidateDocument[],
): CandidateDocument[] {
  if (item.type !== "test") return [];
  return candidates
    .filter((c) => {
      if (c.date === null || c.date <= item.advised_at) return false;
      const modality = c.imaging_modality ? MODALITY_PATTERNS[c.imaging_modality] : undefined;
      if (modality?.test(item.text)) return true;
      return c.markers.some((m) => textMentionsMarker(item.text, m));
    })
    .sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));
}

// Status is derived, never stored. A confirmed match wins; else a suggestion; else the (approximate) advised
// date decides between planned and past_advised.
export function derivePlanStatus(args: {
  advised_at: string;
  approx_date: string | null;
  hasConfirmedMatch: boolean;
  hasSuggestion: boolean;
  today: string;
}): PlanStatus {
  if (args.hasConfirmedMatch) return "report_seen";
  if (args.hasSuggestion) return "report_suggested";
  return (args.approx_date ?? args.advised_at) < args.today ? "past_advised" : "planned";
}
