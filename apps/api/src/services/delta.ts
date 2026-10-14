import { sql } from "../db/client";

export type DeltaStatus = "new" | "changed" | "unchanged" | "not_observed_in_current_document_set";

export interface DeltaBaseline {
  value: string | null;
  unit: string | null;
}

// Case/whitespace-tolerant only — never a unit-conversion step. Units are
// displayed exactly as reported and never converted (Decisions Log).
function normalizeUnit(unit: string | null): string | null {
  return unit === null ? null : unit.trim().toLowerCase();
}

export function deltaKey(fieldType: string, trackedMarkerId: string | null): string {
  return `${fieldType}::${trackedMarkerId ?? ""}`;
}

// A document in one of these identity states is held: its facts are excluded from every view.
export function isHeldIdentityStatus(status: unknown): boolean {
  return status === "mismatch" || status === "awaiting_oncologist" || status === "rejected";
}

// Excludes a fact the spot-check marked as not belonging to the record (excluded_at: not_in_document /
// wrong_patient), a fact that lost an authoritative-pick conflict resolution (docs/03 §3),
// and a fact whose document is held for a patient-identity mismatch (or was
// rejected after review) -- docs/superpowers/specs/2026-10-10-deterministic-extraction-design.md
// "Identity match". NULL/'matched'/'partial'/'unknown'/'confirmed' are never held.
// 'awaiting_oncologist' (staff flagged it, the oncologist has not decided) is held exactly like 'mismatch'.
// Shared with every other fact-reading query, which aliases facts as `f` too.
export const LIVE_FACT_FILTER = sql`
  f.excluded_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM conflicts c
    WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id)
      AND c.status = 'resolved' AND c.authoritative_fact_id IS NOT NULL AND c.authoritative_fact_id != f.id
      AND NOT EXISTS (SELECT 1 FROM facts af WHERE af.id = c.authoritative_fact_id AND af.excluded_at IS NOT NULL)
  )
  AND NOT EXISTS (
    SELECT 1 FROM documents d WHERE d.id = f.document_id AND d.identity_status IN ('mismatch', 'awaiting_oncologist', 'rejected')
  )
`;

// "Neither fact of conflict `c` is excluded." Every read that decides whether a conflict blocks, is open or is
// shown adds `AND ${CONFLICT_SIDES_LIVE}`; the conflicts table MUST be aliased `c` there. A conflict with an
// excluded side stops blocking the other fact (the row itself is kept, and GET /conflicts/:id still serves it).
export const CONFLICT_SIDES_LIVE = sql`
  NOT EXISTS (SELECT 1 FROM facts xf WHERE xf.id IN (c.fact_id_a, c.fact_id_b) AND xf.excluded_at IS NOT NULL)
`;

// Most recent prior oncologist_signed_off fact per (field_type, tracked_marker_id), searched across the patient's whole visit history, not just the visit immediately before currentVisitDate.
// AM-03: compare 'here' (default) uses only facts from visits here (outside_encounter_id null); 'any' also takes facts from
// visits elsewhere, dated by the encounter's own date. 'any' never takes the current visit's own here-facts as a baseline; outside facts uploaded under the current visit (the real upload flow) can be.
export type CompareMode = "here" | "any";

export async function loadDeltaBaselines(
  patientId: string,
  currentVisitDate: string,
  compare: CompareMode = "here",
  currentVisitId: string | null = null,
): Promise<Map<string, DeltaBaseline>> {
  const rows = await sql`
    WITH prior AS (
      SELECT f.field_type, f.tracked_marker_id, f.value, f.unit,
             RANK() OVER (
               PARTITION BY f.field_type, f.tracked_marker_id
               ORDER BY COALESCE(oe.encounter_date, v.visit_date) DESC, f.as_of_date DESC NULLS LAST, f.id DESC
             ) AS rnk
      FROM facts f
      JOIN visits v ON v.id = f.visit_id
      LEFT JOIN outside_encounters oe ON oe.id = f.outside_encounter_id
      WHERE f.patient_id = ${patientId} AND f.verification_state = 'oncologist_signed_off'
        AND COALESCE(oe.encounter_date, v.visit_date) < ${currentVisitDate}::date
        AND (${compare === "any"} OR f.outside_encounter_id IS NULL)
        AND (${currentVisitId}::uuid IS NULL OR NOT (f.visit_id = ${currentVisitId}::uuid AND f.outside_encounter_id IS NULL))
        AND ${LIVE_FACT_FILTER}
    )
    SELECT field_type, tracked_marker_id, value, unit FROM prior WHERE rnk = 1
  `;

  const map = new Map<string, DeltaBaseline>();
  for (const row of rows) {
    map.set(deltaKey(row.field_type, row.tracked_marker_id), { value: row.value, unit: row.unit });
  }
  return map;
}

// delta_status for a FACT that exists in the current visit's document set.
// Units are never converted: a unit change (even with an identical value
// string) is always 'changed'; values are compared only once units match
// exactly, case/whitespace-normalized (Decisions Log, clinical input).
export function deltaForCurrentFact(
  value: string | null,
  unit: string | null,
  baseline: DeltaBaseline | undefined,
): DeltaStatus {
  if (!baseline) return "new";
  if (normalizeUnit(unit) !== normalizeUnit(baseline.unit)) return "changed";
  return value === baseline.value ? "unchanged" : "changed";
}

// null (not a DeltaStatus) when the field was never signed off before either — nothing to say went missing.
export function deltaForAbsentField(baseline: DeltaBaseline | undefined): DeltaStatus | null {
  return baseline ? "not_observed_in_current_document_set" : null;
}
