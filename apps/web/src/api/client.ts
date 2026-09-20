import type { UserRole } from "@opd/shared";

const API_BASE_URL = process.env.OPD_API_URL ?? "http://localhost:3001";

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
  const res = await fetch(`${API_BASE_URL}${path}`, {
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

export interface PatientSummary {
  id: string;
  name: string | null;
  cancer_type: string | null;
  created_at: string;
  created_by: string;
}

export interface TrackedMarker {
  id: string;
  marker_name: string;
  is_custom: boolean;
  added_at: string;
  added_by: string;
}

export interface PatientDetail extends PatientSummary {
  tracked_markers: TrackedMarker[];
}

export interface Visit {
  id: string;
  patient_id: string;
  visit_date: string;
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
}

export const api = {
  login: (email: string, password: string) =>
    request<SessionUser>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),

  logout: () => request<void>("/auth/logout", { method: "POST" }),

  me: () => request<SessionUser>("/auth/me"),

  listPatients: (search?: string) =>
    request<PatientSummary[]>(`/patients${search ? `?search=${encodeURIComponent(search)}` : ""}`),

  getPatient: (id: string) => request<PatientDetail>(`/patients/${id}`),

  createPatient: (input: { name: string; cancer_type: string; markers: { marker_name: string }[] }) =>
    request<PatientDetail>("/patients", { method: "POST", body: JSON.stringify(input) }),

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
};
