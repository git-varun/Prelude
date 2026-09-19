import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { isControlledMarker } from "../services/markers";

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
