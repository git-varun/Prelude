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
