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

export type DocumentType = "prescription" | "blood" | "radiology" | "pathology" | "discharge";
export type ImagingModality =
  | "ct" | "ct_contrast" | "mri" | "mri_contrast" | "pet_ct" | "ultrasound" | "xray" | "mammography" | "other";
export type SourceOrigin = "own_hospital" | "outside_paper" | "outside_cd" | "whatsapp_pdf";
export type OcrStatus = "pending" | "done" | "partial" | "failed";
export type ExtractionStatus = "pending" | "done" | "failed";

export type FieldType =
  | "marker_value"
  | "reference_range"
  | "treatment_regimen"
  | "radiology_impression"
  | "disease_status_trend"
  // M3 tier 1 (AM-04). Stored verbatim as written; never normalised or computed.
  | "diagnosis"
  | "histology_ihc"
  | "stage"
  | "surgery_procedure"
  | "next_review_date"
  | "tests_advised"
  | "procedures_planned"
  | "lesion_size";

// Tier 1 types whose value is the source text itself. A value not found verbatim in the document is flagged uncertain.
export const AS_WRITTEN_FIELD_TYPES: readonly FieldType[] = [
  "treatment_regimen", "diagnosis", "histology_ihc", "stage", "surgery_procedure", "next_review_date", "tests_advised", "procedures_planned", "lesion_size",
];

// Tier 1 types where several different values on the same date are normal (two procedures, three tests, two
// diagnoses, clinical cT plus pathological pT), so they must never open a conflict against each other.
export const MULTI_VALUED_FIELD_TYPES: readonly FieldType[] = [
  "diagnosis", "stage", "histology_ihc", "surgery_procedure", "tests_advised", "procedures_planned", "lesion_size",
];

// Spot-check error options per type (M3-01: "type-specific error options"). "value" means the text read is wrong.
// NOTE: nothing consumes this map yet. The spot-check branch's check_error_type enum must gain `facility` when
// it merges (its migration 010 does not have it). Once wired, the UI and API should read this map instead of
// hard-coding one list for every type.
export type SpotCheckErrorType = "value" | "unit" | "marker" | "date" | "range" | "facility" | "not_in_document" | "wrong_patient";
const EXCLUDING: SpotCheckErrorType[] = ["not_in_document", "wrong_patient"];
export const SPOT_CHECK_ERRORS_BY_FIELD_TYPE: Record<FieldType, readonly SpotCheckErrorType[]> = {
  marker_value: ["value", "unit", "marker", "date", "range", ...EXCLUDING],
  reference_range: ["value", "unit", "marker", "date", "range", ...EXCLUDING],
  treatment_regimen: ["value", "date", ...EXCLUDING],
  radiology_impression: ["value", "date", ...EXCLUDING],
  disease_status_trend: ["value", "date", ...EXCLUDING],
  diagnosis: ["value", "date", ...EXCLUDING],
  histology_ihc: ["value", "date", ...EXCLUDING],
  stage: ["value", "date", ...EXCLUDING],
  surgery_procedure: ["value", "date", "facility", ...EXCLUDING],
  next_review_date: ["value", "date", ...EXCLUDING],
  tests_advised: ["value", "date", ...EXCLUDING],
  procedures_planned: ["value", "date", ...EXCLUDING],
  lesion_size: ["value", "date", ...EXCLUDING],
};

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

export type Sex = "male" | "female" | "other" | "unknown";
export type Stage = "0" | "I" | "II" | "III" | "IV";
export type PatientOrigin = "own_hospital" | "referral";

export const SEX_OPTIONS: readonly Sex[] = ["male", "female", "other", "unknown"];
// Overall AJCC stage only (0-IV) -- full TNM sub-staging is disease-site-specific
// and needs real clinical input to scope correctly, not guessed at here.
export const STAGE_OPTIONS: readonly Stage[] = ["0", "I", "II", "III", "IV"];
export const PATIENT_ORIGIN_OPTIONS: readonly PatientOrigin[] = ["own_hospital", "referral"];
export const IMAGING_MODALITY_OPTIONS: readonly ImagingModality[] = [
  "ct", "ct_contrast", "mri", "mri_contrast", "pet_ct", "ultrasound", "xray", "mammography", "other",
];

export interface Patient {
  id: string;
  name: string | null;
  cancer_type: string | null;
  created_at: string;
  created_by: string;
  date_of_birth: string | null;
  sex: Sex | null;
  mrn: string | null;
  diagnosis_date: string | null;
  stage: Stage | null;
  referring_physician: string | null;
  patient_origin: PatientOrigin;
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
  imaging_modality: ImagingModality | null;
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
