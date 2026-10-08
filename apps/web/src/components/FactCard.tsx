import { useState, useEffect, type ReactNode } from "react";
import { RoleGate } from "../auth/AuthContext";
import { api, ApiError, type ReviewFact, type TrackedMarker } from "../api/client";
import { flagForRange } from "../lib/referenceRange";
import { navigate } from "../router";

const RANGE_FLAG_LABEL: Record<"above" | "below", string> = {
  above: "Above laboratory reference interval",
  below: "Below laboratory reference interval",
};

// Tooltip fixed verbatim (Decisions Log, clinical input).
function rangeFlagTooltip(rawRange: string | null): string {
  return `Value exceeds source laboratory reference range (${rawRange}). Verification against original PDF report required.`;
}

const COVERAGE_LABELS: Record<string, string> = {
  value_found: "Value found",
  not_assessed: "Not assessed",
  not_applicable: "Not applicable per source",
  extraction_uncertain: "Needs review",
  conflicting_sources: "Conflicting values, see sources",
  not_found_in_document_set: "Not found in this document set",
};

const FIELD_LABELS: Record<string, string> = {
  marker_value: "Marker value",
  reference_range: "Reference range",
  treatment_regimen: "Treatment regimen",
  radiology_impression: "Radiology impression",
  disease_status_trend: "Disease status / trend",
};

interface Props {
  fact: ReviewFact;
  trackedMarkers: TrackedMarker[];
  onChanged: () => void;
  /** Extra badge rendered next to the coverage tag — e.g. the Snapshot's delta-since-last-visit status. */
  badge?: ReactNode;
}

export function FactCard({ fact, trackedMarkers, onChanged, badge }: Props) {
  const [value, setValue] = useState(fact.value ?? "");
  const [markerId, setMarkerId] = useState("");
  const [customName, setCustomName] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdMarker, setCreatedMarker] = useState<{ id: string; marker_name: string } | null>(null);

  useEffect(() => {
    setValue(fact.value ?? "");
  }, [fact.value]);

  async function run(label: string, action: () => Promise<unknown>) {
    setError(null);
    setBusy(label);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed.");
    } finally {
      setBusy(null);
    }
  }

  const heading = fact.tracked_marker_name ?? fact.raw_marker_label ?? FIELD_LABELS[fact.field_type] ?? fact.field_type;
  const needsReview = fact.coverage_status === "extraction_uncertain";
  const signOffBlockedReason = fact.has_blocking_conflict
    ? "Blocked by an unresolved conflict"
    : fact.needs_manual_date
      ? "Needs a date before sign-off"
      : fact.field_type === "marker_value" && !fact.tracked_marker_id
        ? "A marker must be mapped to a tracked marker before sign-off"
        : null;

  return (
    <div className="card">
      <div className="page-heading" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{heading}</h2>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className={`tag ${needsReview ? "tag--pending" : ""}`}>{COVERAGE_LABELS[fact.coverage_status] ?? fact.coverage_status}</span>
          {badge}
        </span>
        {fact.has_blocking_conflict && fact.blocking_conflict_id && (
          <button
            className="tag tag--range-flag"
            type="button"
            style={{ marginLeft: 8, cursor: "pointer" }}
            onClick={() => navigate(`/conflicts/${fact.blocking_conflict_id}`)}
          >
            Conflicting sources — review
          </button>
        )}
      </div>
      <p className="muted" style={{ marginTop: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span>
          {FIELD_LABELS[fact.field_type] ?? fact.field_type} · {fact.verification_state.replace(/_/g, " ")} ·{" "}
          {fact.as_of_date ? `as of ${fact.as_of_date}` : "no as-of date"}
        </span>
        {fact.document_id && (
          <button
            className="btn btn--ghost source-link"
            type="button"
            onClick={() => navigate(`/documents/${fact.document_id}/source?fact=${fact.id}`)}
          >
            📄 View uploaded document
          </button>
        )}
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Raw text from document</h3>
          {fact.source_snippet ? <blockquote style={{ margin: 0 }}>{fact.source_snippet}</blockquote> : <p className="muted">Source detail unavailable</p>}
          {(fact.source_page !== null || fact.source_location) && (
            <p className="field-hint">
              {fact.source_page !== null && `Page ${fact.source_page}`}
              {fact.source_page !== null && fact.source_location && " · "}
              {fact.source_location}
            </p>
          )}
        </div>
        <div>
          <h3 style={{ marginTop: 0 }}>Extracted value</h3>
          <p className="fact-value" style={{ marginTop: 0 }}>
            {fact.value ?? <span className="muted">(no value)</span>}
            {fact.unit && ` ${fact.unit}`}
            {fact.reference_range && <span className="muted"> · ref {fact.reference_range}</span>}
            {(() => {
              const flag = flagForRange(fact.value, fact.reference_range);
              return flag ? (
                <span className="tag tag--range-flag" style={{ marginLeft: 8 }} title={rangeFlagTooltip(fact.reference_range)}>
                  {RANGE_FLAG_LABEL[flag]}
                </span>
              ) : null;
            })()}
          </p>
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              void run("value", () => api.patchFact(fact.id, { value }));
            }}
          >
            <label htmlFor={`value-${fact.id}`}>Correct value (saving confirms it)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id={`value-${fact.id}`} value={value} onChange={(e) => setValue(e.target.value)} />
              <button className="btn btn--secondary" type="submit" disabled={busy !== null || value.trim() === ""}>
                {busy === "value" ? "Saving..." : "Save value"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {fact.raw_marker_label && (
        <div className="field" style={{ marginTop: 16 }}>
          <label>
            Marker "{fact.raw_marker_label}" isn't mapped to a tracked marker
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <select value={markerId} onChange={(e) => setMarkerId(e.target.value)} aria-label="Existing tracked marker">
              <option value="">Map to existing marker...</option>
              {trackedMarkers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.marker_name}
                </option>
              ))}
            </select>
            <button
              className="btn btn--secondary"
              type="button"
              disabled={busy !== null || !markerId}
              onClick={() => void run("map", () => api.patchFact(fact.id, { tracked_marker_id: markerId }))}
            >
              {busy === "map" ? "Mapping..." : "Map"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="Or add as a new marker"
              aria-label="New custom marker name"
            />
            <button
              className="btn btn--secondary"
              type="button"
              disabled={busy !== null || customName.trim() === ""}
              onClick={() =>
                void run("add", async () => {
                  let newMarker: { id: string; marker_name: string } | null = null;
                  let markerId: string;

                  if (createdMarker && createdMarker.marker_name === customName.trim()) {
                    markerId = createdMarker.id;
                  } else {
                    const created = await api.addMarker(fact.patient_id, customName.trim());
                    newMarker = { id: created.id, marker_name: created.marker_name };
                    setCreatedMarker(newMarker);
                    markerId = created.id;
                  }

                  try {
                    await api.patchFact(fact.id, { tracked_marker_id: markerId });
                  } catch (err) {
                    // If marker was just created, reload parent before re-throwing
                    if (newMarker) {
                      onChanged();
                    }
                    throw err;
                  }
                })
              }
            >
              {busy === "add" ? "Adding..." : "Add and map"}
            </button>
          </div>
        </div>
      )}

      {fact.needs_manual_date && (
        <form
          className="field"
          style={{ marginTop: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run("date", () => api.patchFact(fact.id, { as_of_date: date }));
          }}
        >
          <label htmlFor={`date-${fact.id}`}>As-of date (not found in the document)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input id={`date-${fact.id}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            <button className="btn btn--secondary" type="submit" disabled={busy !== null || !date}>
              {busy === "date" ? "Saving..." : "Save date"}
            </button>
          </div>
        </form>
      )}

      <RoleGate roles={["oncologist"]}>
        {fact.verification_state === "oncologist_signed_off" ? (
          <div style={{ marginTop: 16 }}>
            <button className="btn btn--secondary" type="button" disabled={busy !== null} onClick={() => void run("reopen", () => api.reopenFact(fact.id))}>
              {busy === "reopen" ? "Reopening..." : "Reopen"}
            </button>
          </div>
        ) : (
          <div style={{ marginTop: 16 }}>
            <button
              className={signOffBlockedReason === null ? "btn btn--primary" : "btn"}
              type="button"
              disabled={busy !== null || signOffBlockedReason !== null}
              onClick={() => void run("signoff", () => api.signOffFact(fact.id))}
            >
              {busy === "signoff" ? "Signing off..." : "Sign off"}
            </button>
            {signOffBlockedReason && <p className="field-hint">{signOffBlockedReason}</p>}
          </div>
        )}
      </RoleGate>
    </div>
  );
}
