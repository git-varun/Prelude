import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { isControlledMarker } from "@opd/shared";

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
