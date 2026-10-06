import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ConflictDetail, type ConflictFact } from "../api/client";
import { RoleGate } from "../auth/AuthContext";
import { navigate } from "../router";

const FIELD_LABELS: Record<string, string> = {
  marker_value: "Marker value",
  reference_range: "Reference range",
  treatment_regimen: "Treatment regimen",
  radiology_impression: "Radiology impression",
  disease_status_trend: "Disease status / trend",
};

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; detail: ConflictDetail };

function FactPane({ fact, label, authoritative }: { fact: ConflictFact; label: string; authoritative: boolean }) {
  const heading = fact.tracked_marker_name ?? FIELD_LABELS[fact.field_type] ?? fact.field_type;
  return (
    <div className="card">
      <div className="page-heading" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{label}</h3>
        {authoritative && <span className="tag">Authoritative</span>}
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {heading} · {fact.as_of_date ? `as of ${fact.as_of_date}` : "no as-of date"}
      </p>
      <p>
        {fact.value ?? <span className="muted">(no value)</span>}
        {fact.unit && ` ${fact.unit}`}
        {fact.reference_range && <span className="muted"> · ref {fact.reference_range}</span>}
      </p>
      {fact.source_snippet && <blockquote style={{ margin: 0 }}>{fact.source_snippet}</blockquote>}
      <button
        className="btn btn--ghost"
        type="button"
        style={{ marginTop: 8 }}
        onClick={() => navigate(`/documents/${fact.document_id}/source?fact=${fact.id}`)}
      >
        {fact.source_page !== null ? `Page ${fact.source_page}` : "Open document"}
      </button>
    </div>
  );
}

export function ConflictResolution({ conflictId }: { conflictId: string }) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [annotationNote, setAnnotationNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const latestLoad = useRef(0);
  const currentId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (currentId.current !== conflictId) return;
    const token = ++latestLoad.current;
    try {
      const detail = await api.getConflict(conflictId);
      if (token !== latestLoad.current) return;
      setState({ status: "ready", detail });
    } catch (err) {
      if (token !== latestLoad.current) return;
      setState({ status: "error", message: err instanceof ApiError ? err.message : "Failed to load this conflict." });
    }
  }, [conflictId]);

  useEffect(() => {
    currentId.current = conflictId;
    setState({ status: "loading" });
    void load();
    return () => {
      currentId.current = null;
      latestLoad.current++;
    };
  }, [load, conflictId]);

  async function run(label: string, action: () => Promise<unknown>) {
    setActionError(null);
    setBusy(label);
    try {
      await action();
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "That action failed.");
    } finally {
      setBusy(null);
    }
  }

  if (state.status === "loading") return <p className="muted">Loading...</p>;
  if (state.status === "error") return <div className="error-banner">{state.message}</div>;

  const { conflict, fact_a: factA, fact_b: factB } = state.detail;
  const resolved = conflict.status === "resolved";

  return (
    <div>
      <div className="page-heading">
        <h1>Conflict</h1>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${factA.patient_id}/snapshot`)}>
          Back to snapshot
        </button>
      </div>

      <p className="muted">
        Status: <span className="tag">{conflict.status}</span>
      </p>

      {actionError && <div className="error-banner">{actionError}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <FactPane fact={factA} label="Fact A" authoritative={conflict.authoritative_fact_id === factA.id} />
        <FactPane fact={factB} label="Fact B" authoritative={conflict.authoritative_fact_id === factB.id} />
      </div>

      {conflict.annotation_note && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Annotation</h3>
          <p style={{ marginBottom: 0 }}>{conflict.annotation_note}</p>
        </div>
      )}

      {resolved ? (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Resolution</h3>
          <p style={{ marginBottom: 0 }}>{conflict.resolution_note}</p>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginTop: 16 }}>
            <h3 style={{ marginTop: 0 }}>Annotate</h3>
            <div className="field">
              <label htmlFor="annotation-note">What did you find?</label>
              <textarea
                id="annotation-note"
                value={annotationNote}
                onChange={(e) => setAnnotationNote(e.target.value)}
                disabled={conflict.status === "annotated"}
              />
            </div>
            <button
              className="btn btn--secondary"
              type="button"
              disabled={busy !== null || annotationNote.trim() === "" || conflict.status === "annotated"}
              onClick={() => void run("annotate", () => api.annotateConflict(conflict.id, annotationNote.trim()))}
            >
              {busy === "annotate" ? "Saving..." : "Save annotation"}
            </button>
          </div>

          <RoleGate roles={["oncologist"]}>
            <div className="card" style={{ marginTop: 16 }}>
              <h3 style={{ marginTop: 0 }}>Resolve</h3>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  className="btn btn--primary"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run("resolve-a", () => api.resolveConflict(conflict.id, { authoritative_fact_id: factA.id }))}
                >
                  {busy === "resolve-a" ? "Resolving..." : "Mark Fact A authoritative"}
                </button>
                <button
                  className="btn btn--primary"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run("resolve-b", () => api.resolveConflict(conflict.id, { authoritative_fact_id: factB.id }))}
                >
                  {busy === "resolve-b" ? "Resolving..." : "Mark Fact B authoritative"}
                </button>
                <button
                  className="btn btn--secondary"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run("both-stand", () => api.resolveConflict(conflict.id, { both_stand: true }))}
                >
                  {busy === "both-stand" ? "Resolving..." : "Both values stand"}
                </button>
              </div>
            </div>
          </RoleGate>
        </>
      )}
    </div>
  );
}
