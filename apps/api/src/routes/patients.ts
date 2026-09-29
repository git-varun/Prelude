import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { isControlledMarker } from "@opd/shared";
import {
  deltaKey, deltaForCurrentFact, deltaForAbsentField, loadDeltaBaselines, LIVE_FACT_FILTER,
  type DeltaBaseline, type DeltaStatus,
} from "../services/delta";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

interface MarkerInput {
  marker_name?: string;
}

interface CreatePatientBody {
  name?: string;
  cancer_type?: string;
  markers?: MarkerInput[];
}

function markerRow(name: string) {
  return { marker_name: name, is_custom: !isControlledMarker(name) };
}

export async function createPatient(req: Request, user: AuthedUser): Promise<Response> {
  let body: CreatePatientBody;
  try {
    body = (await req.json()) as CreatePatientBody;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }

  const markers = body.markers ?? [];
  for (const m of markers) {
    if (!m.marker_name || typeof m.marker_name !== "string") {
      return jsonError(400, "bad_request", "Each marker requires a marker_name.");
    }
  }

  const [patient] = await sql`
    INSERT INTO patients (name, cancer_type, created_by)
    VALUES (${body.name ?? null}, ${body.cancer_type ?? null}, ${user.id})
    RETURNING id, name, cancer_type, created_at, created_by
  `;

  const trackedMarkers = [];
  for (const m of markers) {
    const { marker_name, is_custom } = markerRow(m.marker_name!);
    const [row] = await sql`
      INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
      VALUES (${patient.id}, ${marker_name}, ${is_custom}, ${user.id})
      RETURNING id, marker_name, is_custom, added_at, added_by
    `;
    trackedMarkers.push(row);
  }

  return Response.json({ ...patient, tracked_markers: trackedMarkers }, { status: 201 });
}

// Not in the frozen API contract table (docs/01 §11) — added to unblock the
// Patient List screen (docs/01 §6), which the spec requires but never wires
// to an endpoint. Confirmed with you before adding. Read-only, no new
// business rules: staff/oncologist parity, no snapshot/delta computation.
const DEFAULT_PATIENT_LIST_LIMIT = 100;
const MAX_PATIENT_LIST_LIMIT = 500;

// m1-backlog B5: fine as a bare array at "tens of patients" scale (§7 N6),
// so this stays additive (?limit=&offset=, default 100) rather than
// wrapping the response — a shape change would break PatientList.tsx and
// api.listPatients' PatientSummary[] contract for no benefit yet.
export async function listPatients(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const search = url.searchParams.get("search")?.trim();
  const limit = Math.min(
    Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_PATIENT_LIST_LIMIT),
    MAX_PATIENT_LIST_LIMIT,
  );
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  const rows = search
    ? await sql`
        SELECT id, name, cancer_type, created_at, created_by FROM patients
        WHERE name ILIKE ${"%" + search + "%"}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
    : await sql`
        SELECT id, name, cancer_type, created_at, created_by FROM patients
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

  return Response.json(rows);
}

export async function getPatient(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;

  const [patient] = await sql`
    SELECT id, name, cancer_type, created_at, created_by FROM patients WHERE id = ${patientId}
  `;
  if (!patient) {
    return jsonError(404, "not_found", "Patient not found.");
  }

  const trackedMarkers = await sql`
    SELECT id, marker_name, is_custom, added_at, added_by FROM tracked_markers
    WHERE patient_id = ${patientId}
    ORDER BY added_at ASC
  `;

  return Response.json({ ...patient, tracked_markers: trackedMarkers });
}

export async function addMarker(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const patientId = req.params.id;

  const [patient] = await sql`SELECT id FROM patients WHERE id = ${patientId}`;
  if (!patient) {
    return jsonError(404, "not_found", "Patient not found.");
  }

  let body: MarkerInput;
  try {
    body = (await req.json()) as MarkerInput;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }
  if (!body.marker_name || typeof body.marker_name !== "string") {
    return jsonError(400, "bad_request", "marker_name is required.");
  }

  const { marker_name, is_custom } = markerRow(body.marker_name);
  const [row] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
    VALUES (${patientId}, ${marker_name}, ${is_custom}, ${user.id})
    RETURNING id, marker_name, is_custom, added_at, added_by
  `;

  return Response.json(row, { status: 201 });
}

interface SnapshotFactRow {
  fact_id: string | null;
  tracked_marker_id?: string | null;
  marker_name?: string | null;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  as_of_date: string | null;
  coverage_status: string | null;
  verification_state: string | null;
  document_id: string | null;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
}

// One live fact per marker, latest as_of_date; an exact-date tie surfaces both rows. This is a
// heuristic, not full §4 conflict-display coverage: an open/both-stand conflict with differing
// dates, an undated sibling, or facts from another visit (conflicts are patient-wide) can still
// drop one side — deferred to M7, which owns real conflict-driven selection.
async function loadTumorMarkers(patientId: string, visitId: string): Promise<SnapshotFactRow[]> {
  return sql`
    WITH live AS (
      SELECT f.* FROM facts f
      WHERE f.visit_id = ${visitId} AND f.field_type = 'marker_value' AND f.tracked_marker_id IS NOT NULL
        AND ${LIVE_FACT_FILTER}
    ), ranked AS (
      SELECT f.*, RANK() OVER (PARTITION BY f.tracked_marker_id ORDER BY f.as_of_date DESC NULLS LAST) AS rnk
      FROM live f
    )
    SELECT tm.id AS tracked_marker_id, tm.marker_name,
           r.id AS fact_id, r.value, r.unit, r.reference_range,
           to_char(r.as_of_date, 'YYYY-MM-DD') AS as_of_date,
           r.coverage_status, r.verification_state,
           r.document_id, r.source_page, r.source_location, r.source_snippet
    FROM tracked_markers tm
    LEFT JOIN ranked r ON r.tracked_marker_id = tm.id AND r.rnk = 1
    WHERE tm.patient_id = ${patientId}
    ORDER BY tm.added_at ASC, r.as_of_date DESC NULLS LAST, r.id
  `;
}

// Single latest treatment_regimen fact, never a history array; same tie heuristic as markers.
async function loadCurrentTreatment(visitId: string): Promise<SnapshotFactRow[]> {
  return sql`
    WITH live AS (
      SELECT f.* FROM facts f
      WHERE f.visit_id = ${visitId} AND f.field_type = 'treatment_regimen' AND ${LIVE_FACT_FILTER}
    ), ranked AS (
      SELECT f.*, RANK() OVER (ORDER BY f.as_of_date DESC NULLS LAST) AS rnk FROM live f
    )
    SELECT id AS fact_id, value, unit, reference_range,
           to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date,
           coverage_status, verification_state,
           document_id, source_page, source_location, source_snippet
    FROM ranked WHERE rnk = 1
    ORDER BY id
  `;
}

// Every live radiology_impression fact for the visit, no "latest only" narrowing.
async function loadRadiology(visitId: string): Promise<SnapshotFactRow[]> {
  return sql`
    SELECT f.id AS fact_id, f.value, f.unit, f.reference_range,
           to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date,
           f.coverage_status, f.verification_state,
           f.document_id, f.source_page, f.source_location, f.source_snippet
    FROM facts f
    WHERE f.visit_id = ${visitId} AND f.field_type = 'radiology_impression' AND ${LIVE_FACT_FILTER}
    ORDER BY f.as_of_date DESC NULLS LAST, f.id
  `;
}

interface Provenance {
  document_id: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
  fallback_level: "exact" | "page" | "document";
}

function provenanceFor(documentId: string, sourcePage: number | null, sourceLocation: string | null, sourceSnippet: string | null): Provenance {
  const fallback_level = sourcePage != null && sourceLocation != null ? "exact" : sourcePage != null ? "page" : "document";
  return { document_id: documentId, source_page: sourcePage, source_location: sourceLocation, source_snippet: sourceSnippet, fallback_level };
}

interface ConflictEntry {
  conflict_id: string;
  status: string;
  other_fact_id: string;
  other_value: string | null;
  other_source: Provenance;
  authoritative_fact_id: string | null;
  historical: boolean;
}

// Batched across all returned facts; unions both pairing orientations since conflicts are pairwise.
async function loadConflicts(factIds: string[]): Promise<Map<string, ConflictEntry[]>> {
  const byFact = new Map<string, ConflictEntry[]>();
  if (factIds.length === 0) return byFact;

  const rows = await sql`
    SELECT pairs.conflict_id, pairs.status, pairs.authoritative_fact_id, pairs.this_fact_id, pairs.other_fact_id,
           ofact.value AS other_value, ofact.document_id AS other_document_id,
           ofact.source_page AS other_source_page, ofact.source_location AS other_source_location,
           ofact.source_snippet AS other_source_snippet
    FROM (
      SELECT c.id AS conflict_id, c.status, c.authoritative_fact_id, c.fact_id_a AS this_fact_id, c.fact_id_b AS other_fact_id
      FROM conflicts c WHERE c.fact_id_a IN ${sql(factIds)}
      UNION ALL
      SELECT c.id, c.status, c.authoritative_fact_id, c.fact_id_b, c.fact_id_a
      FROM conflicts c WHERE c.fact_id_b IN ${sql(factIds)}
    ) pairs
    JOIN facts ofact ON ofact.id = pairs.other_fact_id
  `;

  for (const row of rows) {
    const entry: ConflictEntry = {
      conflict_id: row.conflict_id,
      status: row.status,
      other_fact_id: row.other_fact_id,
      other_value: row.other_value,
      other_source: provenanceFor(row.other_document_id, row.other_source_page, row.other_source_location, row.other_source_snippet),
      authoritative_fact_id: row.authoritative_fact_id,
      historical: row.status === "resolved" && row.authoritative_fact_id !== null,
    };
    const list = byFact.get(row.this_fact_id);
    if (list) list.push(entry);
    else byFact.set(row.this_fact_id, [entry]);
  }
  return byFact;
}

function fieldObject(
  row: SnapshotFactRow,
  fieldType: string,
  conflictsByFactId: Map<string, ConflictEntry[]>,
  deltaStatus: DeltaStatus | null,
) {
  const factId = row.fact_id;
  return {
    fact_id: factId,
    field_type: fieldType,
    tracked_marker_id: row.tracked_marker_id ?? null,
    marker_name: row.marker_name ?? null,
    value: factId ? row.value : null,
    unit: factId ? row.unit : null,
    reference_range: factId ? row.reference_range : null,
    as_of_date: factId ? row.as_of_date : null,
    coverage_status: factId ? row.coverage_status : "not_found_in_document_set",
    verification_state: factId ? row.verification_state : null,
    delta_status: deltaStatus,
    conflicts: factId ? (conflictsByFactId.get(factId) ?? []) : [],
    provenance: factId ? provenanceFor(row.document_id!, row.source_page, row.source_location, row.source_snippet) : null,
  };
}

const EMPTY_ROW: SnapshotFactRow = {
  fact_id: null, value: null, unit: null, reference_range: null, as_of_date: null,
  coverage_status: null, verification_state: null, document_id: null,
  source_page: null, source_location: null, source_snippet: null,
};

// Unlike tumor_markers (one row per tracked marker via its LEFT JOIN), synthesis here only fires when the block is empty and history shows this field_type was signed off before.
function buildSingleKeyBlock(
  rows: SnapshotFactRow[],
  fieldType: string,
  baselines: Map<string, DeltaBaseline>,
  conflictsByFactId: Map<string, ConflictEntry[]>,
) {
  const baseline = baselines.get(deltaKey(fieldType, null));
  if (rows.length === 0) {
    const delta = deltaForAbsentField(baseline);
    return delta === null ? [] : [fieldObject(EMPTY_ROW, fieldType, conflictsByFactId, delta)];
  }
  return rows.map((r) => fieldObject(r, fieldType, conflictsByFactId, deltaForCurrentFact(r.value, baseline)));
}

export async function getPatientSnapshot(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;
  if (!isUuid(patientId)) return jsonError(404, "not_found", "Patient not found.");

  const [patient] = await sql`SELECT id, name, cancer_type FROM patients WHERE id = ${patientId}`;
  if (!patient) return jsonError(404, "not_found", "Patient not found.");

  const visits = await sql`
    SELECT id, to_char(visit_date, 'YYYY-MM-DD') AS visit_date FROM visits
    WHERE patient_id = ${patientId}
    ORDER BY visit_date DESC, id DESC
    LIMIT 2
  `;
  const [currentVisit, previousVisit] = visits;
  if (!currentVisit) return jsonError(404, "not_found", "This patient has no visits yet.");

  const [markerRows, treatmentRows, radiologyRows, baselines] = await Promise.all([
    loadTumorMarkers(patientId, currentVisit.id),
    loadCurrentTreatment(currentVisit.id),
    loadRadiology(currentVisit.id),
    loadDeltaBaselines(patientId, currentVisit.visit_date),
  ]);

  const factIds = [...markerRows, ...treatmentRows, ...radiologyRows]
    .map((r) => r.fact_id)
    .filter((id): id is string => id != null);
  const conflicts = await loadConflicts(factIds);

  const tumorMarkers = markerRows.map((r) => {
    const baseline = baselines.get(deltaKey("marker_value", r.tracked_marker_id ?? null));
    const delta = r.fact_id ? deltaForCurrentFact(r.value, baseline) : deltaForAbsentField(baseline);
    return fieldObject(r, "marker_value", conflicts, delta);
  });
  const currentTreatment = buildSingleKeyBlock(treatmentRows, "treatment_regimen", baselines, conflicts);
  const radiology = buildSingleKeyBlock(radiologyRows, "radiology_impression", baselines, conflicts);

  const sinceLastVisit = [...currentTreatment, ...tumorMarkers, ...radiology].filter(
    (entry) => entry.delta_status !== null && entry.delta_status !== "unchanged",
  );

  return Response.json({
    patient: { id: patient.id, name: patient.name, cancer_type: patient.cancer_type },
    current_visit: { id: currentVisit.id, visit_date: currentVisit.visit_date },
    previous_visit: previousVisit
      ? { id: previousVisit.id, visit_date: previousVisit.visit_date }
      : { id: null, visit_date: null },
    current_treatment: currentTreatment,
    tumor_markers: tumorMarkers,
    radiology,
    since_last_visit: sinceLastVisit,
  });
}
