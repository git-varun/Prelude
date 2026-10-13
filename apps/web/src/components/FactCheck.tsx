import { useState } from "react";
import { api, ApiError, type CheckBody, type CheckErrorType, type ReviewFact, type TrackedMarker } from "../api/client";

export const ERROR_TYPE_LABELS: Record<CheckErrorType, string> = {
  value: "Value",
  unit: "Unit",
  marker: "Marker",
  date: "Date",
  range: "Reference range",
  not_in_document: "Not in the document",
  wrong_patient: "Wrong patient",
};
const ERROR_TYPE_ORDER: CheckErrorType[] = ["value", "unit", "marker", "date", "range", "not_in_document", "wrong_patient"];
const EXCLUSION_TYPES: CheckErrorType[] = ["not_in_document", "wrong_patient"];

interface Props {
  fact: ReviewFact;
  trackedMarkers: TrackedMarker[];
  onChanged: () => void;
  /** The card the keyboard shortcuts act on. */
  active: boolean;
  /** Whether the Incorrect form is open. Lifted so the review screen can pause its shortcuts while it is. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function FactCheck({ fact, trackedMarkers, onChanged, active, open, onOpenChange }: Props) {
  const [errorType, setErrorType] = useState<CheckErrorType | "">("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signedOff = fact.verification_state === "oncologist_signed_off";
  const isExclusion = errorType !== "" && EXCLUSION_TYPES.includes(errorType);

  async function submit(body: CheckBody) {
    setError(null);
    setBusy(true);
    try {
      await api.checkFact(fact.id, body);
      close();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save the check.");
    } finally {
      setBusy(false);
    }
  }

  function close() {
    setErrorType("");
    setInput("");
    onOpenChange(false);
  }

  function correctionFor(type: CheckErrorType, v: string): NonNullable<Extract<CheckBody, { result: "incorrect" }>["correction"]> {
    switch (type) {
      case "value": return { value: v };
      case "unit": return { unit: v };
      case "marker": return { tracked_marker_id: v };
      case "date": return { as_of_date: v };
      default: return { reference_range: v };
    }
  }

  const status =
    fact.check_state === "correct"
      ? "Checked correct"
      : fact.check_state === "incorrect"
        ? `Marked incorrect: ${fact.error_type ? ERROR_TYPE_LABELS[fact.error_type].toLowerCase() : "see details"}`
        : fact.verification_state === "staff_corrected"
          ? "Changed since it was checked. Mark it again."
          : "Not checked yet";

  return (
    <div className="fact-check" style={{ marginTop: 16 }} data-active={active ? "true" : undefined}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className={`tag ${fact.check_state === "unchecked" ? "tag--pending" : ""}`} role="status">
          {status}
        </span>
        {fact.excluded_at && <span className="muted">Excluded from every view.</span>}
        <button
          className="btn btn--secondary"
          type="button"
          disabled={busy || signedOff}
          onClick={() => void submit({ result: "correct" })}
        >
          Correct
        </button>
        <button
          className="btn btn--secondary"
          type="button"
          disabled={busy || signedOff}
          aria-expanded={open}
          onClick={() => onOpenChange(true)}
        >
          Incorrect
        </button>
      </div>
      {signedOff && <p className="field-hint">Reopen to change the check</p>}
      {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}

      {open && !signedOff && (
        <form
          className="field"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (errorType === "" || isExclusion) return;
            void submit({ result: "incorrect", error_type: errorType, correction: correctionFor(errorType, input.trim()) });
          }}
        >
          <label htmlFor={`wrong-${fact.id}`}>What was wrong</label>
          <select
            id={`wrong-${fact.id}`}
            value={errorType}
            required
            onChange={(e) => {
              setErrorType(e.target.value as CheckErrorType | "");
              setInput("");
            }}
          >
            <option value="">Choose...</option>
            {ERROR_TYPE_ORDER.map((t) => (
              <option key={t} value={t}>{ERROR_TYPE_LABELS[t]}</option>
            ))}
          </select>

          {errorType === "value" && <TextField id={`cv-${fact.id}`} label="Corrected value" value={input} onChange={setInput} />}
          {errorType === "unit" && <TextField id={`cu-${fact.id}`} label="Corrected unit" value={input} onChange={setInput} />}
          {errorType === "range" && <TextField id={`cr-${fact.id}`} label="Corrected reference range" value={input} onChange={setInput} />}
          {errorType === "date" && (
            <div style={{ marginTop: 8 }}>
              <label htmlFor={`cd-${fact.id}`}>Corrected date</label>
              <input id={`cd-${fact.id}`} type="date" value={input} onChange={(e) => setInput(e.target.value)} />
            </div>
          )}
          {errorType === "marker" && (
            <div style={{ marginTop: 8 }}>
              <label htmlFor={`cm-${fact.id}`}>Corrected marker</label>
              <select id={`cm-${fact.id}`} value={input} onChange={(e) => setInput(e.target.value)}>
                <option value="">Choose a tracked marker...</option>
                {trackedMarkers.map((m) => (
                  <option key={m.id} value={m.id}>{m.marker_name}</option>
                ))}
              </select>
            </div>
          )}

          {isExclusion ? (
            <div style={{ marginTop: 8 }}>
              <p style={{ margin: "0 0 8px" }}>This fact will be excluded from every view. Continue?</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="btn btn--primary"
                  type="button"
                  disabled={busy}
                  onClick={() => void submit({ result: "incorrect", error_type: errorType })}
                >
                  Confirm
                </button>
                <button className="btn btn--ghost" type="button" disabled={busy} onClick={close}>Cancel</button>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button className="btn btn--primary" type="submit" disabled={busy || errorType === "" || input.trim() === ""}>
                {busy ? "Saving..." : "Save correction"}
              </button>
              <button className="btn btn--ghost" type="button" disabled={busy} onClick={close}>Cancel</button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}

function TextField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ marginTop: 8 }}>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
