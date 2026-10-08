import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type PatientSnapshot, type ReviewFact, type SnapshotField } from "../api/client";
import { FactCard } from "../components/FactCard";
import { MarkerDisclaimerFooter } from "../components/MarkerDisclaimerFooter";
import { MarkerTrendChart } from "../components/MarkerTrendChart";
import { withThyroglobulinAdjacency } from "../lib/markerOrder";
import { navigate } from "../router";

const FIELD_LABELS: Record<string, string> = {
  marker_value: "Marker value",
  treatment_regimen: "Treatment regimen",
  radiology_impression: "Radiology impression",
};

function ageFromDob(dob: string | null): number | null {
  if (dob === null) return null;
  const birth = new Date(`${dob}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const hasHadBirthdayThisYear =
    now.getUTCMonth() > birth.getUTCMonth() ||
    (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() >= birth.getUTCDate());
  if (!hasHadBirthdayThisYear) age -= 1;
  return age;
}

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
  const blockingConflict = field.conflicts.find((c) => c.status === "open" || c.status === "annotated");
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
    has_blocking_conflict: blockingConflict !== undefined,
    blocking_conflict_id: blockingConflict?.conflict_id ?? null,
    source_page: provenance?.source_page ?? null,
    source_location: provenance?.source_location ?? null,
    source_snippet: provenance?.source_snippet ?? null,
    fallback_level: provenance?.fallback_level ?? "document",
  };
}

// "Since last visit" is a terse delta summary across every block (docs/01 Screen
// Inventory), not a second copy of each block's full correction-capable fact card --
// a compact row per field, read-only, distinct in both purpose and appearance from
// the full sections below where the same facts live for actual review/sign-off.
function DeltaSummary({ fields }: { fields: SnapshotField[] }) {
  if (fields.length === 0) {
    return <p className="muted">No data recorded for this visit.</p>;
  }
  return (
    <div className="card" style={{ padding: 0 }}>
      {fields.map((f, i) => {
        const heading = f.marker_name ?? FIELD_LABELS[f.field_type] ?? f.field_type;
        return (
          <div className="delta-row" key={`delta-${f.fact_id ?? "none"}-${f.tracked_marker_id ?? i}`}>
            <span className="delta-row__name">{heading}</span>
            <span className="delta-row__value">
              {f.value ?? <span className="muted">—</span>}
              {f.unit && ` ${f.unit}`}
            </span>
            <span className="delta-row__meta">
              {f.delta_status && <span className="tag">{DELTA_LABELS[f.delta_status] ?? f.delta_status}</span>}
              <span className="tag">{COVERAGE_LABELS[f.coverage_status] ?? f.coverage_status}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function FieldEntry({
  field,
  patientId,
  visitId,
  onChanged,
  showTrend,
}: {
  field: SnapshotField;
  patientId: string;
  visitId: string;
  onChanged: () => void;
  showTrend?: boolean;
}) {
  const heading = field.marker_name ?? FIELD_LABELS[field.field_type] ?? field.field_type;

  if (field.fact_id === null) {
    return (
      <div className="card">
        <div className="page-heading" style={{ marginBottom: 0 }}>
          <h2 style={{ margin: 0 }}>{heading}</h2>
          <span className="tag">{COVERAGE_LABELS[field.coverage_status] ?? field.coverage_status}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="snapshot-field">
      <FactCard fact={toReviewFact(field, patientId, visitId)} trackedMarkers={[]} onChanged={onChanged} />
      {showTrend && field.tracked_marker_id && (
        <div className="snapshot-field__trend">
          <MarkerTrendChart patientId={patientId} trackedMarkerId={field.tracked_marker_id} />
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  fields,
  patientId,
  visitId,
  onChanged,
  showTrend,
}: {
  title: string;
  fields: SnapshotField[];
  patientId: string;
  visitId: string;
  onChanged: () => void;
  showTrend?: boolean;
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
            showTrend={showTrend}
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
  const { patient } = data;
  const age = ageFromDob(patient.date_of_birth);

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>{patient.name || "(unnamed patient)"}</h1>
          <p className="muted" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span>
              {patient.cancer_type || "cancer type not set"} · visit {data.current_visit.visit_date}
              {age !== null && ` · ${age}y`}
              {patient.sex && patient.sex !== "unknown" && ` ${patient.sex}`}
              {patient.mrn && ` · MRN ${patient.mrn}`}
              {patient.stage && ` · Stage ${patient.stage}`}
            </span>
            {patient.patient_origin === "referral" && (
              <span className="tag">Referral{patient.referring_physician ? ` · ${patient.referring_physician}` : ""}</span>
            )}
            <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${patient.id}/edit`)}>
              Edit info
            </button>
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => navigate("/")}>
          Back to patients
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {data.previous_visit.id !== null && (
        <section aria-labelledby="section-since-last-visit" style={{ marginBottom: 32 }}>
          <h2 id="section-since-last-visit">Since last visit</h2>
          <DeltaSummary fields={data.since_last_visit} />
        </section>
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
        fields={withThyroglobulinAdjacency(data.tumor_markers)}
        patientId={data.patient.id}
        visitId={visitId}
        onChanged={load}
        showTrend
      />
      <Section
        title="Radiology"
        fields={data.radiology}
        patientId={data.patient.id}
        visitId={visitId}
        onChanged={load}
      />

      <MarkerDisclaimerFooter />
    </div>
  );
}
