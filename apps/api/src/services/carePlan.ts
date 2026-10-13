import { sql } from "../db/client";
import { LIVE_FACT_FILTER } from "./delta";
import type { CandidateDocument } from "./carePlanLogic";

type Exec = typeof sql;

// Creates (or refreshes) the plan item for a signed-off fact, reading the fact from the DB so values stay
// verbatim and dates never pass through a JS Date. Idempotent on source_fact_id, so the single sign-off route
// and the later batch sign-off (M3-04) can both call it inside their own transaction. Unsigned facts, other
// field types, and valueless or undated facts create nothing.
export async function createPlanItemFromFact(tx: Exec, factId: string, userId: string): Promise<void> {
  await tx`
    INSERT INTO care_plan_items (patient_id, type, text, advised_at, source_fact_id, created_by)
    SELECT f.patient_id,
           CASE f.field_type WHEN 'tests_advised' THEN 'test' WHEN 'procedures_planned' THEN 'procedure' ELSE 'review' END,
           f.value, f.as_of_date, f.id, ${userId}
    FROM facts f
    WHERE f.id = ${factId} AND f.verification_state = 'oncologist_signed_off'
      AND f.field_type IN ('tests_advised', 'procedures_planned', 'next_review_date')
      AND btrim(COALESCE(f.value, '')) <> '' AND f.as_of_date IS NOT NULL
    ON CONFLICT (source_fact_id) DO UPDATE SET text = EXCLUDED.text, advised_at = EXCLUDED.advised_at
  `;
}

const MODALITY_LABELS: Record<string, string> = {
  ct: "CT", ct_contrast: "CT with contrast", mri: "MRI", mri_contrast: "MRI with contrast", pet_ct: "PET-CT",
  ultrasound: "Ultrasound", xray: "X-ray", mammography: "Mammography", other: "Imaging",
};
const TYPE_LABELS: Record<string, string> = {
  blood: "Blood report", radiology: "Radiology report", prescription: "Prescription", pathology: "Pathology report",
  discharge: "Discharge summary",
};

// Documents of the patient that could be a report for a plan item: not held or rejected for identity, with a
// date (reported_on, else collected_on, else the latest as_of_date of their live facts).
export async function loadCandidateDocuments(patientId: string): Promise<CandidateDocument[]> {
  const rows = await sql`
    SELECT d.id, d.document_type, d.imaging_modality,
           to_char(COALESCE(d.reported_on, d.collected_on, (
             SELECT max(f.as_of_date) FROM facts f WHERE f.document_id = d.id AND ${LIVE_FACT_FILTER}
           )), 'YYYY-MM-DD') AS date,
           COALESCE((
             SELECT array_agg(DISTINCT COALESCE(tm.marker_name, f.raw_marker_label))
             FROM facts f LEFT JOIN tracked_markers tm ON tm.id = f.tracked_marker_id
             WHERE f.document_id = d.id AND f.field_type = 'marker_value' AND ${LIVE_FACT_FILTER}
               AND COALESCE(tm.marker_name, f.raw_marker_label) IS NOT NULL
           ), '{}') AS markers
    FROM documents d
    WHERE d.patient_id = ${patientId} AND COALESCE(d.identity_status::text, '') NOT IN ('mismatch', 'rejected')
  `;
  return rows.map((r: any) => ({
    id: r.id as string,
    label: [r.imaging_modality ? MODALITY_LABELS[r.imaging_modality] : TYPE_LABELS[r.document_type] ?? r.document_type, r.date]
      .filter(Boolean).join(" · "),
    imaging_modality: r.imaging_modality as string | null,
    markers: r.markers as string[],
    date: r.date as string | null,
  }));
}
