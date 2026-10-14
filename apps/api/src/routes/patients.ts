import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { isControlledMarker } from "@prelude/shared";
import {
  deltaKey, deltaForCurrentFact, deltaForAbsentField, loadDeltaBaselines, LIVE_FACT_FILTER, type CompareMode, CONFLICT_SIDES_LIVE,
  type DeltaBaseline, type DeltaStatus,
} from "../services/delta";
import { provenanceFor, type Provenance } from "../services/provenance";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

interface MarkerInput {
  marker_name?: string;
}

const SEX_VALUES = ["male", "female", "other", "unknown"] as const;
const STAGE_VALUES = ["0", "I", "II", "III", "IV"] as const;
const PATIENT_ORIGIN_VALUES = ["own_hospital", "referral"] as const;

interface CreatePatientBody {
  name?: string;
  cancer_type?: string;
  markers?: MarkerInput[];
  date_of_birth?: string | null;
  sex?: (typeof SEX_VALUES)[number] | null;
  mrn?: string | null;
  diagnosis_date?: string | null;
  stage?: (typeof STAGE_VALUES)[number] | null;
  referring_physician?: string | null;
  patient_origin?: (typeof PATIENT_ORIGIN_VALUES)[number];
}

interface UpdatePatientBody {
  name?: string;
  cancer_type?: string;
  date_of_birth?: string | null;
  sex?: (typeof SEX_VALUES)[number] | null;
  mrn?: string | null;
  diagnosis_date?: string | null;
  stage?: (typeof STAGE_VALUES)[number] | null;
  referring_physician?: string | null;
  patient_origin?: (typeof PATIENT_ORIGIN_VALUES)[number];
}

function validateDemographics(body: {
  sex?: string | null;
  stage?: string | null;
  patient_origin?: string;
}): string | null {
  if (body.sex != null && !(SEX_VALUES as readonly string[]).includes(body.sex)) {
    return `sex must be one of: ${SEX_VALUES.join(", ")}.`;
  }
  if (body.stage != null && !(STAGE_VALUES as readonly string[]).includes(body.stage)) {
    return `stage must be one of: ${STAGE_VALUES.join(", ")}.`;
  }
  if (body.patient_origin !== undefined && !(PATIENT_ORIGIN_VALUES as readonly string[]).includes(body.patient_origin)) {
    return `patient_origin must be one of: ${PATIENT_ORIGIN_VALUES.join(", ")}.`;
  }
  return null;
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

  const demographicsError = validateDemographics(body);
  if (demographicsError) {
    return jsonError(400, "bad_request", demographicsError);
  }

  // One transaction for the patient row plus every marker row: a mid-loop
  // failure previously left a permanently partial patient (some markers
  // committed, no client-visible id to retry against) -- same failure mode
  // services/documents.ts's persistExtractedFacts already guards against
  // for fact inserts (m2-backlog C5), just never applied here.
  const { patient, trackedMarkers } = await sql.begin(async (tx) => {
    const [patient] = await tx`
      INSERT INTO patients (
        name, cancer_type, created_by, date_of_birth, sex, mrn, diagnosis_date, stage, referring_physician, patient_origin
      )
      VALUES (
        ${body.name ?? null}, ${body.cancer_type ?? null}, ${user.id},
        ${body.date_of_birth ?? null}, ${body.sex ?? null}, ${body.mrn ?? null},
        ${body.diagnosis_date ?? null}, ${body.stage ?? null}, ${body.referring_physician ?? null},
        ${body.patient_origin ?? "own_hospital"}
      )
      RETURNING id, name, cancer_type, created_at, created_by, sex, mrn, stage, referring_physician, patient_origin,
                to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
                to_char(diagnosis_date, 'YYYY-MM-DD') AS diagnosis_date
    `;

    const trackedMarkers = [];
    for (const m of markers) {
      const { marker_name, is_custom } = markerRow(m.marker_name!);
      const [row] = await tx`
        INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
        VALUES (${patient.id}, ${marker_name}, ${is_custom}, ${user.id})
        RETURNING id, marker_name, is_custom, added_at, added_by
      `;
      trackedMarkers.push(row);
    }
    return { patient, trackedMarkers };
  });

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

  // Needs-attention: live facts (LIVE_FACT_FILTER, same rule used everywhere
  // else) on the patient's current (most recent) visit that are either
  // unreviewed by staff, flagged uncertain by extraction, or party to an
  // open/annotated conflict -- the same three states that block sign-off.
  // Scoped to the current visit only, matching what Snapshot would actually
  // show if opened right now, not the patient's entire history.
  const needsAttentionSubquery = sql`
    (SELECT count(DISTINCT f.id)::int FROM facts f
     WHERE f.visit_id = (SELECT id FROM visits WHERE patient_id = p.id ORDER BY visit_date DESC, id DESC LIMIT 1)
       AND ${LIVE_FACT_FILTER}
       AND (
         f.verification_state = 'unverified'
         OR f.coverage_status = 'extraction_uncertain'
         OR EXISTS (
           SELECT 1 FROM conflicts c
           WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id) AND c.status IN ('open', 'annotated') AND ${CONFLICT_SIDES_LIVE}
         )
       )
    ) AS needs_attention_count
  `;

  // Spot-check backlog: unchecked live facts on the current visit (same scoping as needs_attention_count).
  const uncheckedSubquery = sql`
    (SELECT count(*)::int FROM facts f
     WHERE f.visit_id = (SELECT id FROM visits WHERE patient_id = p.id ORDER BY visit_date DESC, id DESC LIMIT 1)
       AND ${LIVE_FACT_FILTER}
       AND f.check_state = 'unchecked'
    ) AS unchecked_fact_count
  `;

  // Documents held for an identity mismatch (not 'partial': that is a softer signal and its facts stay live).
  // Independent of needs_attention_count, which already excludes held facts via LIVE_FACT_FILTER.
  const heldDocumentSubquery = sql`
    (SELECT count(*)::int FROM documents d WHERE d.patient_id = p.id AND d.identity_status = 'mismatch') AS held_document_count
  `;

  // AM-03: the latest visit elsewhere, only when it is newer than the latest visit here (or there is no visit here).
  const elsewhereSubquery = sql`
    (SELECT json_build_object('facility', oe.facility, 'date', to_char(oe.encounter_date, 'YYYY-MM-DD'))
     FROM outside_encounters oe
     WHERE oe.patient_id = p.id
       AND (NOT EXISTS (SELECT 1 FROM visits v WHERE v.patient_id = p.id)
            OR oe.encounter_date > (SELECT MAX(v.visit_date) FROM visits v WHERE v.patient_id = p.id))
     ORDER BY oe.encounter_date DESC, oe.id DESC LIMIT 1
    ) AS latest_elsewhere
  `;

  // Most recently seen first is more clinically useful than most recently
  // registered -- a patient with no visits yet sorts last (NULLS LAST).
  const rows = search
    ? await sql`
        SELECT p.id, p.name, p.cancer_type, p.created_at, p.created_by, p.mrn, p.patient_origin,
               to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.stage,
               (SELECT to_char(MAX(v.visit_date), 'YYYY-MM-DD') FROM visits v WHERE v.patient_id = p.id) AS last_visit_date,
               ${needsAttentionSubquery},
               ${uncheckedSubquery},
               ${heldDocumentSubquery},
               ${elsewhereSubquery}
        FROM patients p
        WHERE p.name ILIKE ${"%" + search + "%"}
        ORDER BY last_visit_date DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `
    : await sql`
        SELECT p.id, p.name, p.cancer_type, p.created_at, p.created_by, p.mrn, p.patient_origin,
               to_char(p.date_of_birth, 'YYYY-MM-DD') AS date_of_birth, p.stage,
               (SELECT to_char(MAX(v.visit_date), 'YYYY-MM-DD') FROM visits v WHERE v.patient_id = p.id) AS last_visit_date,
               ${needsAttentionSubquery},
               ${uncheckedSubquery},
               ${heldDocumentSubquery},
               ${elsewhereSubquery}
        FROM patients p
        ORDER BY last_visit_date DESC NULLS LAST
        LIMIT ${limit} OFFSET ${offset}
      `;

  return Response.json(rows);
}

// Documents needing an identity decision for one patient: held (mismatch) and partial. Explicit columns only --
// file_ref is a storage path and must never leave the API through this listing. Confirming/rejecting flips the
// status (POST /documents/:id/identity), which drops the row from this list.
export async function getPatientDocumentIdentity(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;
  if (!isUuid(patientId)) return jsonError(404, "not_found", "Patient not found.");

  const [patient] = await sql`SELECT name FROM patients WHERE id = ${patientId}`;
  if (!patient) return jsonError(404, "not_found", "Patient not found.");

  const documents = await sql`
    SELECT id, document_type, lab_name, patient_name_on_report, identity_status, uploaded_at
    FROM documents
    WHERE patient_id = ${patientId} AND identity_status IN ('mismatch', 'partial')
    ORDER BY uploaded_at DESC, id
  `;
  return Response.json({ patient_name: patient.name, documents });
}

export async function getPatient(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;

  const [patient] = await sql`
    SELECT id, name, cancer_type, created_at, created_by, mrn, sex, patient_origin, stage, referring_physician,
           to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
           to_char(diagnosis_date, 'YYYY-MM-DD') AS diagnosis_date
    FROM patients WHERE id = ${patientId}
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

// Partial update, same COALESCE-over-undefined pattern as PATCH /facts/:id
// (facts.ts patchFact) -- a field omitted from the body is left unchanged,
// not clearable to null via this endpoint.
export async function updatePatient(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;

  let body: UpdatePatientBody;
  try {
    body = (await req.json()) as UpdatePatientBody;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }

  const demographicsError = validateDemographics(body);
  if (demographicsError) {
    return jsonError(400, "bad_request", demographicsError);
  }

  const [patient] = await sql`
    UPDATE patients SET
      name = COALESCE(${body.name ?? null}::text, name),
      cancer_type = COALESCE(${body.cancer_type ?? null}::text, cancer_type),
      date_of_birth = COALESCE(${body.date_of_birth ?? null}::date, date_of_birth),
      sex = COALESCE(${body.sex ?? null}::text, sex),
      mrn = COALESCE(${body.mrn ?? null}::text, mrn),
      diagnosis_date = COALESCE(${body.diagnosis_date ?? null}::date, diagnosis_date),
      stage = COALESCE(${body.stage ?? null}::text, stage),
      referring_physician = COALESCE(${body.referring_physician ?? null}::text, referring_physician),
      patient_origin = COALESCE(${body.patient_origin ?? null}::text, patient_origin)
    WHERE id = ${patientId}
    RETURNING id, name, cancer_type, created_at, created_by, mrn, sex, patient_origin, stage, referring_physician,
              to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
              to_char(diagnosis_date, 'YYYY-MM-DD') AS diagnosis_date
  `;
  if (!patient) {
    return jsonError(404, "not_found", "Patient not found.");
  }

  return Response.json(patient);
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
  check_state?: string | null;
  document_id: string | null;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
  imaging_modality?: string | null;
}

// For each tracked marker: one top-level entry, the live fact with the latest as_of_date
// among facts with no open/annotated conflict (an undated fact never outranks a dated one —
// NULLS LAST). A fact that IS party to an open/annotated conflict always surfaces regardless
// of date — same-date-with-differing-value is one way that arises, but so is any other open
// conflict; conflict detection (not this selection logic) is the source of truth for that, and
// both sides of it surface via the same conflicts-array/top-level-entries rule as before.
async function loadTumorMarkers(patientId: string, visitId: string): Promise<SnapshotFactRow[]> {
  return sql`
    WITH live AS (
      SELECT f.* FROM facts f
      WHERE f.visit_id = ${visitId} AND f.field_type = 'marker_value' AND f.tracked_marker_id IS NOT NULL
        AND ${LIVE_FACT_FILTER}
    ), blocked AS (
      SELECT f.id FROM live f
      WHERE EXISTS (
        SELECT 1 FROM conflicts c
        WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id) AND c.status IN ('open', 'annotated') AND ${CONFLICT_SIDES_LIVE}
      )
    ), ranked AS (
      SELECT f.*, RANK() OVER (PARTITION BY f.tracked_marker_id ORDER BY f.as_of_date DESC NULLS LAST) AS rnk
      FROM live f
      WHERE f.id NOT IN (SELECT id FROM blocked)
    ), winners AS (
      SELECT id, tracked_marker_id, value, unit, reference_range, as_of_date, coverage_status,
             verification_state, check_state, document_id, source_page, source_location, source_snippet
      FROM ranked WHERE rnk = 1
      UNION ALL
      SELECT id, tracked_marker_id, value, unit, reference_range, as_of_date, coverage_status,
             verification_state, check_state, document_id, source_page, source_location, source_snippet
      FROM live WHERE id IN (SELECT id FROM blocked)
    )
    SELECT tm.id AS tracked_marker_id, tm.marker_name,
           w.id AS fact_id, w.value, w.unit, w.reference_range,
           to_char(w.as_of_date, 'YYYY-MM-DD') AS as_of_date,
           w.coverage_status, w.verification_state, w.check_state,
           w.document_id, w.source_page, w.source_location, w.source_snippet
    FROM tracked_markers tm
    LEFT JOIN winners w ON w.tracked_marker_id = tm.id
    WHERE tm.patient_id = ${patientId}
    ORDER BY tm.added_at ASC, w.as_of_date DESC NULLS LAST, w.id
  `;
}

// Single latest non-conflicted treatment_regimen fact, plus any fact party to an open/annotated
// conflict regardless of date — same selection rule as tumor_markers/radiology.
async function loadCurrentTreatment(visitId: string): Promise<SnapshotFactRow[]> {
  return sql`
    WITH live AS (
      SELECT f.* FROM facts f
      WHERE f.visit_id = ${visitId} AND f.field_type = 'treatment_regimen' AND ${LIVE_FACT_FILTER}
    ), blocked AS (
      SELECT f.id FROM live f
      WHERE EXISTS (
        SELECT 1 FROM conflicts c
        WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id) AND c.status IN ('open', 'annotated') AND ${CONFLICT_SIDES_LIVE}
      )
    ), ranked AS (
      SELECT f.*, RANK() OVER (ORDER BY f.as_of_date DESC NULLS LAST) AS rnk
      FROM live f
      WHERE f.id NOT IN (SELECT id FROM blocked)
    )
    SELECT id AS fact_id, value, unit, reference_range,
           to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date,
           coverage_status, verification_state, check_state,
           document_id, source_page, source_location, source_snippet
    FROM ranked WHERE rnk = 1
    UNION ALL
    SELECT id AS fact_id, value, unit, reference_range,
           to_char(as_of_date, 'YYYY-MM-DD') AS as_of_date,
           coverage_status, verification_state, check_state,
           document_id, source_page, source_location, source_snippet
    FROM live WHERE id IN (SELECT id FROM blocked)
    ORDER BY as_of_date DESC NULLS LAST, fact_id
  `;
}

// Single latest radiology_impression fact, same selection rule as tumor markers and
// current_treatment: latest as_of_date among non-conflicted facts (undated never wins over
// dated), plus any fact party to an open/annotated conflict regardless of date. Joins
// documents for imaging_modality (m3-backlog #3) -- purely descriptive metadata, not part
// of the selection rule itself.
async function loadRadiology(visitId: string): Promise<SnapshotFactRow[]> {
  return sql`
    WITH live AS (
      SELECT f.* FROM facts f
      WHERE f.visit_id = ${visitId} AND f.field_type = 'radiology_impression' AND ${LIVE_FACT_FILTER}
    ), blocked AS (
      SELECT f.id FROM live f
      WHERE EXISTS (
        SELECT 1 FROM conflicts c
        WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id) AND c.status IN ('open', 'annotated') AND ${CONFLICT_SIDES_LIVE}
      )
    ), ranked AS (
      SELECT f.*, RANK() OVER (ORDER BY f.as_of_date DESC NULLS LAST) AS rnk
      FROM live f
      WHERE f.id NOT IN (SELECT id FROM blocked)
    )
    SELECT r.id AS fact_id, r.value, r.unit, r.reference_range,
           to_char(r.as_of_date, 'YYYY-MM-DD') AS as_of_date,
           r.coverage_status, r.verification_state, r.check_state,
           r.document_id, r.source_page, r.source_location, r.source_snippet,
           d.imaging_modality
    FROM ranked r LEFT JOIN documents d ON d.id = r.document_id
    WHERE r.rnk = 1
    UNION ALL
    SELECT l.id AS fact_id, l.value, l.unit, l.reference_range,
           to_char(l.as_of_date, 'YYYY-MM-DD') AS as_of_date,
           l.coverage_status, l.verification_state, l.check_state,
           l.document_id, l.source_page, l.source_location, l.source_snippet,
           d.imaging_modality
    FROM live l LEFT JOIN documents d ON d.id = l.document_id
    WHERE l.id IN (SELECT id FROM blocked)
    ORDER BY as_of_date DESC NULLS LAST, fact_id
  `;
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
      FROM conflicts c WHERE c.fact_id_a IN ${sql(factIds)} AND ${CONFLICT_SIDES_LIVE}
      UNION ALL
      SELECT c.id, c.status, c.authoritative_fact_id, c.fact_id_b, c.fact_id_a
      FROM conflicts c WHERE c.fact_id_b IN ${sql(factIds)} AND ${CONFLICT_SIDES_LIVE}
    ) pairs
    JOIN facts ofact ON ofact.id = pairs.other_fact_id
    -- the other side of a conflict is shown to the reader: never a fact from a held/rejected document
    WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.id = ofact.document_id AND d.identity_status IN ('mismatch', 'rejected'))
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
  outsideByFactId: Map<string, OutsideRef>,
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
    check_state: factId ? (row.check_state ?? "unchecked") : null,
    delta_status: deltaStatus,
    conflicts: factId ? (conflictsByFactId.get(factId) ?? []) : [],
    provenance: factId ? provenanceFor(row.document_id!, row.source_page, row.source_location, row.source_snippet) : null,
    imaging_modality: factId ? (row.imaging_modality ?? null) : null,
    outside_encounter: factId ? (outsideByFactId.get(factId) ?? null) : null,
  };
}

// AM-03: the visit elsewhere a fact came from, if any (null for every fact from a visit here).
export interface OutsideRef { id: string; facility: string; date: string }

async function loadOutsideRefs(factIds: string[]): Promise<Map<string, OutsideRef>> {
  const map = new Map<string, OutsideRef>();
  if (factIds.length === 0) return map;
  const rows = await sql`
    SELECT f.id AS fact_id, oe.id, oe.facility, to_char(oe.encounter_date, 'YYYY-MM-DD') AS date
    FROM facts f JOIN outside_encounters oe ON oe.id = f.outside_encounter_id
    WHERE f.id IN ${sql(factIds)}
  `;
  for (const r of rows) map.set(r.fact_id, { id: r.id, facility: r.facility, date: r.date });
  return map;
}

const EMPTY_ROW: SnapshotFactRow = {
  fact_id: null, value: null, unit: null, reference_range: null, as_of_date: null,
  coverage_status: null, verification_state: null, document_id: null,
  source_page: null, source_location: null, source_snippet: null, imaging_modality: null,
};

// Unlike tumor_markers (one row per tracked marker via its LEFT JOIN), synthesis here only fires when the block is empty and history shows this field_type was signed off before.
function buildSingleKeyBlock(
  rows: SnapshotFactRow[],
  fieldType: string,
  baselines: Map<string, DeltaBaseline>,
  conflictsByFactId: Map<string, ConflictEntry[]>,
  outsideByFactId: Map<string, OutsideRef>,
) {
  const baseline = baselines.get(deltaKey(fieldType, null));
  if (rows.length === 0) {
    const delta = deltaForAbsentField(baseline);
    return delta === null ? [] : [fieldObject(EMPTY_ROW, fieldType, conflictsByFactId, delta, outsideByFactId)];
  }
  return rows.map((r) => fieldObject(r, fieldType, conflictsByFactId, deltaForCurrentFact(r.value, r.unit, baseline), outsideByFactId));
}

// M3-07: pinned markers in fixed order (pinned_at, then name), built from the same tumor-marker winners and delta
// baselines the rest of the snapshot uses. The sparkline is the last 8 live dated values; held documents never reach it.
async function loadPins(
  patientId: string,
  tumorMarkers: ReturnType<typeof fieldObject>[],
  baselines: Map<string, DeltaBaseline>,
) {
  const rows = await sql`
    SELECT tm.id, tm.marker_name, tm.is_pinned, tm.suggested_by, tm.suggested_note,
           pu.name AS pinned_by_name, su.name AS suggested_by_name
    FROM tracked_markers tm
    LEFT JOIN users pu ON pu.id = tm.pinned_by
    LEFT JOIN users su ON su.id = tm.suggested_by
    WHERE tm.patient_id = ${patientId}
    ORDER BY tm.is_pinned DESC, tm.pinned_at ASC NULLS LAST, tm.marker_name ASC, tm.id
  `;
  const pinned = rows.filter((r: any) => r.is_pinned);
  type PinPoint = { fact_id: string; document_id: string | null; value: string; unit: string | null; as_of_date: string; verification_state: string };
  const history = new Map<string, PinPoint[]>();
  if (pinned.length > 0) {
    const points = await sql`
      SELECT * FROM (
        SELECT f.tracked_marker_id, f.id AS fact_id, f.document_id, f.verification_state, f.value, f.unit, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date,
               ROW_NUMBER() OVER (PARTITION BY f.tracked_marker_id ORDER BY f.as_of_date DESC, f.id DESC) AS rn
        FROM facts f
        WHERE f.patient_id = ${patientId} AND f.field_type = 'marker_value' AND f.value IS NOT NULL
          AND f.as_of_date IS NOT NULL AND f.tracked_marker_id IN ${sql(pinned.map((r: any) => r.id))}
          AND ${LIVE_FACT_FILTER}
      ) t WHERE rn <= 8 ORDER BY as_of_date ASC, fact_id
    `;
    for (const pt of points) {
      const list = history.get(pt.tracked_marker_id) ?? [];
      list.push({ fact_id: pt.fact_id, document_id: pt.document_id, value: pt.value, unit: pt.unit, as_of_date: pt.as_of_date, verification_state: pt.verification_state });
      history.set(pt.tracked_marker_id, list);
    }
  }
  const watchlist = pinned.map((r: any) => {
    const rowsForMarker = tumorMarkers.filter((m) => m.tracked_marker_id === r.id && m.fact_id !== null);
    const current = rowsForMarker[0] ?? null;
    const baseline = baselines.get(deltaKey("marker_value", r.id));
    // Open/annotated conflict, as the tumor-marker block detects it. Both sides are left out of the sparkline.
    const blocking = rowsForMarker.flatMap((m) => m.conflicts.filter((c) => c.status === "open" || c.status === "annotated").map((c) => ({ fact: m.fact_id as string, c })));
    const conflict = blocking.length > 0;
    const conflictFacts = new Set(blocking.flatMap((b) => [b.fact, b.c.other_fact_id]));
    const all = history.get(r.id) ?? [];
    const lastSeenPoint = all[all.length - 1] ?? null;
    // No unit conversion: only points in the latest value's unit are plotted.
    const normUnit = (u: string | null) => (u ?? "").trim().toLowerCase();
    const plotted = all.filter((p) => !conflictFacts.has(p.fact_id) && (!current || normUnit(p.unit) === normUnit(current.unit)));
    const unitChanged = current !== null && all.some((p) => !conflictFacts.has(p.fact_id) && normUnit(p.unit) !== normUnit(current.unit));
    return {
      tracked_marker_id: r.id as string,
      marker_name: r.marker_name as string,
      pinned_by_name: (r.pinned_by_name as string | null) ?? null,
      missing: current === null,
      conflict,
      conflict_id: (blocking[0]?.c.conflict_id as string | undefined) ?? null,
      unit_changed: unitChanged,
      latest: current && {
        fact_id: current.fact_id, document_id: current.provenance?.document_id ?? null,
        value: current.value, unit: current.unit, reference_range: current.reference_range,
        as_of_date: current.as_of_date, delta_status: current.delta_status,
        verification_state: current.verification_state,
        was: baseline ? { value: baseline.value, unit: baseline.unit } : null,
        outside_encounter: current.outside_encounter,
      },
      sparkline: plotted,
      last_seen: lastSeenPoint,
    };
  });
  const suggestedPins = rows
    .filter((r: any) => !r.is_pinned && r.suggested_by)
    .map((r: any) => ({
      tracked_marker_id: r.id as string, marker_name: r.marker_name as string,
      suggested_by_name: r.suggested_by_name as string, note: (r.suggested_note as string | null) ?? null,
    }));
  const pinOptions = rows
    .map((r: any) => ({ tracked_marker_id: r.id as string, marker_name: r.marker_name as string, is_pinned: !!r.is_pinned, suggested: !!r.suggested_by }))
    .sort((a: any, b: any) => a.marker_name.localeCompare(b.marker_name));
  return { watchlist, suggested_pins: suggestedPins, pin_options: pinOptions };
}

export async function getPatientSnapshot(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;
  if (!isUuid(patientId)) return jsonError(404, "not_found", "Patient not found.");

  const [patient] = await sql`
    SELECT id, name, cancer_type, mrn, sex, patient_origin, stage, referring_physician,
           to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
           to_char(diagnosis_date, 'YYYY-MM-DD') AS diagnosis_date
    FROM patients WHERE id = ${patientId}
  `;
  if (!patient) return jsonError(404, "not_found", "Patient not found.");

  const visits = await sql`
    SELECT id, to_char(visit_date, 'YYYY-MM-DD') AS visit_date FROM visits
    WHERE patient_id = ${patientId}
    ORDER BY visit_date DESC, id DESC
    LIMIT 2
  `;
  const [currentVisit, previousVisit] = visits;
  if (!currentVisit) return jsonError(404, "not_found", "This patient has no visits yet.");

  // AM-03: "here" (default) compares with visits here only; "any" also uses visits elsewhere. Never defaults to "any".
  const compareParam = new URL(req.url).searchParams.get("compare") ?? "here";
  if (compareParam !== "here" && compareParam !== "any") return jsonError(400, "bad_request", "compare must be 'here' or 'any'.");
  const compare: CompareMode = compareParam;

  const [markerRows, treatmentRows, radiologyRows, baselines] = await Promise.all([
    loadTumorMarkers(patientId, currentVisit.id),
    loadCurrentTreatment(currentVisit.id),
    loadRadiology(currentVisit.id),
    loadDeltaBaselines(patientId, currentVisit.visit_date, compare, currentVisit.id),
  ]);

  const factIds = [...markerRows, ...treatmentRows, ...radiologyRows]
    .map((r) => r.fact_id)
    .filter((id): id is string => id != null);
  const [conflicts, outsideRefs, [latestAny]] = await Promise.all([
    loadConflicts(factIds),
    loadOutsideRefs(factIds),
    sql`
      SELECT id, facility, to_char(encounter_date, 'YYYY-MM-DD') AS date FROM outside_encounters
      WHERE patient_id = ${patientId} AND encounter_date < ${currentVisit.visit_date}::date
      ORDER BY encounter_date DESC, id DESC LIMIT 1
    `,
  ]);

  const tumorMarkers = markerRows.map((r) => {
    const baseline = baselines.get(deltaKey("marker_value", r.tracked_marker_id ?? null));
    const delta = r.fact_id ? deltaForCurrentFact(r.value, r.unit, baseline) : deltaForAbsentField(baseline);
    return fieldObject(r, "marker_value", conflicts, delta, outsideRefs);
  });
  const currentTreatment = buildSingleKeyBlock(treatmentRows, "treatment_regimen", baselines, conflicts, outsideRefs);
  const radiology = buildSingleKeyBlock(radiologyRows, "radiology_impression", baselines, conflicts, outsideRefs);

  const pins = await loadPins(patientId, tumorMarkers, baselines);

  const sinceLastVisit = [...currentTreatment, ...tumorMarkers, ...radiology].filter(
    (entry) => entry.delta_status !== null && entry.delta_status !== "unchanged",
  );

  return Response.json({
    patient: {
      id: patient.id,
      name: patient.name,
      cancer_type: patient.cancer_type,
      mrn: patient.mrn,
      sex: patient.sex,
      patient_origin: patient.patient_origin,
      stage: patient.stage,
      referring_physician: patient.referring_physician,
      date_of_birth: patient.date_of_birth,
      diagnosis_date: patient.diagnosis_date,
    },
    current_visit: { id: currentVisit.id, visit_date: currentVisit.visit_date },
    previous_visit: previousVisit
      ? { id: previousVisit.id, visit_date: previousVisit.visit_date }
      : { id: null, visit_date: null },
    current_treatment: currentTreatment,
    tumor_markers: tumorMarkers,
    radiology,
    since_last_visit: sinceLastVisit,
    compare: {
      mode: compare,
      last_here: previousVisit ? { date: previousVisit.visit_date as string } : null,
      latest_any: latestAny ? { facility: latestAny.facility as string, date: latestAny.date as string } : null,
    },
    ...pins,
  });
}

// For the Snapshot's per-marker trend chart (M6): every oncologist_signed_off fact for this
// tracked marker across the patient's FULL history (not scoped to one visit), ordered by
// as_of_date ascending. Only a signed-off value is trustworthy enough to plot — unverified/
// staff_corrected facts are excluded, as is a fact that lost an authoritative-pick conflict
// resolution (via the shared LIVE_FACT_FILTER, reused rather than reimplemented).
export async function getMarkerTrend(
  req: Request & { params: { id: string; trackedMarkerId: string } },
): Promise<Response> {
  const patientId = req.params.id;
  const trackedMarkerId = req.params.trackedMarkerId;
  if (!isUuid(patientId) || !isUuid(trackedMarkerId)) return jsonError(404, "not_found", "Marker not found.");

  const [marker] = await sql`
    SELECT marker_name FROM tracked_markers WHERE id = ${trackedMarkerId} AND patient_id = ${patientId}
  `;
  if (!marker) return jsonError(404, "not_found", "Marker not found.");

  const points = await sql`
    SELECT f.id AS fact_id, f.value, f.unit, f.reference_range, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.visit_id
    FROM facts f
    WHERE f.tracked_marker_id = ${trackedMarkerId} AND f.verification_state = 'oncologist_signed_off'
      AND ${LIVE_FACT_FILTER}
    ORDER BY f.as_of_date ASC
  `;

  return Response.json({ marker_name: marker.marker_name, points });
}

interface TimelineMarkerRow {
  tracked_marker_id: string;
  marker_name: string;
  fact_id: string;
  value: string;
  unit: string | null;
  as_of_date: string;
  visit_id: string;
  document_id: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
}

// Full patient history (every visit), not scoped to the current visit like Snapshot --
// this is where cross-block correlation actually pays off (m3-backlog #2 design spec).
// Undated facts are excluded: a chronological axis has nowhere to put them.
//
// field_type = 'marker_value' is required: a tracked marker also carries reference_range
// facts (services/facts.ts persists both for the same tracked_marker_id), which are
// lab-reported ranges, not measured values, and must never be plotted as a marker point
// (final-review finding -- Snapshot's own loadTumorMarkers filters the same way).
async function loadTimelineMarkers(patientId: string): Promise<TimelineMarkerRow[]> {
  return sql`
    SELECT tm.id AS tracked_marker_id, tm.marker_name,
           f.id AS fact_id, f.value, f.unit, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.visit_id,
           f.document_id, f.source_page, f.source_location, f.source_snippet
    FROM tracked_markers tm
    JOIN facts f ON f.tracked_marker_id = tm.id
    WHERE tm.patient_id = ${patientId}
      AND f.field_type = 'marker_value'
      AND f.verification_state = 'oncologist_signed_off'
      AND f.as_of_date IS NOT NULL
      AND ${LIVE_FACT_FILTER}
    ORDER BY tm.added_at ASC, f.as_of_date ASC
  `;
}

// Map rather than GROUP BY: insertion order (first row seen per marker) already follows
// tm.added_at ASC from the query above, which Map.values() preserves.
//
// Provenance fields flat on each point (not nested), same as timelineEventObject below --
// marker points click through to Source view too (final-review finding; the spec's own
// Provenance bullet says "every event (marker point, treatment change, radiology
// impression)" links through).
function groupTimelineMarkers(rows: TimelineMarkerRow[]) {
  const byMarker = new Map<
    string,
    {
      tracked_marker_id: string;
      marker_name: string;
      points: {
        fact_id: string; value: string; unit: string | null; as_of_date: string; visit_id: string;
        document_id: string; source_page: number | null; source_location: string | null;
        source_snippet: string | null; fallback_level: "exact" | "page" | "document";
      }[];
    }
  >();
  for (const r of rows) {
    let entry = byMarker.get(r.tracked_marker_id);
    if (!entry) {
      entry = { tracked_marker_id: r.tracked_marker_id, marker_name: r.marker_name, points: [] };
      byMarker.set(r.tracked_marker_id, entry);
    }
    const p = provenanceFor(r.document_id, r.source_page, r.source_location, r.source_snippet);
    entry.points.push({
      fact_id: r.fact_id, value: r.value, unit: r.unit, as_of_date: r.as_of_date, visit_id: r.visit_id,
      document_id: p.document_id, source_page: p.source_page, source_location: p.source_location,
      source_snippet: p.source_snippet, fallback_level: p.fallback_level,
    });
  }
  return [...byMarker.values()];
}

interface TimelineEventRow {
  fact_id: string;
  value: string | null;
  as_of_date: string;
  visit_id: string;
  document_id: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
}

// Same signed-off + LIVE_FACT_FILTER + full-history rules as loadTimelineMarkers, for
// treatment_regimen/radiology_impression instead of marker_value.
async function loadTimelineEvents(
  patientId: string,
  fieldType: "treatment_regimen" | "radiology_impression",
): Promise<TimelineEventRow[]> {
  return sql`
    SELECT f.id AS fact_id, f.value, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.visit_id,
           f.document_id, f.source_page, f.source_location, f.source_snippet
    FROM facts f
    WHERE f.patient_id = ${patientId} AND f.field_type = ${fieldType}
      AND f.verification_state = 'oncologist_signed_off'
      AND f.as_of_date IS NOT NULL
      AND ${LIVE_FACT_FILTER}
    ORDER BY f.as_of_date ASC
  `;
}

// Provenance fields flat on the entry (not nested under a `provenance` key like Snapshot) --
// the frontend tick-tooltip click-through needs document_id/fact_id directly.
function timelineEventObject(r: TimelineEventRow) {
  const p = provenanceFor(r.document_id, r.source_page, r.source_location, r.source_snippet);
  return {
    fact_id: r.fact_id,
    value: r.value,
    as_of_date: r.as_of_date,
    visit_id: r.visit_id,
    document_id: p.document_id,
    source_page: p.source_page,
    source_location: p.source_location,
    source_snippet: p.source_snippet,
    fallback_level: p.fallback_level,
  };
}

export async function getPatientTimeline(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;
  if (!isUuid(patientId)) return jsonError(404, "not_found", "Patient not found.");

  const [patient] = await sql`SELECT id, name, cancer_type FROM patients WHERE id = ${patientId}`;
  if (!patient) return jsonError(404, "not_found", "Patient not found.");

  const [markerRows, treatmentRows, radiologyRows] = await Promise.all([
    loadTimelineMarkers(patientId),
    loadTimelineEvents(patientId, "treatment_regimen"),
    loadTimelineEvents(patientId, "radiology_impression"),
  ]);

  return Response.json({
    patient: { id: patient.id, name: patient.name, cancer_type: patient.cancer_type },
    markers: groupTimelineMarkers(markerRows),
    treatment: treatmentRows.map(timelineEventObject),
    radiology: radiologyRows.map(timelineEventObject),
  });
}

interface SummaryRow {
  fact_id: string;
  document_id: string;
  document_type: string;
  field_type: string;
  value: string;
  as_of_date: string | null;
  facility: string | null;
  verification_state: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
  oe_id: string | null;
  oe_facility: string | null;
  oe_date: string | null;
}

function summaryItem(r: SummaryRow) {
  return {
    outside_encounter: r.oe_id ? { id: r.oe_id, facility: r.oe_facility as string, date: r.oe_date as string } : null,
    fact_id: r.fact_id,
    document_id: r.document_id,
    text: r.value,
    as_of_date: r.as_of_date,
    facility: r.facility,
    verification_state: r.verification_state,
    provenance: provenanceFor(r.document_id, r.source_page, r.source_location, r.source_snippet),
  };
}

type SummaryItem = ReturnType<typeof summaryItem>;

const WHAT_HAPPENED_TYPES = [
  "diagnosis", "histology_ihc", "stage", "surgery_procedure", "treatment_regimen", "radiology_impression",
];

// Patient Summary (M3-02): every line is one live fact quoted verbatim (facts.value), grouped
// only by field_type / document. Nothing is generated, merged or computed (AM-04/AM-06): no
// line of therapy, response or cycle count. Null-valued facts are skipped; held/rejected-
// identity and lost-conflict facts never appear (LIVE_FACT_FILTER).
export async function getPatientSummary(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;
  if (!isUuid(patientId)) return jsonError(404, "not_found", "Patient not found.");

  const [patient] = await sql`SELECT id, name FROM patients WHERE id = ${patientId}`;
  if (!patient) return jsonError(404, "not_found", "Patient not found.");

  // Documents that contribute at least one live fact (matches the "compiled from N documents" heading).
  const [{ n }] = await sql`
    SELECT count(DISTINCT f.document_id)::int AS n FROM facts f
    WHERE f.patient_id = ${patientId} AND f.value IS NOT NULL AND ${LIVE_FACT_FILTER}
  `;

  const rows: SummaryRow[] = await sql`
    SELECT f.id AS fact_id, f.document_id, d.document_type, f.field_type, f.value,
           to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.facility, f.verification_state,
           f.source_page, f.source_location, f.source_snippet,
           oe.id AS oe_id, oe.facility AS oe_facility, to_char(oe.encounter_date, 'YYYY-MM-DD') AS oe_date
    FROM facts f
    JOIN documents d ON d.id = f.document_id
    LEFT JOIN outside_encounters oe ON oe.id = f.outside_encounter_id
    WHERE f.patient_id = ${patientId} AND f.value IS NOT NULL
      AND f.field_type IN ('diagnosis', 'histology_ihc', 'stage', 'surgery_procedure', 'treatment_regimen',
                           'radiology_impression', 'tests_advised', 'next_review_date')
      AND ${LIVE_FACT_FILTER}
    ORDER BY f.as_of_date ASC NULLS LAST, f.id ASC
  `;

  const ofType = (t: string) => rows.filter((r) => r.field_type === t).map(summaryItem);

  const byDocument = new Map<string, SummaryRow[]>();
  for (const r of rows) {
    if (r.document_type !== "prescription") continue;
    const list = byDocument.get(r.document_id) ?? [];
    list.push(r);
    byDocument.set(r.document_id, list);
  }
  const prescriptions = [...byDocument.entries()]
    .map(([document_id, facts]) => {
      const pick = (t: string): SummaryItem[] => facts.filter((f) => f.field_type === t).map(summaryItem);
      // next_review_date is excluded: it may be a future review date, not when the prescription was written.
      const dates = facts
        .filter((f) => f.field_type === "treatment_regimen" || f.field_type === "tests_advised")
        .map((f) => f.as_of_date)
        .filter((d): d is string => d !== null);
      return {
        document_id,
        date: dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null,
        regimens: pick("treatment_regimen"),
        tests_advised: pick("tests_advised"),
        next_reviews: pick("next_review_date"),
      };
    })
    .sort((a, b) => (a.date === b.date ? 0 : a.date === null ? 1 : b.date === null ? -1 : a.date < b.date ? 1 : -1));

  return Response.json({
    patient: { id: patient.id, name: patient.name },
    documents_count: n,
    what_happened: rows.filter((r) => r.as_of_date !== null && WHAT_HAPPENED_TYPES.includes(r.field_type)).map(summaryItem),
    disease_history: {
      diagnosis: ofType("diagnosis"),
      histology_ihc: ofType("histology_ihc"),
      stage: ofType("stage"),
    },
    procedures: ofType("surgery_procedure"),
    prescriptions,
  });
}
