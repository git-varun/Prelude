import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

type Exec = typeof sql;

// Explicit column list (not f.*) so as_of_date is a YYYY-MM-DD string, never a JS Date.
async function queryFacts(exec: Exec, filter: { documentId?: string; factId?: string }) {
  return exec`
    SELECT f.id, f.patient_id, f.visit_id, f.document_id, f.tracked_marker_id,
           tm.marker_name AS tracked_marker_name, f.raw_marker_label, f.field_type, f.value, f.unit,
           f.reference_range, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.needs_manual_date,
           f.coverage_status, f.verification_state, f.source_page, f.source_location, f.source_snippet
    FROM facts f
    LEFT JOIN tracked_markers tm ON tm.id = f.tracked_marker_id
    WHERE (${filter.documentId ?? null}::uuid IS NULL OR f.document_id = ${filter.documentId ?? null}::uuid)
      AND (${filter.factId ?? null}::uuid IS NULL OR f.id = ${filter.factId ?? null}::uuid)
    ORDER BY f.source_page NULLS LAST, tm.marker_name NULLS LAST, f.field_type, f.id
  `;
}

export async function getDocumentFacts(req: Request & { params: { id: string } }): Promise<Response> {
  const documentId = req.params.id;
  if (!isUuid(documentId)) return jsonError(404, "not_found", "Document not found.");

  const [document] = await sql`SELECT * FROM documents WHERE id = ${documentId}`;
  if (!document) return jsonError(404, "not_found", "Document not found.");

  const facts = await queryFacts(sql, { documentId });
  const trackedMarkers = await sql`
    SELECT id, marker_name, is_custom, added_at, added_by FROM tracked_markers
    WHERE patient_id = ${document.patient_id} ORDER BY added_at ASC
  `;
  return Response.json({ document, facts, tracked_markers: trackedMarkers });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && !s.startsWith("0000");
}

export async function patchFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }
  if (typeof body !== "object" || body === null) return jsonError(400, "bad_request", "Expected a JSON object.");

  const { value, tracked_marker_id: markerId, as_of_date: asOfDate } = body;
  if (value === undefined && markerId === undefined && asOfDate === undefined) {
    return jsonError(400, "bad_request", "Provide at least one of value, tracked_marker_id, as_of_date.");
  }
  if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
    return jsonError(400, "bad_request", "value must be a non-empty string.");
  }
  if (markerId !== undefined && !isUuid(markerId)) {
    return jsonError(400, "bad_request", "tracked_marker_id must be a UUID.");
  }
  if (asOfDate !== undefined && (typeof asOfDate !== "string" || !isRealDate(asOfDate))) {
    return jsonError(400, "bad_request", "as_of_date must be a real date in YYYY-MM-DD format.");
  }

  const newValue = typeof value === "string" ? value.trim() : null;
  const newMarkerId = typeof markerId === "string" ? markerId : null;
  const newDate = typeof asOfDate === "string" ? asOfDate : null;

  const outcome = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
    if (!before) return "not_found" as const;
    if (before.verification_state === "oncologist_signed_off") return "signed_off" as const;

    if (newMarkerId) {
      const [marker] = await tx`SELECT id FROM tracked_markers WHERE id = ${newMarkerId} AND patient_id = ${before.patient_id}`;
      if (!marker) return "bad_marker" as const;
    }

    // Serialize PATCHes per document so the needs_manual_date recompute sees committed siblings.
    await tx`SELECT 1 FROM documents WHERE id = ${before.document_id} FOR UPDATE`;

    const [updated] = await tx`
      UPDATE facts SET
        value = COALESCE(${newValue}::text, value),
        tracked_marker_id = COALESCE(${newMarkerId}::uuid, tracked_marker_id),
        raw_marker_label = CASE WHEN ${newMarkerId}::uuid IS NOT NULL THEN NULL ELSE raw_marker_label END,
        as_of_date = COALESCE(${newDate}::date, as_of_date),
        needs_manual_date = CASE WHEN ${newDate}::date IS NOT NULL THEN false ELSE needs_manual_date END,
        coverage_status = CASE WHEN ${newValue}::text IS NOT NULL AND coverage_status = 'extraction_uncertain'
                               THEN 'value_found'::coverage_status ELSE coverage_status END,
        verification_state = 'staff_corrected',
        corrected_by = ${user.id}
      WHERE id = ${factId}
      RETURNING *
    `;

    await tx`
      UPDATE documents SET needs_manual_date =
        EXISTS (SELECT 1 FROM facts WHERE document_id = ${before.document_id} AND needs_manual_date)
      WHERE id = ${before.document_id}
    `;
    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, 'correct', 'fact', ${factId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
    `;
    return "ok" as const;
  });

  if (outcome === "not_found") return jsonError(404, "not_found", "Fact not found.");
  if (outcome === "signed_off") {
    return jsonError(409, "conflict", "This fact is oncologist signed-off; it must be reopened before it can be corrected.");
  }
  if (outcome === "bad_marker") return jsonError(400, "bad_request", "tracked_marker_id does not belong to this fact's patient.");

  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}
