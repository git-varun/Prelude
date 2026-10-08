import type { UserRole } from "@prelude/shared";

// Runtime config from server.ts (PUBLIC_API_URL). `process.env` doesn't exist in
// the browser, so the client asks the server for its one public setting.
// Resolved lazily inside request() rather than at module load: a failed or slow
// /config.json then surfaces as an ordinary failed request (the app's
// "couldn't reach the server" state) instead of stopping React from mounting.
// The fetch is bounded so a hung server rejects (same path as any failure) instead
// of leaving the login screen blank forever.
const CONFIG_TIMEOUT_MS = 8000;
let apiBaseUrl: Promise<string> | null = null;
function getApiBaseUrl(): Promise<string> {
  apiBaseUrl ??= fetch("/config.json", { signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS) })
    .then((res) => {
      if (!res.ok) throw new Error(`/config.json returned ${res.status}`);
      return res.json() as Promise<{ apiUrl?: unknown }>;
    })
    .then((config) => {
      if (typeof config?.apiUrl !== "string" || config.apiUrl === "") {
        throw new Error("/config.json is missing a non-empty apiUrl");
      }
      return config.apiUrl;
    })
    .catch((err) => {
      apiBaseUrl = null; // don't cache a failure; the next request retries
      throw err;
    });
  return apiBaseUrl;
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${await getApiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
    headers:
      init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json", ...init.headers }
        : init.headers,
  });

  if (res.status === 204) {
    return undefined as T;
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? "unknown_error", body?.message ?? res.statusText);
  }
  return body as T;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
}

export type Sex = "male" | "female" | "other" | "unknown";
export type Stage = "0" | "I" | "II" | "III" | "IV";
export type PatientOrigin = "own_hospital" | "referral";

export const SEX_OPTIONS: readonly Sex[] = ["male", "female", "other", "unknown"];
export const STAGE_OPTIONS: readonly Stage[] = ["0", "I", "II", "III", "IV"];
export const PATIENT_ORIGIN_OPTIONS: readonly PatientOrigin[] = ["own_hospital", "referral"];

export interface PatientSummary {
  id: string;
  name: string | null;
  cancer_type: string | null;
  created_at: string;
  created_by: string;
  mrn: string | null;
  patient_origin: PatientOrigin;
  date_of_birth: string | null;
  stage: Stage | null;
  last_visit_date: string | null;
}

export interface TrackedMarker {
  id: string;
  marker_name: string;
  is_custom: boolean;
  added_at: string;
  added_by: string;
}

export interface PatientDetail extends PatientSummary {
  sex: Sex | null;
  diagnosis_date: string | null;
  referring_physician: string | null;
  tracked_markers: TrackedMarker[];
}

export interface Visit {
  id: string;
  patient_id: string;
  visit_date: string;
}

export interface VisitHistoryEntry {
  id: string;
  visit_date: string;
  document_count: number;
  fact_count: number;
  signed_off_count: number;
}

export interface DocumentRecord {
  id: string;
  patient_id: string;
  visit_id: string;
  file_ref: string;
  document_type: string;
  source_origin: string;
  uploaded_by: string;
  uploaded_at: string;
  ocr_status: string;
  ocr_text_ref: string | null;
  needs_manual_date: boolean;
  extraction_status: "pending" | "done" | "partial" | "failed";
  extraction_error: string | null;
}

export interface ReviewFact {
  id: string;
  patient_id: string;
  visit_id: string;
  document_id: string;
  tracked_marker_id: string | null;
  tracked_marker_name: string | null;
  raw_marker_label: string | null;
  field_type: string;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  as_of_date: string | null;
  needs_manual_date: boolean;
  coverage_status: string;
  verification_state: string;
  has_blocking_conflict: boolean;
  blocking_conflict_id: string | null;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
  fallback_level: "exact" | "page" | "document";
}

export interface DocumentReview {
  document: DocumentRecord;
  facts: ReviewFact[];
  tracked_markers: TrackedMarker[];
}

export interface DocumentOcrPage {
  pageNumber: number;
  text: string;
}

export interface DocumentOcr {
  fullText: string;
  pages: DocumentOcrPage[];
}

export interface DocumentWithOcr {
  document: DocumentRecord;
  ocr: DocumentOcr | null;
}

// Whether the original file is renderable, found via a direct probe request rather than relying
// on <img>/<iframe> onerror (unreliable for PDFs) — a non-ok result is the Source view's cue to
// fall back to OCR text.
export interface DocumentFileCheck {
  ok: boolean;
  contentType: string | null;
  url: string;
}

export interface Provenance {
  document_id: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
  fallback_level: "exact" | "page" | "document";
}

export interface ConflictEntry {
  conflict_id: string;
  status: string;
  other_fact_id: string;
  other_value: string | null;
  other_source: Provenance;
  authoritative_fact_id: string | null;
  historical: boolean;
}

export type DeltaStatus = "new" | "changed" | "unchanged" | "not_observed_in_current_document_set";

export interface SnapshotField {
  fact_id: string | null;
  field_type: string;
  tracked_marker_id: string | null;
  marker_name: string | null;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  as_of_date: string | null;
  coverage_status: string;
  verification_state: string | null;
  delta_status: DeltaStatus | null;
  conflicts: ConflictEntry[];
  provenance: Provenance | null;
}

export interface PatientSnapshot {
  patient: {
    id: string;
    name: string | null;
    cancer_type: string | null;
    mrn: string | null;
    sex: Sex | null;
    patient_origin: PatientOrigin;
    stage: Stage | null;
    referring_physician: string | null;
    date_of_birth: string | null;
    diagnosis_date: string | null;
  };
  current_visit: { id: string; visit_date: string };
  previous_visit: { id: string | null; visit_date: string | null };
  current_treatment: SnapshotField[];
  tumor_markers: SnapshotField[];
  radiology: SnapshotField[];
  since_last_visit: SnapshotField[];
}

export interface MarkerTrendPoint {
  fact_id: string;
  value: string;
  unit: string | null;
  reference_range: string | null;
  as_of_date: string;
  visit_id: string;
}

export interface MarkerTrend {
  marker_name: string;
  points: MarkerTrendPoint[];
}

export interface Conflict {
  id: string;
  fact_id_a: string;
  fact_id_b: string;
  status: "open" | "annotated" | "resolved";
  authoritative_fact_id: string | null;
  annotation_note: string | null;
  resolution_note: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
}

export interface ConflictFact {
  id: string;
  patient_id: string;
  visit_id: string;
  document_id: string;
  tracked_marker_id: string | null;
  tracked_marker_name: string | null;
  field_type: string;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  as_of_date: string | null;
  coverage_status: string;
  verification_state: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
}

export interface ConflictDetail {
  conflict: Conflict;
  fact_a: ConflictFact;
  fact_b: ConflictFact;
}

export const api = {
  login: (email: string, password: string) =>
    request<SessionUser>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  me: () => request<SessionUser>("/auth/me"),

  listPatients: (search?: string) =>
    request<PatientSummary[]>(`/patients${search ? `?search=${encodeURIComponent(search)}` : ""}`),

  getPatient: (id: string) => request<PatientDetail>(`/patients/${id}`),

  getPatientSnapshot: (id: string) => request<PatientSnapshot>(`/patients/${id}/snapshot`),

  getMarkerTrend: (patientId: string, trackedMarkerId: string) =>
    request<MarkerTrend>(`/patients/${patientId}/markers/${trackedMarkerId}/trend`),

  createPatient: (input: {
    name: string;
    cancer_type: string;
    markers: { marker_name: string }[];
    date_of_birth?: string;
    sex?: Sex;
    mrn?: string;
    diagnosis_date?: string;
    stage?: Stage;
    referring_physician?: string;
    patient_origin?: PatientOrigin;
  }) => request<PatientDetail>("/patients", { method: "POST", body: JSON.stringify(input) }),

  updatePatient: (
    id: string,
    patch: Partial<{
      name: string;
      cancer_type: string;
      date_of_birth: string;
      sex: Sex;
      mrn: string;
      diagnosis_date: string;
      stage: Stage;
      referring_physician: string;
      patient_origin: PatientOrigin;
    }>,
  ) => request<PatientDetail>(`/patients/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  addMarker: (patientId: string, markerName: string) =>
    request<TrackedMarker>(`/patients/${patientId}/markers`, {
      method: "POST",
      body: JSON.stringify({ marker_name: markerName }),
    }),

  createOrOpenVisit: (patientId: string, visitDate?: string) =>
    request<Visit>(`/patients/${patientId}/visits`, {
      method: "POST",
      body: JSON.stringify(visitDate ? { visit_date: visitDate } : {}),
    }),

  listVisits: (patientId: string) => request<VisitHistoryEntry[]>(`/patients/${patientId}/visits`),

  uploadDocument: (
    patientId: string,
    input: { visit_id: string; document_type: string; source_origin: string; file: File },
  ) => {
    const form = new FormData();
    form.set("visit_id", input.visit_id);
    form.set("document_type", input.document_type);
    form.set("source_origin", input.source_origin);
    form.set("file", input.file);
    return request<DocumentRecord>(`/patients/${patientId}/documents`, { method: "POST", body: form });
  },

  getDocumentFacts: (documentId: string) => request<DocumentReview>(`/documents/${documentId}/facts`),

  getDocument: (documentId: string) => request<DocumentWithOcr>(`/documents/${documentId}`),

  checkDocumentFile: async (documentId: string): Promise<DocumentFileCheck> => {
    const url = `${await getApiBaseUrl()}/documents/${documentId}/file`;
    try {
      const res = await fetch(url, { credentials: "include" });
      return { ok: res.ok, contentType: res.ok ? res.headers.get("content-type") : null, url };
    } catch {
      return { ok: false, contentType: null, url };
    }
  },

  patchFact: (factId: string, patch: { value?: string; tracked_marker_id?: string; as_of_date?: string }) =>
    request<ReviewFact>(`/facts/${factId}`, { method: "PATCH", body: JSON.stringify(patch) }),

  signOffFact: (factId: string) => request<ReviewFact>(`/facts/${factId}/sign-off`, { method: "POST" }),

  reopenFact: (factId: string) => request<ReviewFact>(`/facts/${factId}/reopen`, { method: "POST" }),

  getConflict: (conflictId: string) => request<ConflictDetail>(`/conflicts/${conflictId}`),

  annotateConflict: (conflictId: string, annotationNote: string) =>
    request<Conflict>(`/conflicts/${conflictId}/annotate`, {
      method: "POST",
      body: JSON.stringify({ annotation_note: annotationNote }),
    }),

  resolveConflict: (conflictId: string, body: { authoritative_fact_id: string } | { both_stand: true }) =>
    request<Conflict>(`/conflicts/${conflictId}/resolve`, { method: "POST", body: JSON.stringify(body) }),
};
