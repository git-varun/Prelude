import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError, type DocumentFileCheck, type DocumentReview } from "../api/client";
import { FactCard } from "../components/FactCard";
import { MarkerDisclaimerFooter } from "../components/MarkerDisclaimerFooter";
import { RoleGate } from "../auth/AuthContext";
import { IdentityDecision, IdentityNames, type IdentityOutcome } from "../components/IdentityDecision";
import { FlagForm, FlaggedTag } from "../components/HeldReport";
import { documentTypeLabel } from "../lib/documentTypeLabel";
import { sortByRisk } from "../lib/riskOrder";
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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openFormId, setOpenFormId] = useState<string | null>(null);

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
      if (result.document.identity_status === "mismatch" || result.document.identity_status === "awaiting_oncologist") {
        // Needed for the held banner. Loading and failure are shown distinctly, and Confirm
        // stays disabled until the name is known.
        void loadRecordedName(result.document.patient_id, token);
      }
      // Only probe for the raw file when there's nothing else to show --
      // the normal fact-review path never needed this endpoint before, and
      // probing it unconditionally fires a 404 (logged as a console error
      // by the browser regardless of try/catch) for documents with no file.
      const needsFileFallback =
        result.document.document_type === "other" ||
        (result.document.ocr_status === "done" &&
          (result.document.extraction_status === "failed" ||
            result.document.extraction_status === "pending" ||
            result.facts.length === 0));
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

  const sortedFacts = useMemo(() => (data ? sortByRisk(data.facts) : []), [data]);
  // Falls back to the first unchecked card (or the first card) until the reviewer picks one.
  const effectiveActiveId =
    sortedFacts.find((f) => f.id === activeId)?.id ??
    sortedFacts.find((f) => f.check_state === "unchecked")?.id ??
    sortedFacts[0]?.id ??
    null;

  // Keep the latest values reachable from one stable window listener.
  const keyState = useRef({ sortedFacts, effectiveActiveId, openFormId, load });
  keyState.current = { sortedFacts, effectiveActiveId, openFormId, load };

  // Moves the highlight to the next unchecked card after `factId` was marked, since the list re-sorts.
  const advanceFrom = useCallback((factId: string) => {
    const facts = keyState.current.sortedFacts;
    const index = facts.findIndex((f) => f.id === factId);
    const next =
      facts.find((f, i) => i > index && f.check_state === "unchecked") ?? facts.find((f) => f.id !== factId && f.check_state === "unchecked");
    if (next) setActiveId(next.id);
  }, []);

  const checkPending = useRef(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select") || t.isContentEditable)) return;
      const { sortedFacts: facts, effectiveActiveId: current, openFormId: formOpen, load: reload } = keyState.current;
      if (formOpen !== null || current === null) return;
      const index = facts.findIndex((f) => f.id === current);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Arrows on a focused button/summary/link belong to the page (scrolling, disclosure widgets).
        if (t && t.closest("button, summary, details, a")) return;
        const next = facts[index + (e.key === "ArrowDown" ? 1 : -1)];
        if (!next) return; // at a boundary: let the page scroll
        e.preventDefault();
        setActiveId(next.id);
      } else if (e.key === "c") {
        const fact = facts[index];
        if (!fact || fact.excluded_at || fact.verification_state === "oncologist_signed_off") return;
        e.preventDefault();
        if (checkPending.current) return;
        checkPending.current = true;
        api.checkFact(fact.id, { result: "correct" }).then(
          () => {
            advanceFrom(fact.id);
            void reload();
          },
          (err) => setError(err instanceof ApiError ? err.message : "Could not save the check."),
        ).finally(() => {
          checkPending.current = false;
        });
      } else if (e.key === "x") {
        const fact = facts[index];
        if (!fact || fact.verification_state === "oncologist_signed_off") return;
        e.preventDefault();
        setOpenFormId(fact.id);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [advanceFrom]);

  useEffect(() => {
    if (!effectiveActiveId) return;
    const el = window.document.querySelector(`[data-fact-id="${effectiveActiveId}"]`);
    if (el && "scrollIntoView" in el) (el as HTMLElement).scrollIntoView({ block: "nearest" });
  }, [effectiveActiveId]);

  async function applyDateToAll(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    const gen = generation.current;
    const targets = data.facts.filter((f) => f.needs_manual_date && !f.excluded_at);
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

  const { document, facts, tracked_markers, check_summary } = data;
  const checkedCount = check_summary.correct + check_summary.incorrect;
  const liveFacts = facts.filter((f) => !f.excluded_at);
  const undated = liveFacts.filter((f) => f.needs_manual_date);
  const wholeDocumentUndated = liveFacts.length > 0 && undated.length === liveFacts.length;

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>Extraction review</h1>
          <p className="muted" style={{ margin: 0 }}>
            {documentTypeLabel(document.document_type)}
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
      {(document.identity_status === "mismatch" || document.identity_status === "awaiting_oncologist") && (
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
          {document.identity_status === "awaiting_oncologist" && <p><FlaggedTag /></p>}
          <RoleGate roles={["oncologist"]}>
            <IdentityDecision
              documentId={document.id}
              onDone={identityDecided}
              confirmFirst
              confirmDisabled={recordedName === undefined || recordedError !== null}
            />
          </RoleGate>
          <RoleGate roles={["staff"]}>
            <FlagForm documentId={document.id} onDone={() => void load()} />
          </RoleGate>
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

      {document.document_type === "other" || document.extraction_status === "not_extracted" ? (
        <>
          <div className="empty-state">Not extracted in this version.</div>
          {fileCheck?.ok && (
            <div className="card">
              <h2>Uploaded file</h2>
              <OriginalDocument fileCheck={fileCheck} sourcePage={null} />
            </div>
          )}
        </>
      ) : document.ocr_status !== "done" ? (
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
            None of the {liveFacts.length} extracted fact(s) has an as-of date. Enter the date to continue the review.
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
          <div className="card" role="status">
            <strong>{checkedCount} of {check_summary.total} checked</strong>
            {check_summary.total > 0 && check_summary.unchecked === 0 && <span> All facts checked.</span>}
            <p className="field-hint" style={{ margin: "4px 0 0" }}>
              Keys: c marks the highlighted fact correct, x opens Incorrect, up and down arrows move between facts.
            </p>
          </div>
          {sortedFacts.map((fact) => (
            <div key={fact.id} style={{ marginTop: "var(--space-4)" }} onClick={() => setActiveId(fact.id)}>
              <FactCard
                fact={fact}
                trackedMarkers={tracked_markers}
                onChanged={load}
                check={{
                  active: fact.id === effectiveActiveId,
                  open: openFormId === fact.id,
                  onOpenChange: (open) => setOpenFormId(open ? fact.id : null),
                  onChecked: () => advanceFrom(fact.id),
                }}
              />
            </div>
          ))}
        </>
      )}

      <MarkerDisclaimerFooter />
    </div>
  );
}
