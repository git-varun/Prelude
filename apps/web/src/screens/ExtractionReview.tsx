import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type DocumentFileCheck, type DocumentReview } from "../api/client";
import { FactCard } from "../components/FactCard";
import { MarkerDisclaimerFooter } from "../components/MarkerDisclaimerFooter";
import { IdentityDecision, IdentityNames, type IdentityOutcome } from "../components/IdentityDecision";
import { navigate } from "../router";
import { OriginalDocument } from "./SourceView";

export function ExtractionReview({ documentId }: { documentId: string }) {
  const [data, setData] = useState<DocumentReview | null>(null);
  const [fileCheck, setFileCheck] = useState<DocumentFileCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bulkDate, setBulkDate] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [recordedName, setRecordedName] = useState<string | null | undefined>(undefined);
  const [recordedError, setRecordedError] = useState<string | null>(null);
  const [identityResult, setIdentityResult] = useState<string | null>(null);

  // latestLoad: only the newest load() may set state. generation: bumped on
  // documentId change/unmount so in-flight work for a stale screen is ignored.
  const latestLoad = useRef(0);
  const generation = useRef(0);
  const currentDocumentId = useRef<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const loadRecordedName = useCallback(async (patientId: string, token: number) => {
    setRecordedError(null);
    try {
      const r = await api.getPatientIdentityDocuments(patientId);
      if (token === latestLoad.current) setRecordedName(r.patient_name);
    } catch (err) {
      if (token === latestLoad.current) {
        setRecordedError(err instanceof ApiError ? err.message : "request failed");
      }
    }
  }, []);

  const load = useCallback(async () => {
    if (currentDocumentId.current !== documentId) return;
    const token = ++latestLoad.current;
    try {
      const result = await api.getDocumentFacts(documentId);
      if (token !== latestLoad.current) return;
      setData(result);
      setError(null);
      if (result.document.identity_status === "mismatch") {
        // Needed for the held banner. Loading and failure are shown distinctly, and Confirm
        // stays disabled until the name is known.
        void loadRecordedName(result.document.patient_id, token);
      }
      // Only probe for the raw file when there's nothing else to show --
      // the normal fact-review path never needed this endpoint before, and
      // probing it unconditionally fires a 404 (logged as a console error
      // by the browser regardless of try/catch) for documents with no file.
      const needsFileFallback =
        result.document.ocr_status === "done" &&
        (result.document.extraction_status === "failed" ||
          result.document.extraction_status === "pending" ||
          result.facts.length === 0);
      if (needsFileFallback) {
        const fc = await api.checkDocumentFile(documentId);
        if (token === latestLoad.current) setFileCheck(fc);
      }
    } catch (err) {
      if (token !== latestLoad.current) return;
      setError(err instanceof ApiError ? err.message : "Failed to load document.");
    } finally {
      if (token === latestLoad.current) setLoading(false);
    }
  }, [documentId, loadRecordedName]);

  useEffect(() => {
    currentDocumentId.current = documentId;
    setLoading(true);
    setData(null);
    setBulkError(null);
    setBulkBusy(false);
    setIdentityResult(null);
    setRecordedName(undefined);
    setRecordedError(null);
    void load();
    return () => {
      currentDocumentId.current = null;
      generation.current++;
      latestLoad.current++;
    };
  }, [load, documentId]);

  async function applyDateToAll(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    const gen = generation.current;
    const targets = data.facts.filter((f) => f.needs_manual_date);
    setBulkBusy(true);
    setError(null);
    setBulkError(null);
    let failure: string | null = null;
    let done = 0;
    for (const fact of targets) {
      try {
        await api.patchFact(fact.id, { as_of_date: bulkDate });
        done++;
      } catch (err) {
        const base = err instanceof ApiError ? err.message : "Failed to save the date for every fact.";
        failure = `${base} (${targets.length - done} of ${targets.length} fact(s) were left undated.)`;
        break;
      }
      if (gen !== generation.current) return;
    }
    if (gen !== generation.current) return;
    if (failure) setBulkError(failure);
    setBulkBusy(false);
    await load();
  }

  function identityDecided(outcome: IdentityOutcome) {
    setIdentityResult(
      outcome === "confirm"
        ? "Confirmed. This document's facts are now live in the patient's views."
        : outcome === "reject"
          ? "Rejected. This document is permanently excluded."
          : "This document's status had already changed, so the page was refreshed.",
    );
    void load();
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
            {document.document_type}
            {document.imaging_modality && ` (${document.imaging_modality.replace(/_/g, " ")})`} ·{" "}
            {document.source_origin.replace(/_/g, " ")}
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${document.patient_id}/upload`)}>
          Back to upload
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {identityResult && <div className="card" role="status">{identityResult}</div>}
      {document.identity_status === "mismatch" && (
        <div className="card" data-testid="identity-mismatch-banner">
          <strong>Held for patient identity.</strong>{" "}
          <span className="muted">The name on this report does not match the patient record, so its facts are excluded from every view until you decide.</span>
          <IdentityNames printedName={document.patient_name_on_report} recordedName={recordedName} recordedError={recordedError} />
          {recordedError && (
            <p>
              <button
                className="btn btn--secondary"
                type="button"
                onClick={() => void loadRecordedName(document.patient_id, latestLoad.current)}
              >
                Retry loading the record name
              </button>
            </p>
          )}
          <IdentityDecision
            documentId={document.id}
            onDone={identityDecided}
            confirmDisabled={recordedName === undefined || recordedError !== null}
          />
        </div>
      )}
      {document.identity_status === "partial" && (
        <div className="error-banner" data-testid="identity-partial-banner">
          Name on the report differs slightly from the record; verify this is the right patient.
        </div>
      )}
      {bulkError && <div className="error-banner">{bulkError}</div>}

      {document.extraction_status === "partial" && (
        <div className="error-banner">
          Extraction was only partial — some field types failed and were not analyzed, so facts may be missing.
          {document.extraction_error ? ` (${document.extraction_error})` : ""}
        </div>
      )}

      {document.ocr_status !== "done" ? (
        <div className="card">
          <p className="muted">
            OCR status is "{document.ocr_status}", so there are no extracted facts to review for this document.
          </p>
        </div>
      ) : document.extraction_status === "failed" ? (
        <>
          <div className="error-banner">
            Fact extraction failed for this document — it was not analyzed. This is different from "nothing found".
          </div>
          {fileCheck?.ok && (
            <div className="card">
              <h2>Uploaded file</h2>
              <OriginalDocument fileCheck={fileCheck} sourcePage={null} />
            </div>
          )}
        </>
      ) : document.extraction_status === "pending" ? (
        <div className="card">
          <p className="muted">Extraction has not run for this document yet.</p>
        </div>
      ) : facts.length === 0 ? (
        <>
          <div className="empty-state">Extraction ran and found no facts in this document.</div>
          {fileCheck?.ok && (
            <div className="card">
              <h2>Uploaded file</h2>
              <OriginalDocument fileCheck={fileCheck} sourcePage={null} />
            </div>
          )}
        </>
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

      <MarkerDisclaimerFooter />
    </div>
  );
}
