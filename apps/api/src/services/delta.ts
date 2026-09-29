import { sql } from "../db/client";

export type DeltaStatus = "new" | "changed" | "unchanged" | "not_observed_in_current_document_set";

export interface DeltaBaseline {
  value: string | null;
}

export function deltaKey(fieldType: string, trackedMarkerId: string | null): string {
  return `${fieldType}::${trackedMarkerId ?? ""}`;
}

// Excludes a fact that lost an authoritative-pick conflict resolution (docs/03 §3); shared with the snapshot route, which aliases facts as `f` too.
export const LIVE_FACT_FILTER = sql`
  NOT EXISTS (
    SELECT 1 FROM conflicts c
    WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id)
      AND c.status = 'resolved' AND c.authoritative_fact_id IS NOT NULL AND c.authoritative_fact_id != f.id
  )
`;

// Most recent prior oncologist_signed_off fact per (field_type, tracked_marker_id), searched across the patient's whole visit history, not just the visit immediately before currentVisitDate.
export async function loadDeltaBaselines(patientId: string, currentVisitDate: string): Promise<Map<string, DeltaBaseline>> {
  const rows = await sql`
    WITH prior AS (
      SELECT f.field_type, f.tracked_marker_id, f.value,
             RANK() OVER (
               PARTITION BY f.field_type, f.tracked_marker_id
               ORDER BY v.visit_date DESC, f.as_of_date DESC NULLS LAST, f.id DESC
             ) AS rnk
      FROM facts f
      JOIN visits v ON v.id = f.visit_id
      WHERE f.patient_id = ${patientId} AND f.verification_state = 'oncologist_signed_off'
        AND v.visit_date < ${currentVisitDate}::date
        AND ${LIVE_FACT_FILTER}
    )
    SELECT field_type, tracked_marker_id, value FROM prior WHERE rnk = 1
  `;

  const map = new Map<string, DeltaBaseline>();
  for (const row of rows) {
    map.set(deltaKey(row.field_type, row.tracked_marker_id), { value: row.value });
  }
  return map;
}

/** delta_status for a FACT that exists in the current visit's document set. */
export function deltaForCurrentFact(value: string | null, baseline: DeltaBaseline | undefined): DeltaStatus {
  if (!baseline) return "new";
  return value === baseline.value ? "unchanged" : "changed";
}

// null (not a DeltaStatus) when the field was never signed off before either — nothing to say went missing.
export function deltaForAbsentField(baseline: DeltaBaseline | undefined): DeltaStatus | null {
  return baseline ? "not_observed_in_current_document_set" : null;
}
