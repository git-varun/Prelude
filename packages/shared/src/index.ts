export {
  CONTROLLED_MARKERS, isControlledMarker, matchMarker,
  MARKER_REGISTRY, DISEASE_SITE_PANELS, DISEASE_SITES, FALLBACK_MARKER_SET,
} from "./markers";
export type { MarkerDefinition } from "./markers";
export type { OcrPage, OcrResult, OcrProvider } from "./providers/ocr";
export type { ExtractedCoverageStatus, ExtractedFactCandidate, ExtractionProvider, ExtractionResult } from "./providers/extraction";

export type UserRole = "staff" | "oncologist";

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  created_at: string;
}

export type DocumentType = "prescription" | "blood" | "radiology";
export type SourceOrigin = "own_hospital" | "outside_paper" | "outside_cd" | "whatsapp_pdf";
export type OcrStatus = "pending" | "done" | "partial" | "failed";
export type ExtractionStatus = "pending" | "done" | "failed";

export type FieldType =
  | "marker_value"
  | "reference_range"
  | "treatment_regimen"
  | "radiology_impression"
  | "disease_status_trend";

// Five stored values only (Invariants §1). not_found_in_document_set is
// synthesized at snapshot-read time and never persisted on a FACT row.
export type CoverageStatus =
  | "value_found"
  | "not_assessed"
  | "not_applicable"
  | "extraction_uncertain"
  | "conflicting_sources";

export type SnapshotCoverageStatus = CoverageStatus | "not_found_in_document_set";

export type VerificationState =
  | "unverified"
  | "staff_corrected"
  | "oncologist_signed_off"
  | "reopened_by_oncologist";

export type DeltaStatus = "new" | "changed" | "unchanged" | "not_observed_in_current_document_set";

export type ConflictStatus = "open" | "annotated" | "resolved";

export interface Patient {
  id: string;
  name: string | null;
  cancer_type: string | null;
  created_at: string;
  created_by: string;
}

export interface Visit {
  id: string;
  patient_id: string;
  visit_date: string;
}

export interface TrackedMarker {
  id: string;
  patient_id: string;
  marker_name: string;
  is_custom: boolean;
  added_at: string;
  added_by: string;
}

export interface Document {
  id: string;
  patient_id: string;
  visit_id: string;
  file_ref: string;
  document_type: DocumentType;
  source_origin: SourceOrigin;
  uploaded_by: string;
  uploaded_at: string;
  ocr_status: OcrStatus;
  ocr_text_ref: string | null;
  needs_manual_date: boolean;
  extraction_status: ExtractionStatus;
}

export interface Fact {
  id: string;
  patient_id: string;
  visit_id: string;
  document_id: string;
  tracked_marker_id: string | null;
  field_type: FieldType;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  as_of_date: string | null;
  needs_manual_date: boolean;
  raw_marker_label: string | null;
  coverage_status: CoverageStatus;
  verification_state: VerificationState;
  delta_status: DeltaStatus | null;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
  corrected_by: string | null;
  signed_off_by: string | null;
  signed_off_at: string | null;
  reopened_by: string | null;
  reopened_at: string | null;
}

export interface Conflict {
  id: string;
  fact_id_a: string;
  fact_id_b: string;
  status: ConflictStatus;
  authoritative_fact_id: string | null;
  annotation_note: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}
