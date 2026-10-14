import { useEffect, useRef, useState } from "react";
import { RoleGate, useAuth } from "../auth/AuthContext";
import { api, ApiError, type IdentityDocument, type IdentityPreview, type StaffAssessment } from "../api/client";
import { IdentityDecision, type IdentityOutcome } from "./IdentityDecision";
import { navigate } from "../router";

const ASSESSMENT_OPTIONS: { value: StaffAssessment; label: string }[] = [
  { value: "likely_same", label: "Likely the same patient" },
  { value: "likely_different", label: "Likely a different patient" },
  { value: "cannot_tell", label: "Can't tell" },
];

export const ASSESSMENT_WORDS: Record<StaffAssessment, string> = {
  likely_same: "Staff think this is the same patient",
  likely_different: "Staff think this is a different patient",
  cannot_tell: "Staff can't tell whether this is the same patient",
};

const FIELD_LABELS: Record<string, string> = {
  marker_value: "Marker values",
  reference_range: "Reference ranges",
  treatment_regimen: "Treatment regimen",
  radiology_impression: "Radiology impressions",
  disease_status_trend: "Disease status / trend",
  diagnosis: "Diagnosis",
  histology_ihc: "Histology / IHC",
  stage: "Stage",
  surgery_procedure: "Surgery / procedure",
  next_review_date: "Next review",
  tests_advised: "Tests advised",
  procedures_planned: "Procedures planned",
  lesion_size: "Lesion size",
};

export function isFlagged(doc: Pick<IdentityDocument, "identity_status">): boolean {
  return doc.identity_status === "awaiting_oncologist";
}

/** Neutral tag for a document the staff flagged and the oncologist has not decided. */
export function FlaggedTag() {
  return <span className="tag" data-testid="flagged-tag">Staff assessment · awaiting oncologist</span>;
}

/** The staff assessment in plain words, with the note and who/when. */
export function StaffAssessmentLine({ doc }: { doc: IdentityDocument }) {
  if (!doc.staff_identity_assessment) return null;
  return (
    <p data-testid="staff-assessment" style={{ margin: "4px 0" }}>
      <strong>{ASSESSMENT_WORDS[doc.staff_identity_assessment]}.</strong>
      {doc.staff_identity_note && <> Note: {doc.staff_identity_note}</>}
      <span className="muted">
        {" "}
        {doc.staff_identity_by_name ? `· ${doc.staff_identity_by_name}` : ""}
        {doc.staff_identity_at ? ` · ${doc.staff_identity_at.slice(0, 10)}` : ""}
      </span>
    </p>
  );
}

/** Staff (and the oncologist) record an assessment and a note. Staff cannot confirm or reject. */
export function FlagForm({ documentId, onDone, initial }: { documentId: string; onDone: () => void; initial?: IdentityDocument }) {
  const [assessment, setAssessment] = useState<StaffAssessment | "">(initial?.staff_identity_assessment ?? "");
  const [note, setNote] = useState(initial?.staff_identity_note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function submit() {
    if (!assessment || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.flagDocumentIdentity(documentId, assessment, note.trim());
      onDone();
    } catch (err) {
      // A 409 means the status already moved on: the parent reloads the truth.
      if (err instanceof ApiError && err.status === 409) onDone();
      else setError(err instanceof ApiError ? err.message : "Could not save the flag. Try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div data-testid="flag-form">
      {error && <div className="error-banner" role="status">{error}</div>}
      <fieldset style={{ border: 0, padding: 0, margin: "0 0 8px" }}>
        <legend className="muted" style={{ fontSize: 12, padding: 0 }}>Your assessment</legend>
        {ASSESSMENT_OPTIONS.map((o) => (
          <label key={o.value} style={{ display: "block", margin: "4px 0" }}>
            <input
              type="radio"
              name={`assessment-${documentId}`}
              checked={assessment === o.value}
              onChange={() => setAssessment(o.value)}
            />{" "}
            {o.label}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor={`flag-note-${documentId}`}>Note for the oncologist (optional)</label>
        <textarea id={`flag-note-${documentId}`} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <button className="btn btn--secondary" type="button" disabled={busy || !assessment} onClick={() => void submit()}>
        {busy ? "Saving..." : "Flag for oncologist"}
      </button>
    </div>
  );
}

// The oncologist's review: staff assessment and note, what confirming would add, the conflicts it would open.
function ReviewPanel({ doc, onDecided }: { doc: IdentityDocument; onDecided: (outcome: IdentityOutcome) => void }) {
  const [preview, setPreview] = useState<IdentityPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setPreview(null);
    setError(null);
    api
      .getIdentityPreview(doc.id)
      .then((r) => current && setPreview(r))
      .catch((err) => current && setError(err instanceof ApiError ? err.message : "Could not load the preview."));
    return () => {
      current = false;
    };
  }, [doc.id]);

  return (
    <div className="card" data-testid="review-panel" style={{ marginTop: 8 }}>
      <StaffAssessmentLine doc={doc} />
      {!doc.staff_identity_assessment && <p className="muted">No staff assessment yet.</p>}
      {error && <div className="error-banner" role="status">{error}</div>}
      {!preview && !error && <p className="muted">Loading preview...</p>}
      {preview && (
        <div data-testid="identity-preview">
          <h3 style={{ marginBottom: 4 }}>If you confirm, this adds</h3>
          {preview.fact_total === 0 ? (
            <p className="muted">No facts.</p>
          ) : (
            <ul style={{ margin: "0 0 8px", paddingLeft: 20 }}>
              {Object.entries(preview.fact_counts).map(([type, n]) => (
                <li key={type}>{n} × {FIELD_LABELS[type] ?? type}</li>
              ))}
            </ul>
          )}
          {preview.markers.length > 0 && (
            <p className="muted" style={{ margin: "0 0 8px" }}>
              Markers: {preview.markers.map((m) => `${m.marker_name}${m.as_of_date ? ` (${m.as_of_date})` : ""}`).join(", ")}
            </p>
          )}
          <h3 style={{ marginBottom: 4 }}>New conflicts</h3>
          {preview.new_conflicts.length === 0 ? (
            <p className="muted">None. Nothing in this report disagrees with the live record.</p>
          ) : (
            <ul style={{ margin: "0 0 8px", paddingLeft: 20 }} data-testid="preview-conflicts">
              {preview.new_conflicts.map((c, i) => (
                <li key={i}>
                  {c.marker_name ?? FIELD_LABELS[c.field_type] ?? c.field_type}
                  {c.as_of_date ? ` · ${c.as_of_date}` : ""}: this report says {c.this_value}
                  {c.unit ? ` ${c.unit}` : ""}, the record says {c.other_value}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <IdentityDecision documentId={doc.id} onDone={onDecided} confirmFirst confirmDisabled={!preview} />
    </div>
  );
}

function docDate(doc: IdentityDocument): string {
  return doc.collected_on ?? doc.uploaded_at.slice(0, 10);
}

/**
 * Snapshot banner for reports held for identity (README section 3, item 1). The oncologist reviews and decides in
 * a panel; staff see the same text and a form to flag for the oncologist, never confirm or reject.
 */
export function HeldReportBanner({ patientId, docs, onChanged }: { patientId: string; docs: IdentityDocument[]; onChanged: () => void }) {
  const { user } = useAuth();
  const [open, setOpen] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  if (docs.length === 0 && !message) return null;

  function decided(outcome: IdentityOutcome) {
    setOpen(null);
    setMessage(
      outcome === "confirm"
        ? "Confirmed. This report's facts are now live in the patient's views."
        : outcome === "reject"
          ? "Rejected. This report is permanently excluded."
          : "This report's status had already changed, so the page was refreshed.",
    );
    onChanged();
  }

  return (
    <>
      {message && <div className="card" role="status" data-testid="held-result">{message}</div>}
      {docs.length > 0 && (
        <div className="card" role="status" data-testid="held-banner">
          <strong>{docs.length} {docs.length === 1 ? "report" : "reports"} held for identity</strong>
          <span className="muted"> · excluded below until {user?.role === "oncologist" ? "you confirm" : "the oncologist confirms"}</span>{" "}
          <a
            href={`#/patients/${patientId}/held`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/patients/${patientId}/held`);
            }}
          >
            Held documents
          </a>
          {docs.map((doc) => (
            <div key={doc.id} data-testid="held-banner-row" style={{ marginTop: 8 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>
                  "{doc.patient_name_on_report ?? "no name read"}" on {doc.lab_name ?? "lab not read"}, {docDate(doc)}
                </span>
                {isFlagged(doc) && <FlaggedTag />}
                <button
                  className="btn btn--secondary"
                  type="button"
                  style={{ whiteSpace: "nowrap" }}
                  onClick={() => setOpen(open === doc.id ? null : doc.id)}
                >
                  <RoleGate roles={["oncologist"]}>Review held report</RoleGate>
                  <RoleGate roles={["staff"]}>{isFlagged(doc) ? "Update flag" : "Flag for oncologist"}</RoleGate>
                </button>
              </div>
              {open === doc.id && (
                <>
                  <RoleGate roles={["oncologist"]}>
                    <ReviewPanel doc={doc} onDecided={decided} />
                  </RoleGate>
                  <RoleGate roles={["staff"]}>
                    <div className="card" style={{ marginTop: 8 }}>
                      <StaffAssessmentLine doc={doc} />
                      <FlagForm documentId={doc.id} initial={doc} onDone={() => { setOpen(null); onChanged(); }} />
                    </div>
                  </RoleGate>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
