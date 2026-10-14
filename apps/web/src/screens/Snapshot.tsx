import { useCallback, useEffect, useRef, useState } from "react";
import { RoleGate } from "../auth/AuthContext";
import { api, ApiError, type IdentityDocument, type CompareMode, type BatchFailure, type PatientSnapshot, type PlanItem, type ReviewFact, type SnapshotField } from "../api/client";
import { FactCard } from "../components/FactCard";
import { ElsewhereTag } from "../components/SummaryBits";
import { MarkerDisclaimerFooter } from "../components/MarkerDisclaimerFooter";
import { Watchlist } from "../components/Watchlist";
import { SummaryStrip } from "../components/SummaryStrip";
import { HeldReportBanner } from "../components/HeldReport";
import { PrepPanel } from "../components/PrepPanel";
import { ReportRequestBanner } from "../components/ReportRequestBanner";
import { MarkerTrendChart } from "../components/MarkerTrendChart";
import { withThyroglobulinAdjacency } from "../lib/markerOrder";
import { dueLabel } from "./Plan";
import { deltaPriority, needsCheck, RULES, type PriorityItem } from "../lib/priorityOrder";
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
    outside_encounter: field.outside_encounter,
  };
}

// "Since last visit" is a terse delta summary across every block (docs/01 Screen
// Inventory), not a second copy of each block's full correction-capable fact card --
// a compact row per field, read-only. Rows follow the same AM-05 order as "For this visit"
// (rank comes from deltaPriority); rows with no rank keep the API's own order after the ranked ones.
function DeltaSummary({ fields, rank }: { fields: SnapshotField[]; rank: Map<string, number> }) {
  if (fields.length === 0) {
    return <p className="muted">No data recorded for this visit.</p>;
  }
  const rankOf = (f: SnapshotField) => (f.fact_id !== null ? rank.get(f.fact_id) : undefined) ?? Infinity;
  const sorted = [...fields].sort((a, b) => (rankOf(a) === rankOf(b) ? 0 : rankOf(a) < rankOf(b) ? -1 : 1));
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
              <ElsewhereTag encounter={f.outside_encounter} />
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
  if (f.check_state === "incorrect") return { kind: "blocked", reason: "Marked incorrect — correct it first" };
  if (f.check_state !== "correct") return { kind: "blocked", reason: "Needs staff check first" };
  return { kind: "eligible" };
}

interface Batch {
  selected: Set<string>;
  toggle: (factId: string) => void;
  onSignedOff: (factId: string) => void;
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
        onSignedOff={batch.onSignedOff}
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

const tagFor = (rule: number) => RULES.find((r) => r.rule === rule)!.tag;

function PriorityRow({ item, ...rest }: { item: PriorityItem; patientId: string; visitId: string; onChanged: () => void; batch: Batch }) {
  const tag = item.rule !== null && (
    <div className="rule-tag" data-testid="rule-tag">{tagFor(item.rule)}</div>
  );
  if (item.kind === "plan") {
    return (
      <div className="priority-row">
        {tag}
        <div className="card">
          <div className="page-heading" style={{ marginBottom: 0 }}>
            <div>
              <strong>{item.plan.text}</strong>
              <div className="muted">
                Advised {item.plan.advised_at} · Past advised date{dueLabel(item.plan) ? ` · ${dueLabel(item.plan)}` : ""}, no report seen
              </div>
            </div>
            <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${rest.patientId}/plan`)}>Open plan</button>
          </div>
        </div>
      </div>
    );
  }
  if (item.kind === "missing_pin") {
    const seen = item.entry.last_seen;
    return (
      <div className="priority-row">
        {tag}
        <div className="card">
          <strong>{item.entry.marker_name}</strong>
          <div className="muted">
            Not in this visit · {seen ? `last ${seen.value}${seen.unit ? ` ${seen.unit}` : ""} on ${seen.as_of_date}` : "no earlier value"}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="priority-row">
      {tag}
      <FieldEntry field={item.field} showTrend={item.section === "marker"} {...rest} />
    </div>
  );
}

// AM-03: "Last visit here" is the default and the only choice that is ever pre-selected; "Latest anywhere" is opt-in.
function CompareControl({ data, mode, onChange }: { data: PatientSnapshot; mode: CompareMode; onChange: (m: CompareMode) => void }) {
  const { last_here, latest_any } = data.compare;
  return (
    <div className="compare-toggle" role="group" aria-label="Compare with">
      <span className="muted">Compare with</span>
      <button className="btn btn--ghost" type="button" aria-pressed={mode === "here"} onClick={() => onChange("here")}>
        Last visit here{last_here ? ` · ${last_here.date}` : ""}
      </button>
      {(latest_any || mode === "any") && (
        <button className="btn btn--ghost" type="button" aria-pressed={mode === "any"} onClick={() => onChange("any")}>
          Latest anywhere{latest_any ? ` · ${latest_any.facility} ${latest_any.date}` : ""}
        </button>
      )}
    </div>
  );
}

// What "Since last visit" is measured against: the newest of the last visit here and (in any-mode) the latest visit elsewhere.
function baselineText(data: PatientSnapshot): string {
  const { mode, last_here, latest_any } = data.compare;
  if (mode === "any" && latest_any && (!last_here || latest_any.date >= last_here.date)) return `${latest_any.facility} ${latest_any.date}`;
  return last_here ? `last visit here ${last_here.date}` : "no earlier visit";
}

export function Snapshot({ patientId }: { patientId: string }) {
  const [data, setData] = useState<PatientSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Local state only: not persisted. Keyed by patient, so a patient change reads "here" on the very first load
  // (never the previous patient's mode) without an effect that resets it afterwards.
  const [compareChoice, setCompareChoice] = useState<{ patientId: string; mode: CompareMode }>({ patientId, mode: "here" });
  const compare: CompareMode = compareChoice.patientId === patientId ? compareChoice.mode : "here";
  const setCompare = (mode: CompareMode) => setCompareChoice({ patientId, mode });

  const [heldDocs, setHeldDocs] = useState<IdentityDocument[]>([]);
  const [planItems, setPlanItems] = useState<PlanItem[]>([]);
  const [showRules, setShowRules] = useState(false);
  // null = not chosen yet: the fold then opens by itself only when something in it needs a check.
  const [foldChoice, setFoldChoice] = useState<boolean | null>(null);
  const [planError, setPlanError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [batchFailures, setBatchFailures] = useState<BatchFailure[]>([]);
  // Each sign-off makes a new toast object (the timer effect re-arms on it); its Undo covers only these ids.
  const [toast, setToast] = useState<{ ids: string[] } | null>(null);

  const latestLoad = useRef(0);
  const currentPatientId = useRef<string | null>(null);

  // Best-effort banner data: a failure here must never break or delay the snapshot, so it is
  // fetched independently and any error just means "no banner".
  const heldSeq = useRef(0);
  const loadHeld = useCallback(() => {
    const seq = ++heldSeq.current;
    api
      .getPatientIdentityDocuments(patientId)
      .then((r) => {
        if (currentPatientId.current === patientId && seq === heldSeq.current) {
          setHeldDocs(r.documents.filter((d) => d.identity_status === "mismatch" || d.identity_status === "awaiting_oncologist"));
        }
      })
      .catch(() => {});
  }, [patientId]);

  useEffect(() => {
    setHeldDocs([]);
    setPlanItems([]);
    setPlanError(false);
    setFoldChoice(null);
    setSelected(new Set());
    setToast(null);
    setBatchError(null);
    setBatchFailures([]);
    loadHeld();
  }, [patientId, loadHeld]);

  const load = useCallback(async () => {
    if (currentPatientId.current !== patientId) return;
    const token = ++latestLoad.current;
    try {
      // Plan items (same flag the Plan screen shows, rule 5) reload with the snapshot; a failure is shown, not fatal.
      const planFetch = api.getPatientPlan(patientId).then((r) => r.items, () => null);
      const [result, plan] = await Promise.all([api.getPatientSnapshot(patientId, compare), planFetch]);
      if (token !== latestLoad.current) return;
      if (plan !== null) setPlanItems(plan);
      setPlanError(plan === null);
      setData(result);
      setError(null);
    } catch (err) {
      if (token !== latestLoad.current) return;
      setError(err instanceof ApiError ? err.message : "Failed to load snapshot.");
    } finally {
      if (token === latestLoad.current) setLoading(false);
    }
  }, [patientId, compare]);

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
  const items = deltaPriority({
    treatment: data.current_treatment, markers: data.tumor_markers, radiology: data.radiology,
    watchlist: data.watchlist, planItems,
  });
  const ruled = items.filter((i) => i.rule !== null);
  // Unchanged facts, plus placeholders for fields with no fact, fold away. The Thyroglobulin / Anti-Tg
  // adjacency (Decisions Log) is applied here only: inside the ruled list the rule order is never overridden.
  const folded = withThyroglobulinAdjacency(items.filter((i) => i.rule === null));
  const placeholders = [...data.current_treatment, ...data.tumor_markers, ...data.radiology].filter((f) => f.fact_id === null);
  // Placeholders are shown in the fold but are not facts, so they are not counted. Facts that still need a
  // check are counted separately and open the fold.
  const foldedCount = folded.length;
  const checkCount = folded.filter((i) => i.kind === "fact" && needsCheck(i.field)).length;
  const showFolded = foldChoice ?? checkCount > 0;
  const hasFacts = (section: string) => items.some((i) => i.kind === "fact" && i.section === section);
  const ruledFacts = ruled.flatMap((i) => (i.kind === "fact" ? [i.field] : []));
  const rank = new Map(items.flatMap((it, i) => (it.kind === "fact" ? [[it.id, i] as [string, number]] : [])));
  const eligibleIds = new Set(visitFields.filter((f) => batchState(f).kind === "eligible").map((f) => f.fact_id!));
  // Only still-eligible picks count (a reload can change a fact's state).
  const picked = [...selected].filter((id) => eligibleIds.has(id));
  const signedCount = ruledFacts.filter((f) => f.verification_state === "oncologist_signed_off").length;
  const batch: Batch = {
    selected: new Set(picked),
    toggle: (id) =>
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    onSignedOff: (id) => setToast({ ids: [id] }),
  };
  const rowProps = { patientId: data.patient.id, visitId, onChanged: load, batch };
  const labelFor = (factId: string) => {
    const f = visitFields.find((v) => v.fact_id === factId);
    return f ? (f.marker_name ?? FIELD_LABELS[f.field_type] ?? f.field_type) : "Unknown fact";
  };

  async function signOffSelected() {
    setBatchBusy(true);
    setBatchError(null);
    setBatchFailures([]);
    try {
      await api.signOffBatch(picked);
      setSelected(new Set());
      setToast({ ids: picked });
    } catch (err) {
      setBatchError(err instanceof ApiError ? err.message : "Sign-off failed.");
      if (err instanceof ApiError) setBatchFailures(err.failures);
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

      <PrepPanel visitId={data.current_visit.id} refreshKey={data} />

      <ReportRequestBanner items={planItems} onChanged={() => void load()} />

      <HeldReportBanner
        patientId={patient.id}
        docs={heldDocs}
        onChanged={() => {
          loadHeld();
          void load();
        }}
      />

      <SummaryStrip patientId={patient.id} />

      <div style={{ marginBottom: 16 }}>
        <CompareControl data={data} mode={compare} onChange={setCompare} />
      </div>

      {(data.previous_visit.id !== null || (data.compare.mode === "any" && data.compare.latest_any !== null)) && (
        <section aria-labelledby="section-since-last-visit" style={{ marginBottom: 32 }}>
          <h2 id="section-since-last-visit">{data.compare.mode === "any" ? "Since latest visit anywhere" : "Since last visit here"}</h2>
          <p className="muted" data-testid="compare-baseline" style={{ marginTop: 0 }}>Compared with: {baselineText(data)}</p>
          <DeltaSummary fields={data.since_last_visit} rank={rank} />
        </section>
      )}

      <Watchlist data={data} onChanged={load} />

      <section aria-labelledby="section-for-this-visit" style={{ marginBottom: 32 }}>
        <div className="page-heading" style={{ marginBottom: 8 }}>
          <h2 id="section-for-this-visit" style={{ margin: 0 }}>For this visit · {ruled.length}</h2>
          <span className="muted">{signedCount} signed off this visit</span>
          <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button
              className="btn btn--ghost" type="button" aria-expanded={showRules}
              onClick={() => setShowRules((v) => !v)}
            >
              How this is ordered
            </button>
            <RoleGate roles={["oncologist"]}>
              <button
                className="btn btn--primary"
                type="button"
                disabled={picked.length === 0 || batchBusy}
                onClick={() => void signOffSelected()}
              >
                {picked.length === 0 ? "Select facts to sign off" : batchBusy ? "Signing off..." : `Sign off ${picked.length} reviewed`}
              </button>
            </RoleGate>
          </span>
        </div>
        {showRules && (
          <div className="card" data-testid="how-ordered">
            <ol style={{ margin: 0, paddingLeft: 20 }}>
              {RULES.map((r) => <li key={r.rule}>{r.label}</li>)}
            </ol>
            <p className="muted" style={{ marginBottom: 0 }}>Then unchanged items, folded away.</p>
            <p className="muted" style={{ marginBottom: 0 }}>Same order for every patient. No score or weighting.</p>
          </div>
        )}
        <RoleGate roles={["oncologist"]}>
          {batchError && <div className="error-banner">{batchError}</div>}
          {batchFailures.length > 0 && (
            <ul data-testid="batch-failures">
              {batchFailures.map((f) => (
                <li key={f.fact_id}>{labelFor(f.fact_id)}: {f.message}</li>
              ))}
            </ul>
          )}
        </RoleGate>
        {planError && (
          <p className="muted">
            Plan items could not be loaded. Plan rows may be missing.{" "}
            <button className="btn btn--ghost" type="button" onClick={() => void load()}>Retry</button>
          </p>
        )}
        {ruled.length === 0 && (
          <p className="muted">
            Nothing changed or new in this visit.
            {checkCount > 0 && ` ${checkCount} unchanged ${checkCount === 1 ? "item needs" : "items need"} a check — open the list below.`}
          </p>
        )}
        {ruled.map((item) => (
          <PriorityRow key={`${item.kind}-${item.id}`} item={item} {...rowProps} />
        ))}
        {!hasFacts("treatment") && <p className="muted">No treatment facts recorded for this visit.</p>}
        {!hasFacts("marker") && <p className="muted">No tumor marker values recorded for this visit.</p>}
        {!hasFacts("radiology") && <p className="muted">No radiology facts recorded for this visit.</p>}
        {foldedCount + placeholders.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <button className="btn btn--ghost" type="button" aria-expanded={showFolded} onClick={() => setFoldChoice(!showFolded)}>
              Unchanged since last signed-off value {data.compare.mode === "any" ? "anywhere" : "here"} · {foldedCount}{checkCount > 0 && ` · ${checkCount} need a check`} {showFolded ? "▾" : "▸"}
            </button>
            {showFolded && (
              <div>
                {folded.map((item) => (
                  <PriorityRow key={`${item.kind}-${item.id}`} item={item} {...rowProps} />
                ))}
                {placeholders.map((f, i) => (
                  <div className="priority-row" key={`ph-${f.tracked_marker_id ?? f.field_type}-${i}`}>
                    <FieldEntry field={f} showTrend={false} {...rowProps} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

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
