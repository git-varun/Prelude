import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type IdentityDocument, type PatientIdentityDocuments } from "../api/client";
import { IdentityDecision, IdentityNames, type IdentityOutcome } from "../components/IdentityDecision";
import { documentTypeLabel } from "../lib/documentTypeLabel";
import { navigate } from "../router";

const OUTCOME_MESSAGES: Record<IdentityOutcome, string> = {
  confirm: "Confirmed. This document's facts are now live in the patient's views.",
  reject: "Rejected. This document is permanently excluded.",
  stale: "This document's status had already changed, so the list was refreshed.",
};

function DocMeta({ doc }: { doc: IdentityDocument }) {
  return (
    <p className="muted" style={{ margin: "0 0 4px" }}>
      {documentTypeLabel(doc.document_type)} · {doc.lab_name ?? "lab not read"} · uploaded {doc.uploaded_at.slice(0, 10)}
    </p>
  );
}

function ReviewLink({ id }: { id: string }) {
  return (
    <a
      href={`#/documents/${id}/review`}
      onClick={(e) => {
        e.preventDefault();
        navigate(`/documents/${id}/review`);
      }}
    >
      Open extraction review
    </a>
  );
}

export function HeldDocuments({ patientId }: { patientId: string }) {
  const [data, setData] = useState<PatientIdentityDocuments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [results, setResults] = useState<{ id: string; text: string }[]>([]);

  const latestLoad = useRef(0);
  const currentPatientId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (currentPatientId.current !== patientId) return;
    const token = ++latestLoad.current;
    try {
      const result = await api.getPatientIdentityDocuments(patientId);
      if (token !== latestLoad.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (token !== latestLoad.current) return;
      setError(err instanceof ApiError ? err.message : "Failed to load held documents.");
    } finally {
      if (token === latestLoad.current) setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    currentPatientId.current = patientId;
    setLoading(true);
    setData(null);
    setResults([]);
    void load();
    return () => {
      currentPatientId.current = null;
      latestLoad.current++;
    };
  }, [load, patientId]);

  function decided(doc: IdentityDocument, outcome: IdentityOutcome) {
    setResults((prev) => [
      { id: `${doc.id}-${prev.length}`, text: `${doc.lab_name ?? documentTypeLabel(doc.document_type)}: ${OUTCOME_MESSAGES[outcome]}` },
      ...prev,
    ]);
    // Drop the row immediately so a second click cannot reach it, then reload for the server's truth.
    setData((d) => (d ? { ...d, documents: d.documents.filter((x) => x.id !== doc.id) } : d));
    void load();
  }

  if (loading) return <p className="muted">Loading...</p>;
  if (!data) return <div className="error-banner">{error ?? "Patient not found."}</div>;

  const held = data.documents.filter((d) => d.identity_status === "mismatch");
  const partial = data.documents.filter((d) => d.identity_status === "partial");

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>Held documents</h1>
          <p className="muted" style={{ margin: 0 }}>{data.patient_name || "(unnamed patient)"}</p>
        </div>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${patientId}/snapshot`)}>
          Back to Snapshot
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {results.map((r) => (
        <div className="card" role="status" key={r.id}>{r.text}</div>
      ))}

      <section aria-labelledby="section-held" style={{ marginBottom: 32 }}>
        <h2 id="section-held">Held</h2>
        <p className="muted">
          The name printed on these reports does not match the patient record, so their facts are excluded from every view until you decide.
        </p>
        {held.length === 0 ? (
          <div className="empty-state">No documents held.</div>
        ) : (
          held.map((doc) => (
            <div className="card" key={doc.id} data-testid="held-row">
              <DocMeta doc={doc} />
              <IdentityNames printedName={doc.patient_name_on_report} recordedName={data.patient_name} />
              <p><ReviewLink id={doc.id} /></p>
              <IdentityDecision documentId={doc.id} onDone={(o) => decided(doc, o)} />
            </div>
          ))
        )}
      </section>

      {partial.length > 0 && (
        <section aria-labelledby="section-partial" style={{ marginBottom: 32 }}>
          <h2 id="section-partial">Accepted with a name difference</h2>
          <p className="muted">
            The name on these reports differs slightly from the record. Their facts are live; verify each is the right patient.
          </p>
          {partial.map((doc) => (
            <div className="card" key={doc.id} data-testid="partial-row">
              <DocMeta doc={doc} />
              <IdentityNames printedName={doc.patient_name_on_report} recordedName={data.patient_name} />
              <p style={{ marginBottom: 0 }}><ReviewLink id={doc.id} /></p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
