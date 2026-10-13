import { useCallback, useEffect, useRef, useState } from "react";
import { RoleGate } from "../auth/AuthContext";
import { api, ApiError, type PatientSnapshot, type ReviewFact, type SnapshotField } from "../api/client";
import { FactCard } from "../components/FactCard";
import { MarkerDisclaimerFooter } from "../components/MarkerDisclaimerFooter";
import { SummaryStrip } from "../components/SummaryStrip";
import { MarkerTrendChart } from "../components/MarkerTrendChart";
import { withThyroglobulinAdjacency } from "../lib/markerOrder";
import { flagForRange } from "../lib/referenceRange";
import { navigate } from "../router";

const FIELD_LABELS: Record<string, string> = {
  marker_value: "Marker value",
  treatment_regimen: "Treatment regimen",
  radiology_impression: "Radiology impression",
  reference_range: "Reference range",
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
    check_state: field.check_state ?? "unchecked",
    checked_by: null,
    checked_at: null,
    error_type: null,
    excluded_at: null,
    printed_flag: null,
    parse_checks: null,
  };
}

// "Since last visit" is a terse delta summary across every block (docs/01 Screen
// Inventory), not a second copy of each block's full correction-capable fact card --
// a compact row per field, read-only, distinct in both purpose and appearance from
// the full sections below where the same facts live for actual review/sign-off.
// Highest priority first: an out-of-range changed/new value outranks a
// plain changed/new value, which outranks unchanged -- a doctor scanning
// this list should see what actually needs a decision before the inert
// "nothing moved" entries. Stable otherwise (no secondary sort key), so
// equal-priority rows keep the API's own order.
function deltaPriority(f: SnapshotField): number {
  const outOfRange = flagForRange(f.value, f.reference_range) !== null;
  const changed = f.delta_status === "changed" || f.delta_status === "new";
  if (changed && outOfRange) return 0;
  if (changed) return 1;
  return 2;
}

function DeltaSummary({ fields }: { fields: SnapshotField[] }) {
  if (fields.length === 0) {
    return <p className="muted">No data recorded for this visit.</p>;
  }
  const sorted = [...fields].sort((a, b) => deltaPriority(a) - deltaPriority(b));
  return (
    <div className="card" style={{ padding: 0 }}>
      {sorted.map((f, i) => {
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

// AM-01: a fact can be picked for batch sign-off only when it is checked Correct, dated, mapped, and has no open
// conflict. Held and excluded facts never reach the snapshot. The server re-checks all of it.
type BatchState = { kind: "eligible" } | { kind: "signed" } | { kind: "blocked"; reason: string | null };

function batchState(f: SnapshotField): BatchState {
  if (f.verification_state === "oncologist_signed_off") return { kind: "signed" };
  if (f.conflicts.some((c) => c.status === "open" || c.status === "annotated")) return { kind: "blocked", reason: "Resolve the conflict first" };
  if (f.as_of_date === null) return { kind: "blocked", reason: "Add a date first" };
  if (f.field_type === "marker_value" && !f.tracked_marker_id) return { kind: "blocked", reason: "Map the marker first" };
  if (f.check_state !== "correct") return { kind: "blocked", reason: "Needs staff check first" };
  return { kind: "eligible" };
}

interface Batch {
  selected: Set<string>;
  toggle: (factId: string) => void;
}

function FieldEntry({
  field,
  patientId,
  visitId,
  onChanged,
  showTrend,
  batch,
}: {
  field: SnapshotField;
  patientId: string;
  visitId: string;
  onChanged: () => void;
  showTrend?: boolean;
  batch: Batch;
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

  const state = batchState(field);
  const picked = batch.selected.has(field.fact_id);
  return (
    <div className={`snapshot-field${picked ? " snapshot-field--selected" : ""}${state.kind === "signed" ? " snapshot-field--signed" : ""}`}>
      <RoleGate roles={["oncologist"]}>
        {state.kind === "eligible" && (
          <label className="batch-pick">
            <input type="checkbox" checked={picked} onChange={() => batch.toggle(field.fact_id!)} />
            Select {heading} for sign-off
          </label>
        )}
        {state.kind === "signed" && (
          <div className="batch-pick"><span className="tag">Signed off</span></div>
        )}
        {state.kind === "blocked" && state.reason && <div className="batch-pick muted">{state.reason}</div>}
      </RoleGate>
      <FactCard
        fact={toReviewFact(field, patientId, visitId)}
        trackedMarkers={[]}
        onChanged={onChanged}
        badge={field.imaging_modality && <span className="tag">{field.imaging_modality.replace(/_/g, " ")}</span>}
      />
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
  batch,
}: {
  title: string;
  fields: SnapshotField[];
  patientId: string;
  visitId: string;
  onChanged: () => void;
  showTrend?: boolean;
  batch: Batch;
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
            batch={batch}
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

  const [heldCount, setHeldCount] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ ids: string[] } | null>(null);

  const latestLoad = useRef(0);
  const currentPatientId = useRef<string | null>(null);

  // Best-effort banner data: a failure here must never break or delay the snapshot, so it is
  // fetched independently and any error just means "no banner".
  useEffect(() => {
    let current = true;
    setHeldCount(0);
    api
      .getPatientIdentityDocuments(patientId)
      .then((r) => {
        if (current) setHeldCount(r.documents.filter((d) => d.identity_status === "mismatch").length);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [patientId]);

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

  // The toast (with Undo) lasts 4 seconds.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (loading) return <p className="muted">Loading...</p>;
  if (!data) return <div className="error-banner">{error ?? "Patient not found."}</div>;

  const visitId = data.current_visit.id;
  const { patient } = data;
  const age = ageFromDob(patient.date_of_birth);

  const visitFields = [...data.current_treatment, ...data.tumor_markers, ...data.radiology].filter((f) => f.fact_id !== null);
  const eligibleIds = new Set(visitFields.filter((f) => batchState(f).kind === "eligible").map((f) => f.fact_id!));
  // Only still-eligible picks count (a reload can change a fact's state).
  const picked = [...selected].filter((id) => eligibleIds.has(id));
  const signedCount = visitFields.filter((f) => f.verification_state === "oncologist_signed_off").length;
  const batch: Batch = {
    selected: new Set(picked),
    toggle: (id) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
  };

  async function signOffSelected() {
    setBatchBusy(true);
    setBatchError(null);
    try {
      await api.signOffBatch(picked);
      setSelected(new Set());
      setToast({ ids: picked });
    } catch (err) {
      setBatchError(err instanceof ApiError ? err.message : "Sign-off failed.");
    } finally {
      setBatchBusy(false);
      void load();
    }
  }

  async function undoSignOff() {
    if (!toast) return;
    const ids = toast.ids;
    setToast(null);
    try {
      await api.undoSignOffBatch(ids);
    } catch (err) {
      setBatchError(err instanceof ApiError ? err.message : "Undo failed.");
    } finally {
      void load();
    }
  }

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
            <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${patient.id}/summary`)}>
              Summary
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${patient.id}/plan`)}>
              Plan
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${patient.id}/edit`)}>
              Edit info
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${patient.id}/history`)}>
              Visit history
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${patient.id}/timeline`)}>
              Timeline
            </button>
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => navigate("/")}>
          Back to patients
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {heldCount > 0 && (
        <div className="card" role="status" data-testid="held-banner">
          {heldCount} document{heldCount === 1 ? "" : "s"} held for patient identity, excluded from this view.{" "}
          <a
            href={`#/patients/${patient.id}/held`}
            onClick={(e) => {
              e.preventDefault();
              navigate(`/patients/${patient.id}/held`);
            }}
          >
            Review held documents
          </a>
        </div>
      )}

      <SummaryStrip patientId={patient.id} />

      {data.previous_visit.id !== null && (
        <section aria-labelledby="section-since-last-visit" style={{ marginBottom: 32 }}>
          <h2 id="section-since-last-visit">Since last visit</h2>
          <DeltaSummary fields={data.since_last_visit} />
        </section>
      )}

      <RoleGate roles={["oncologist"]}>
        <section aria-labelledby="section-for-this-visit" style={{ marginBottom: 16 }}>
          <div className="page-heading" style={{ marginBottom: 8 }}>
            <h2 id="section-for-this-visit" style={{ margin: 0 }}>For this visit</h2>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="muted">{signedCount} signed off this visit</span>
              <button
                className="btn btn--primary"
                type="button"
                disabled={picked.length === 0 || batchBusy}
                onClick={() => void signOffSelected()}
              >
                {picked.length === 0 ? "Select facts to sign off" : batchBusy ? "Signing off..." : `Sign off ${picked.length} reviewed`}
              </button>
            </span>
          </div>
          {batchError && <div className="error-banner">{batchError}</div>}
        </section>
      </RoleGate>

      <Section
        title="Current treatment"
        fields={data.current_treatment}
        patientId={data.patient.id}
        visitId={visitId}
        onChanged={load}
        batch={batch}
      />
      <Section
        title="Tumor markers"
        fields={withThyroglobulinAdjacency(data.tumor_markers)}
        patientId={data.patient.id}
        visitId={visitId}
        onChanged={load}
        showTrend
        batch={batch}
      />
      <Section
        title="Radiology"
        fields={data.radiology}
        patientId={data.patient.id}
        visitId={visitId}
        onChanged={load}
        batch={batch}
      />

      <MarkerDisclaimerFooter />

      {toast && (
        <div className="toast" role="status">
          <span>Signed off {toast.ids.length} {toast.ids.length === 1 ? "fact" : "facts"}</span>
          <button className="btn btn--secondary" type="button" onClick={() => void undoSignOff()}>Undo</button>
        </div>
      )}
    </div>
  );
}
