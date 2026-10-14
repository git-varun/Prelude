import { sql } from "../db/client";
import { CONFLICT_SIDES_LIVE, LIVE_FACT_FILTER, deltaForCurrentFact, deltaKey, type DeltaBaseline } from "./delta";
import { loadCandidateDocumentsFor } from "./carePlan";
import { planItemStatus } from "./carePlanLogic";

// M3-09: the per-patient inputs of the Today list, for a whole page of patients at once (a fixed number of queries,
// whatever the page size). Everything here is read from data; nothing is interpreted or ranked.

export type ChangeSummaryItem =
  | { kind: "marker_changed"; name: string; from: string; to: string }
  | { kind: "new_report"; type: string; modality: string | null }
  | { kind: "sources_disagree"; name: string }
  | { kind: "plan_past"; count: number }
  | { kind: "elsewhere"; facility: string; date: string };

export interface SparklinePoint {
  fact_id: string; document_id: string | null; value: string; unit: string | null; as_of_date: string;
  verification_state: string; outside_encounter: { id: string; facility: string; date: string } | null;
}

export interface TodayInfo {
  prep_status: "preparing" | "ready" | null;
  current_visit_document_count: number;
  sign_off_count: number;
  change_summary_items: ChangeSummaryItem[];
  first_pinned_sparkline: { marker_name: string; reference_range: string | null; points: SparklinePoint[] } | null;
  has_plan_items_expected: boolean;
  diagnosis_text: string | null;
  regimen_text: string | null;
}

const MAX_MARKER_ITEMS = 3;
const MAX_DISAGREE_ITEMS = 3;
const EXPECTED_WITHIN_DAYS = 7;
const SIGNABLE_FIELDS = ["marker_value", "treatment_regimen", "radiology_impression"];

export async function loadTodayInfo(
  patients: { id: string; latest_elsewhere: { facility: string; date: string } | null }[],
  today: string = new Date().toISOString().slice(0, 10),
): Promise<Map<string, TodayInfo>> {
  const result = new Map<string, TodayInfo>();
  if (patients.length === 0) return result;
  const ids = patients.map((p) => p.id);
  // Each patient's current visit: the one with the latest visit date.
  const cur = () => sql`
    SELECT DISTINCT ON (v.patient_id) v.id, v.patient_id, v.visit_date, v.prep_status
    FROM visits v WHERE v.patient_id IN ${sql(ids)} ORDER BY v.patient_id, v.visit_date DESC, v.id DESC`;

  const [visits, docs, facts, baselineRows, pins, planRows, texts] = await Promise.all([
    cur(),
    sql`
      WITH cur AS (${cur()})
      SELECT cur.patient_id, d.document_type, d.imaging_modality,
             COALESCE(d.identity_status::text, '') IN ('mismatch', 'awaiting_oncologist', 'rejected') AS held
      FROM cur JOIN documents d ON d.visit_id = cur.id
    `,
    sql`
      WITH cur AS (${cur()}),
      live AS (
        SELECT f.id, f.patient_id, f.field_type, f.tracked_marker_id, f.value, f.unit, f.as_of_date, f.check_state, f.verification_state,
               EXISTS (
                 SELECT 1 FROM conflicts c
                 WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id) AND c.status IN ('open', 'annotated') AND ${CONFLICT_SIDES_LIVE}
               ) AS blocked
        FROM facts f JOIN cur ON cur.id = f.visit_id
        WHERE f.field_type IN ${sql(SIGNABLE_FIELDS)} AND ${LIVE_FACT_FILTER}
      )
      SELECT live.id, live.patient_id, live.field_type, live.tracked_marker_id, tm.marker_name, live.value, live.unit,
             live.as_of_date IS NOT NULL AS dated, live.check_state, live.verification_state, live.blocked,
             RANK() OVER (PARTITION BY live.patient_id, live.field_type, live.tracked_marker_id, live.blocked
                          ORDER BY live.as_of_date DESC NULLS LAST) AS rnk
      FROM live LEFT JOIN tracked_markers tm ON tm.id = live.tracked_marker_id
    `,
    // The latest signed-off value of each marker before the current visit, here only (the default compare mode).
    sql`
      WITH cur AS (${cur()}),
      prior AS (
        SELECT f.patient_id, f.tracked_marker_id, f.value, f.unit,
               RANK() OVER (PARTITION BY f.patient_id, f.tracked_marker_id ORDER BY v.visit_date DESC, f.as_of_date DESC NULLS LAST, f.id DESC) AS rnk
        FROM facts f
        JOIN cur ON cur.patient_id = f.patient_id
        JOIN visits v ON v.id = f.visit_id
        WHERE f.field_type = 'marker_value' AND f.verification_state = 'oncologist_signed_off' AND f.outside_encounter_id IS NULL
          AND v.visit_date < cur.visit_date AND ${LIVE_FACT_FILTER}
      )
      SELECT patient_id, tracked_marker_id, value, unit FROM prior WHERE rnk = 1
    `,
    sql`
      SELECT tm.patient_id, tm.id, tm.marker_name,
             ROW_NUMBER() OVER (PARTITION BY tm.patient_id ORDER BY tm.pinned_at ASC NULLS LAST, tm.marker_name ASC, tm.id) AS rn
      FROM tracked_markers tm WHERE tm.is_pinned AND tm.patient_id IN ${sql(ids)}
    `,
    sql`
      SELECT i.patient_id, i.type, i.text, to_char(i.advised_at, 'YYYY-MM-DD') AS advised_at, i.matched_document_id, i.match_confirmed_at
      FROM care_plan_items i LEFT JOIN facts f ON f.id = i.source_fact_id
      WHERE i.patient_id IN ${sql(ids)}
        AND (i.source_fact_id IS NULL OR (f.verification_state = 'oncologist_signed_off' AND ${LIVE_FACT_FILTER}))
    `,
    sql`
      SELECT DISTINCT ON (f.patient_id, f.field_type) f.patient_id, f.field_type, f.value
      FROM facts f
      WHERE f.patient_id IN ${sql(ids)} AND f.field_type IN ('diagnosis', 'treatment_regimen') AND btrim(COALESCE(f.value, '')) <> '' AND ${LIVE_FACT_FILTER}
      ORDER BY f.patient_id, f.field_type, f.as_of_date DESC NULLS LAST, f.id
    `,
  ]);

  // Sparkline of the first pinned marker: the last 8 live dated values, in the latest value's unit (units are never converted).
  const firstPinned = new Map<string, { id: string; name: string }>();
  const pinnedIds = new Set<string>();
  for (const p of pins as any[]) {
    pinnedIds.add(`${p.patient_id}:${p.id}`);
    if (Number(p.rn) === 1) firstPinned.set(p.patient_id, { id: p.id, name: p.marker_name });
  }
  const pointRows = firstPinned.size === 0 ? [] : await sql`
    SELECT * FROM (
      SELECT f.tracked_marker_id, f.id AS fact_id, f.document_id, f.verification_state, f.value, f.unit, f.reference_range,
             to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date,
             oe.id AS oe_id, oe.facility AS oe_facility, to_char(oe.encounter_date, 'YYYY-MM-DD') AS oe_date,
             ROW_NUMBER() OVER (PARTITION BY f.tracked_marker_id ORDER BY f.as_of_date DESC, f.id DESC) AS rn
      FROM facts f
      LEFT JOIN outside_encounters oe ON oe.id = f.outside_encounter_id
      WHERE f.field_type = 'marker_value' AND f.value IS NOT NULL AND f.as_of_date IS NOT NULL
        AND f.tracked_marker_id IN ${sql([...firstPinned.values()].map((p) => p.id))}
        AND ${LIVE_FACT_FILTER}
        AND NOT EXISTS (
          SELECT 1 FROM conflicts c
          WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id) AND c.status IN ('open', 'annotated') AND ${CONFLICT_SIDES_LIVE}
        )
    ) t WHERE rn <= 8 ORDER BY as_of_date ASC, fact_id
  `;
  const pointsByMarker = new Map<string, any[]>();
  for (const r of pointRows as any[]) pointsByMarker.set(r.tracked_marker_id, [...(pointsByMarker.get(r.tracked_marker_id) ?? []), r]);

  const baselines = new Map<string, DeltaBaseline>();
  for (const b of baselineRows as any[]) baselines.set(`${b.patient_id}:${deltaKey("marker_value", b.tracked_marker_id)}`, { value: b.value, unit: b.unit });

  // Plan items: the same status rule as the Plan screen, from one batched candidate-document query.
  const planPatients = [...new Set((planRows as any[]).map((r) => r.patient_id as string))];
  const candidates = await loadCandidateDocumentsFor(planPatients);
  const horizon = new Date(new Date(`${today}T00:00:00Z`).getTime() + EXPECTED_WITHIN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const planPast = new Map<string, number>();
  const expected = new Set<string>();
  for (const r of planRows as any[]) {
    const s = planItemStatus(r, candidates.get(r.patient_id) ?? [], today);
    if (s.status === "past_advised") planPast.set(r.patient_id, (planPast.get(r.patient_id) ?? 0) + 1);
    const date = s.stated ?? s.approx;
    if ((s.status === "planned" || s.status === "past_advised") && date !== null && date <= horizon) expected.add(r.patient_id);
  }

  for (const p of patients) {
    const visit = (visits as any[]).find((v) => v.patient_id === p.id);
    const myDocs = (docs as any[]).filter((d) => d.patient_id === p.id);
    const myFacts = (facts as any[]).filter((f) => f.patient_id === p.id);
    const winners = myFacts.filter((f) => !f.blocked && Number(f.rnk) === 1);

    const sign_off_count = winners.filter((f) =>
      f.check_state === "correct" && f.dated && f.verification_state !== "oncologist_signed_off" &&
      (f.field_type !== "marker_value" || f.tracked_marker_id !== null)).length;

    const items: ChangeSummaryItem[] = [];
    const changed = winners
      .filter((f) => f.field_type === "marker_value" && f.tracked_marker_id !== null && f.value !== null)
      .map((f) => ({ f, base: baselines.get(`${p.id}:${deltaKey("marker_value", f.tracked_marker_id)}`) }))
      .filter((x) => x.base && deltaForCurrentFact(x.f.value, x.f.unit, x.base) === "changed")
      .sort((a, b) =>
        Number(pinnedIds.has(`${p.id}:${b.f.tracked_marker_id}`)) - Number(pinnedIds.has(`${p.id}:${a.f.tracked_marker_id}`)) ||
        (a.f.marker_name < b.f.marker_name ? -1 : a.f.marker_name > b.f.marker_name ? 1 : 0));
    for (const { f, base } of changed.slice(0, MAX_MARKER_ITEMS)) {
      // The unit is spelled out only when it differs between the two values.
      const sameUnit = (f.unit ?? "").trim().toLowerCase() === (base!.unit ?? "").trim().toLowerCase();
      const withUnit = (v: string, u: string | null) => (sameUnit || !u ? v : `${v} ${u}`);
      items.push({ kind: "marker_changed", name: f.marker_name, from: withUnit(base!.value ?? "", base!.unit), to: withUnit(f.value, f.unit) });
    }

    const seenReports = new Set<string>();
    for (const d of myDocs) {
      if (d.held || d.document_type === "other") continue;
      const key = `${d.document_type}:${d.imaging_modality ?? ""}`;
      if (seenReports.has(key)) continue;
      seenReports.add(key);
      items.push({ kind: "new_report", type: d.document_type, modality: d.imaging_modality ?? null });
    }

    const disagree = [...new Set(myFacts.filter((f) => f.blocked).map((f) => (f.marker_name ?? String(f.field_type).replace(/_/g, " ")) as string))].sort();
    for (const name of disagree.slice(0, MAX_DISAGREE_ITEMS)) items.push({ kind: "sources_disagree", name });

    if ((planPast.get(p.id) ?? 0) > 0) items.push({ kind: "plan_past", count: planPast.get(p.id)! });
    if (p.latest_elsewhere) items.push({ kind: "elsewhere", facility: p.latest_elsewhere.facility, date: p.latest_elsewhere.date });

    const pin = firstPinned.get(p.id);
    let first_pinned_sparkline: TodayInfo["first_pinned_sparkline"] = null;
    if (pin) {
      const all = pointsByMarker.get(pin.id) ?? [];
      const unit = (all[all.length - 1]?.unit ?? "").trim().toLowerCase();
      const points = all.filter((r) => (r.unit ?? "").trim().toLowerCase() === unit).map((r): SparklinePoint => ({
        fact_id: r.fact_id, document_id: r.document_id, value: r.value, unit: r.unit, as_of_date: r.as_of_date, verification_state: r.verification_state,
        outside_encounter: r.oe_id ? { id: r.oe_id, facility: r.oe_facility, date: r.oe_date } : null,
      }));
      if (points.length > 0) {
        first_pinned_sparkline = { marker_name: pin.name, reference_range: all[all.length - 1]?.reference_range ?? null, points };
      }
    }

    const text = (field: string) => ((texts as any[]).find((t) => t.patient_id === p.id && t.field_type === field)?.value as string | undefined) ?? null;
    result.set(p.id, {
      prep_status: visit ? visit.prep_status : null,
      current_visit_document_count: myDocs.length,
      sign_off_count,
      change_summary_items: items,
      first_pinned_sparkline,
      has_plan_items_expected: expected.has(p.id),
      diagnosis_text: text("diagnosis"),
      regimen_text: text("treatment_regimen"),
    });
  }
  return result;
}
