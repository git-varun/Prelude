import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type DocumentReview } from "../api/client";
import { FactCard } from "../components/FactCard";
import { navigate } from "../router";

export function ExtractionReview({ documentId }: { documentId: string }) {
  const [data, setData] = useState<DocumentReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bulkDate, setBulkDate] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.getDocumentFacts(documentId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load document.");
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    void load();
  }, [load]);

  async function applyDateToAll(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setBulkBusy(true);
    setError(null);
    try {
      for (const fact of data.facts.filter((f) => f.needs_manual_date)) {
        await api.patchFact(fact.id, { as_of_date: bulkDate });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save the date for every fact.");
    } finally {
      setBulkBusy(false);
      await load();
    }
  }

  if (loading) return <p className="muted">Loading...</p>;
  if (!data) return <div className="error-banner">{error ?? "Document not found."}</div>;

  const { document, facts, tracked_markers } = data;
  const undated = facts.filter((f) => f.needs_manual_date);
  const wholeDocumentUndated = facts.length > 0 && undated.length === facts.length;

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>Extraction review</h1>
          <p className="muted" style={{ margin: 0 }}>
            {document.document_type} · {document.source_origin.replace(/_/g, " ")}
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${document.patient_id}/upload`)}>
          Back to upload
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {document.ocr_status !== "done" ? (
        <div className="card">
          <p className="muted">
            OCR status is "{document.ocr_status}", so there are no extracted facts to review for this document.
          </p>
        </div>
      ) : document.extraction_status === "failed" ? (
        <div className="error-banner">
          Fact extraction failed for this document — it was not analyzed. This is different from "nothing found".
        </div>
      ) : document.extraction_status === "pending" ? (
        <div className="card">
          <p className="muted">Extraction has not run for this document yet.</p>
        </div>
      ) : facts.length === 0 ? (
        <div className="empty-state">Extraction ran and found no facts in this document.</div>
      ) : wholeDocumentUndated ? (
        <div className="card">
          <h2>No date found in this document</h2>
          <p className="muted">
            None of the {facts.length} extracted fact(s) has an as-of date. Enter the date to continue the review.
          </p>
          <form onSubmit={applyDateToAll} className="field">
            <label htmlFor="bulk-date">As-of date for all facts</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id="bulk-date" type="date" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} required />
              <button className="btn btn--primary" type="submit" disabled={bulkBusy || !bulkDate}>
                {bulkBusy ? "Saving..." : "Apply date"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          {undated.length > 0 && (
            <div className="card">
              <p style={{ margin: 0 }}>
                {undated.length} fact(s) have no as-of date — enter one on each card below. Facts without a date can be
                corrected but not signed off.
              </p>
            </div>
          )}
          {facts.map((fact) => (
            <FactCard key={fact.id} fact={fact} trackedMarkers={tracked_markers} onChanged={load} />
          ))}
        </>
      )}
    </div>
  );
}
