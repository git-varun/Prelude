import { useEffect, useState } from "react";
import { api, ApiError, type VisitHistoryEntry } from "../api/client";
import { navigate } from "../router";

export function VisitHistory({ patientId }: { patientId: string }) {
  const [visits, setVisits] = useState<VisitHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api
      .listVisits(patientId)
      .then((v) => {
        if (current) setVisits(v);
      })
      .catch((err) => {
        if (current) setError(err instanceof ApiError ? err.message : "Failed to load visit history.");
      });
    return () => {
      current = false;
    };
  }, [patientId]);

  return (
    <div>
      <div className="page-heading">
        <h1>Visit history</h1>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${patientId}/snapshot`)}>
          Back to Snapshot
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {visits === null ? (
        <p className="muted">Loading...</p>
      ) : visits.length === 0 ? (
        <div className="empty-state">No visits recorded yet.</div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          {visits.map((v) => (
            <div className="delta-row" key={v.id}>
              <span className="delta-row__name">{v.visit_date}</span>
              <span className="delta-row__meta">
                <span className="tag">
                  {v.document_count} document{v.document_count === 1 ? "" : "s"}
                </span>
                <span className="tag">
                  {v.fact_count} fact{v.fact_count === 1 ? "" : "s"}
                </span>
                <span className="tag">
                  {v.signed_off_count} signed off
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
