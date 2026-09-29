import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type PatientSnapshot, type ReviewFact, type SnapshotField } from "../api/client";
import { FactCard } from "../components/FactCard";
import { navigate } from "../router";

const FIELD_LABELS: Record<string, string> = {
  marker_value: "Marker value",
  treatment_regimen: "Treatment regimen",
  radiology_impression: "Radiology impression",
};

const DELTA_LABELS: Record<string, string> = {
  new: "New",
  changed: "Changed",
  unchanged: "Unchanged",
  not_observed_in_current_document_set: "No longer observed",
};

const COVERAGE_LABELS: Record<string, string> = {
  value_found: "Value found",
  not_assessed: "Not assessed",
  not_applicable: "Not applicable per source",
  extraction_uncertain: "Needs review",
  conflicting_sources: "Conflicting values, see sources",
  not_found_in_document_set: "Not found in this document set",
};

// Converts a snapshot field object into the shape FactCard already knows how to render
// (docs/M3), rather than teaching FactCard a second fact shape. Only called when fact_id
// is non-null, so every ReviewFact field below has a real source.
//
// needs_manual_date is not part of the snapshot contract (only as_of_date is) — this
// infers "still needs a date" from as_of_date being null. Every date-setting path (per-fact
// and bulk) clears needs_manual_date and sets as_of_date together, so the two stay in sync
// today. If a future change ever sets one without the other, this proxy — and only this
// screen's sign-off gating — would silently drift from the real value.
function toReviewFact(field: SnapshotField, patientId: string, visitId: string): ReviewFact {
  const provenance = field.provenance;
  return {
    id: field.fact_id!,
    patient_id: patientId,
    visit_id: visitId,
    document_id: provenance?.document_id ?? "",
    tracked_marker_id: field.tracked_marker_id,
    tracked_marker_name: field.marker_name,
    raw_marker_label: null,
    field_type: field.field_type,
    value: field.value,
    unit: field.unit,
    reference_range: field.reference_range,
    as_of_date: field.as_of_date,
    needs_manual_date: field.as_of_date === null,
    coverage_status: field.coverage_status,
    verification_state: field.verification_state!,
    has_blocking_conflict: field.conflicts.some((c) => c.status === "open" || c.status === "annotated"),
    source_page: provenance?.source_page ?? null,
    source_location: provenance?.source_location ?? null,
    source_snippet: provenance?.source_snippet ?? null,
  };
}

function sourceLink(field: SnapshotField) {
  const p = field.provenance;
  if (!p) return null;
  const label =
    p.fallback_level === "exact"
      ? `Page ${p.source_page} · ${p.source_location}`
      : p.fallback_level === "page"
        ? `Page ${p.source_page} (location not recorded)`
        : "Open document (no page/location recorded)";
  return (
    <button className="btn btn--ghost" type="button" onClick={() => navigate(`/documents/${p.document_id}/review`)}>
      {label}
    </button>
  );
}

function FieldEntry({
  field,
  patientId,
  visitId,
  onChanged,
  showDelta,
}: {
  field: SnapshotField;
  patientId: string;
  visitId: string;
  onChanged: () => void;
  showDelta?: boolean;
}) {
  const heading = field.marker_name ?? FIELD_LABELS[field.field_type] ?? field.field_type;
  const deltaBadge = showDelta && field.delta_status ? (
    <span className="tag" style={{ marginLeft: 8 }}>
      {DELTA_LABELS[field.delta_status] ?? field.delta_status}
    </span>
  ) : null;

  if (field.fact_id === null) {
    return (
      <div className="card">
        <div className="page-heading" style={{ marginBottom: 0 }}>
          <h2 style={{ margin: 0 }}>{heading}</h2>
          <span>
            <span className="tag">{COVERAGE_LABELS[field.coverage_status] ?? field.coverage_status}</span>
            {deltaBadge}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div>
      <FactCard fact={toReviewFact(field, patientId, visitId)} trackedMarkers={[]} onChanged={onChanged} />
      {deltaBadge}
      {sourceLink(field)}
    </div>
  );
}

function Section({
  title,
  fields,
  patientId,
  visitId,
  onChanged,
  showDelta,
}: {
  title: string;
  fields: SnapshotField[];
  patientId: string;
  visitId: string;
  onChanged: () => void;
  showDelta?: boolean;
}) {
  return (
    <section aria-labelledby={`section-${title}`} style={{ marginBottom: 32 }}>
      <h2 id={`section-${title}`}>{title}</h2>
      {fields.length === 0 ? (
        <p className="muted">No data recorded for this visit.</p>
      ) : (
        fields.map((f, i) => (
          <FieldEntry
            key={`${title}-${f.fact_id ?? "none"}-${f.tracked_marker_id ?? i}`}
            field={f}
            patientId={patientId}
            visitId={visitId}
            onChanged={onChanged}
            showDelta={showDelta}
          />
        ))
      )}
    </section>
  );
}

export function Snapshot({ patientId }: { patientId: string }) {
  const [data, setData] = useState<PatientSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const latestLoad = useRef(0);
  const currentPatientId = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (currentPatientId.current !== patientId) return;
    const token = ++latestLoad.current;
    try {
      const result = await api.getPatientSnapshot(patientId);
      if (token !== latestLoad.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (token !== latestLoad.current) return;
      setError(err instanceof ApiError ? err.message : "Failed to load snapshot.");
    } finally {
      if (token === latestLoad.current) setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    currentPatientId.current = patientId;
    setLoading(true);
    setData(null);
    void load();
    return () => {
      currentPatientId.current = null;
      latestLoad.current++;
    };
  }, [load, patientId]);

  if (loading) return <p className="muted">Loading...</p>;
  if (!data) return <div className="error-banner">{error ?? "Patient not found."}</div>;

  const visitId = data.current_visit.id;

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>{data.patient.name || "(unnamed patient)"}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {data.patient.cancer_type || "cancer type not set"} · visit {data.current_visit.visit_date}
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => navigate("/")}>
          Back to patients
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {data.previous_visit.id !== null && (
        <Section
          title="Since last visit"
          fields={data.since_last_visit}
          patientId={data.patient.id}
          visitId={visitId}
          onChanged={load}
          showDelta
        />
      )}

      <Section
        title="Current treatment"
        fields={data.current_treatment}
        patientId={data.patient.id}
        visitId={visitId}
        onChanged={load}
      />
      <Section
        title="Tumor markers"
        fields={data.tumor_markers}
        patientId={data.patient.id}
        visitId={visitId}
        onChanged={load}
      />
      <Section
        title="Radiology"
        fields={data.radiology}
        patientId={data.patient.id}
        visitId={visitId}
        onChanged={load}
      />
    </div>
  );
}
