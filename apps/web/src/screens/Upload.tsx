import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  IMAGING_MODALITY_OPTIONS,
  type DocumentRecord,
  type ImagingModality,
  type PatientDetail,
  type Visit,
} from "../api/client";
import { navigate } from "../router";

const DOCUMENT_TYPES = ["prescription", "blood", "radiology"] as const;
const SOURCE_ORIGINS = ["own_hospital", "outside_paper", "outside_cd", "whatsapp_pdf"] as const;

// m1-backlog B8: createOrOpenVisit is idempotent per patient/day, but the
// screen re-mounts (and re-POSTs) every time staff navigate back to it in
// the same session. Cache per patient+day (module-level, so it survives
// remounts but not a page reload) to skip the redundant round-trip; keyed
// by day so it self-invalidates across a midnight rollover.
//
// Local date, not UTC: toISOString() is UTC, so a clinic anywhere east of
// Greenwich (e.g. IST, UTC+5:30) filed documents under *yesterday* for the
// first several hours of every local day, and clinics west of Greenwich get
// the opposite problem in the evening -- either way, one real visit could
// split across two visit rows. The server still has a UTC fallback for a
// caller that omits the date, but this screen always supplies its own.
const visitCache = new Map<string, Visit>();
function localDateString(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function visitCacheKey(patientId: string): string {
  return `${patientId}:${localDateString()}`;
}

export function Upload({ patientId }: { patientId: string }) {
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [visit, setVisit] = useState<Visit | null>(null);
  const [loadingPatient, setLoadingPatient] = useState(true);
  const [documentType, setDocumentType] = useState<(typeof DOCUMENT_TYPES)[number]>("blood");
  const [imagingModality, setImagingModality] = useState<ImagingModality>("ct");
  const [sourceOrigin, setSourceOrigin] = useState<(typeof SOURCE_ORIGINS)[number]>("own_hospital");
  const [uploaded, setUploaded] = useState<DocumentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Guards against a stale response overwriting state if patientId changes
    // (hash navigation to a different patient) before this request settles.
    let current = true;
    setLoadingPatient(true);
    setPatient(null);
    setVisit(null);

    api
      .getPatient(patientId)
      .then((p) => {
        if (current) setPatient(p);
      })
      .catch((err) => {
        if (current) setError(err instanceof ApiError ? err.message : "Failed to load patient.");
      })
      .finally(() => {
        if (current) setLoadingPatient(false);
      });
    const cacheKey = visitCacheKey(patientId);
    const cachedVisit = visitCache.get(cacheKey);
    if (cachedVisit) {
      setVisit(cachedVisit);
    } else {
      api
        .createOrOpenVisit(patientId, localDateString())
        .then((v) => {
          visitCache.set(cacheKey, v);
          if (current) setVisit(v);
        })
        .catch((err) => {
          if (current) setError(err instanceof ApiError ? err.message : "Failed to open visit.");
        });
    }

    return () => {
      current = false;
    };
  }, [patientId]);

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file || !visit) return;

    setError(null);
    setUploading(true);
    try {
      const doc = await api.uploadDocument(patientId, {
        visit_id: visit.id,
        document_type: documentType,
        imaging_modality: documentType === "radiology" ? imagingModality : undefined,
        source_origin: sourceOrigin,
        file,
      });
      setUploaded((prev) => [doc, ...prev]);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>{loadingPatient ? "Loading patient..." : patient?.name || "(unnamed patient)"}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {patient?.cancer_type}
            {visit && ` · Visit ${visit.visit_date}`}
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => navigate("/patients")}>
          Back to patients
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {patient && (
        <div className="card">
          <h2>Tracked markers</h2>
          {patient.tracked_markers.length === 0 && <p className="muted">No markers tracked yet.</p>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {patient.tracked_markers.map((m) => (
              <span key={m.id} className={`tag ${m.is_custom ? "tag--custom" : ""}`}>
                {m.marker_name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Upload document</h2>
        <form onSubmit={handleUpload}>
          <div className="field">
            <label htmlFor="document_type">Document type</label>
            <select
              id="document_type"
              value={documentType}
              onChange={(e) => setDocumentType(e.target.value as (typeof DOCUMENT_TYPES)[number])}
            >
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          {documentType === "radiology" && (
            <div className="field">
              <label htmlFor="imaging_modality">Imaging modality</label>
              <select
                id="imaging_modality"
                value={imagingModality}
                onChange={(e) => setImagingModality(e.target.value as ImagingModality)}
              >
                {IMAGING_MODALITY_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="source_origin">Source</label>
            <select
              id="source_origin"
              value={sourceOrigin}
              onChange={(e) => setSourceOrigin(e.target.value as (typeof SOURCE_ORIGINS)[number])}
            >
              {SOURCE_ORIGINS.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="file">File</label>
            <input id="file" type="file" ref={fileInputRef} required />
          </div>
          <button className="btn btn--primary" type="submit" disabled={uploading || !visit}>
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </form>
      </div>

      {uploaded.length > 0 && (
        <div className="card">
          <h2>Uploaded this session</h2>
          {uploaded.map((doc) => (
            <div key={doc.id} className="patient-row">
              <span>
                {doc.document_type}
                {doc.imaging_modality && ` (${doc.imaging_modality.replace(/_/g, " ")})`} · {doc.source_origin.replace(/_/g, " ")}
              </span>
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="tag tag--pending">OCR: {doc.ocr_status}</span>
                <button
                  className="btn btn--ghost source-link"
                  type="button"
                  onClick={async () => {
                    const fc = await api.checkDocumentFile(doc.id);
                    if (fc.ok) window.open(fc.url, "_blank", "noopener");
                  }}
                >
                  📄 View uploaded file
                </button>
                {doc.ocr_status === "done" && (
                  <button className="btn btn--ghost" type="button" onClick={() => navigate(`/documents/${doc.id}/review`)}>
                    Review extraction
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
