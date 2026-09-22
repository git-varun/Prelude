import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type DocumentRecord, type PatientDetail, type Visit } from "../api/client";
import { navigate } from "../router";

const DOCUMENT_TYPES = ["prescription", "blood", "radiology"] as const;
const SOURCE_ORIGINS = ["own_hospital", "outside_paper", "outside_cd", "whatsapp_pdf"] as const;

export function Upload({ patientId }: { patientId: string }) {
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [visit, setVisit] = useState<Visit | null>(null);
  const [loadingPatient, setLoadingPatient] = useState(true);
  const [documentType, setDocumentType] = useState<(typeof DOCUMENT_TYPES)[number]>("blood");
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
    api
      .createOrOpenVisit(patientId)
      .then((v) => {
        if (current) setVisit(v);
      })
      .catch((err) => {
        if (current) setError(err instanceof ApiError ? err.message : "Failed to open visit.");
      });

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
      const doc = await api.uploadDocument(patientId, { visit_id: visit.id, document_type: documentType, source_origin: sourceOrigin, file });
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
                {doc.document_type} · {doc.source_origin.replace(/_/g, " ")}
              </span>
              <span className="tag tag--pending">{doc.ocr_status}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
