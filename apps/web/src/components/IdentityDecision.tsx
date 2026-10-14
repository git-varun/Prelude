import { useEffect, useRef, useState } from "react";
import { api, ApiError, type IdentityAction } from "../api/client";

export type IdentityOutcome = IdentityAction | "stale";

// Printed (on the report) vs recorded (on the patient) name, side by side. Shared by the Held
// screen rows and the Extraction review banner so the two never drift apart.
// recordedName: undefined = still loading, null = loaded and the record genuinely has no name.
// recordedError, when set, means the lookup failed -- never shown as "unnamed".
export function IdentityNames({
  printedName,
  recordedName,
  recordedError,
}: {
  printedName: string | null;
  recordedName: string | null | undefined;
  recordedError?: string | null;
}) {
  return (
    <div style={{ display: "flex", gap: 32, flexWrap: "wrap", margin: "8px 0" }}>
      <div>
        <div className="muted" style={{ fontSize: 12 }}>Name on the report</div>
        <strong data-testid="printed-name">{printedName || "(no name read from the report)"}</strong>
      </div>
      <div>
        <div className="muted" style={{ fontSize: 12 }}>Name on the patient record</div>
        {recordedError ? (
          <strong data-testid="recorded-name" role="status">Could not load the record name: {recordedError}</strong>
        ) : recordedName === undefined ? (
          <strong data-testid="recorded-name" className="muted">Loading...</strong>
        ) : (
          <strong data-testid="recorded-name">{recordedName || "(unnamed patient)"}</strong>
        )}
      </div>
    </div>
  );
}

// Confirm / Reject for one held document. Reject is permanent, so it needs an explicit second
// click on an inline confirmation (never window.confirm). A ref (not just state) gates
// submissions so a fast double click cannot fire two requests, and the mounted ref keeps a
// late response from touching an unmounted or re-targeted component.
export function IdentityDecision({
  documentId,
  onDone,
  confirmDisabled = false,
  confirmFirst = false,
}: {
  documentId: string;
  onDone: (outcome: IdentityOutcome) => void;
  /** Confirm waits until the recorded name is on screen; Reject stays available. */
  confirmDisabled?: boolean;
  /** Confirm needs a second click on an inline confirmation, like Reject (used where a preview is shown). */
  confirmFirst?: boolean;
}) {
  const [confirmingReject, setConfirmingReject] = useState(false);
  const [confirmingConfirm, setConfirmingConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const currentDoc = useRef(documentId);

  useEffect(() => {
    currentDoc.current = documentId;
    setConfirmingReject(false);
    setConfirmingConfirm(false);
    setBusy(false);
    setError(null);
    inFlight.current = false;
    return () => {
      currentDoc.current = "";
    };
  }, [documentId]);

  async function submit(action: IdentityAction) {
    if (inFlight.current) return;
    inFlight.current = true;
    const target = documentId;
    setBusy(true);
    setError(null);
    try {
      await api.setDocumentIdentity(target, action);
      if (currentDoc.current !== target) return;
      onDone(action);
    } catch (err) {
      if (currentDoc.current !== target) return;
      if (err instanceof ApiError && err.status === 409) {
        // Someone else already decided (or the status moved on): the parent reloads the truth.
        onDone("stale");
      } else {
        setError(err instanceof ApiError ? err.message : "Could not save the decision. Try again.");
      }
    } finally {
      if (currentDoc.current === target) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <div>
      {error && <div className="error-banner" role="status">{error}</div>}
      {confirmingReject ? (
        <div className="card" style={{ margin: 0 }}>
          <p style={{ marginTop: 0 }}>
            Reject this document? Its facts will be permanently excluded from every view. This cannot be undone.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--primary" type="button" disabled={busy} onClick={() => void submit("reject")}>
              {busy ? "Rejecting..." : "Yes, reject permanently"}
            </button>
            <button className="btn btn--ghost" type="button" disabled={busy} onClick={() => setConfirmingReject(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : confirmingConfirm ? (
        <div className="card" style={{ margin: 0 }}>
          <p style={{ marginTop: 0 }}>Confirm this report belongs to this patient? Its facts will go live in every view.</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn--primary" type="button" disabled={busy} onClick={() => void submit("confirm")}>
              {busy ? "Confirming..." : "Yes, confirm"}
            </button>
            <button className="btn btn--ghost" type="button" disabled={busy} onClick={() => setConfirmingConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn btn--primary"
            type="button"
            disabled={busy || confirmDisabled}
            onClick={() => (confirmFirst ? setConfirmingConfirm(true) : void submit("confirm"))}
          >
            {busy ? "Saving..." : "Confirm"}
          </button>
          <button className="btn btn--secondary" type="button" disabled={busy} onClick={() => setConfirmingReject(true)}>
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
