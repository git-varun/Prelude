import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

async function factWithProvenance(id: string) {
  const [row] = await sql`
    SELECT f.id, f.patient_id, f.visit_id, f.document_id, f.tracked_marker_id, tm.marker_name AS tracked_marker_name,
           f.field_type, f.value, f.unit, f.reference_range, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date,
           f.coverage_status, f.verification_state, f.source_page, f.source_location, f.source_snippet
    FROM facts f
    LEFT JOIN tracked_markers tm ON tm.id = f.tracked_marker_id
    WHERE f.id = ${id}
  `;
  return row;
}

export async function getConflict(req: Request & { params: { id: string } }, _user: AuthedUser): Promise<Response> {
  const conflictId = req.params.id;
  if (!isUuid(conflictId)) return jsonError(404, "not_found", "Conflict not found.");

  const [conflict] = await sql`SELECT * FROM conflicts WHERE id = ${conflictId}`;
  if (!conflict) return jsonError(404, "not_found", "Conflict not found.");

  const [factA, factB] = await Promise.all([factWithProvenance(conflict.fact_id_a), factWithProvenance(conflict.fact_id_b)]);
  return Response.json({ conflict, fact_a: factA, fact_b: factB });
}

export async function annotateConflict(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const conflictId = req.params.id;
  if (!isUuid(conflictId)) return jsonError(404, "not_found", "Conflict not found.");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }
  const { annotation_note: annotationNote } = body;
  if (typeof annotationNote !== "string" || annotationNote.trim() === "") {
    return jsonError(400, "bad_request", "annotation_note must be a non-empty string.");
  }

  const outcome = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM conflicts WHERE id = ${conflictId} FOR UPDATE`;
    if (!before) return "not_found" as const;
    if (before.status !== "open") return "not_open" as const;

    const [updated] = await tx`
      UPDATE conflicts SET status = 'annotated', annotation_note = ${annotationNote.trim()}
      WHERE id = ${conflictId}
      RETURNING *
    `;
    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, 'annotate_conflict', 'conflict', ${conflictId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
    `;
    return "ok" as const;
  });

  if (outcome === "not_found") return jsonError(404, "not_found", "Conflict not found.");
  if (outcome === "not_open") return jsonError(409, "conflict", "Only an open conflict can be annotated.");

  const [conflict] = await sql`SELECT * FROM conflicts WHERE id = ${conflictId}`;
  return Response.json(conflict);
}

export async function resolveConflict(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const conflictId = req.params.id;
  if (!isUuid(conflictId)) return jsonError(404, "not_found", "Conflict not found.");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }
  const { authoritative_fact_id: authoritativeFactId, both_stand: bothStand } = body;
  if (bothStand !== true && !isUuid(authoritativeFactId)) {
    return jsonError(400, "bad_request", "Provide either authoritative_fact_id or both_stand: true.");
  }
  if (bothStand === true && authoritativeFactId !== undefined) {
    return jsonError(400, "bad_request", "Provide either authoritative_fact_id or both_stand, not both.");
  }

  const outcome = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM conflicts WHERE id = ${conflictId} FOR UPDATE`;
    if (!before) return "not_found" as const;
    if (before.status === "resolved") return "already_resolved" as const;

    let winnerId: string | null = null;
    if (!bothStand) {
      if (authoritativeFactId !== before.fact_id_a && authoritativeFactId !== before.fact_id_b) {
        return "bad_fact" as const;
      }
      winnerId = authoritativeFactId as string;
    }

    const resolutionNote = bothStand ? "Both values stand as independently valid." : `Fact ${winnerId} marked authoritative.`;

    const [updated] = await tx`
      UPDATE conflicts SET
        status = 'resolved', authoritative_fact_id = ${winnerId}, resolution_note = ${resolutionNote},
        resolved_by = ${user.id}, resolved_at = now()
      WHERE id = ${conflictId}
      RETURNING *
    `;

    if (bothStand) {
      await tx`UPDATE facts SET coverage_status = 'value_found' WHERE id = ${before.fact_id_a} OR id = ${before.fact_id_b}`;
    } else {
      await tx`UPDATE facts SET coverage_status = 'value_found' WHERE id = ${winnerId}`;
    }

    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, 'resolve_conflict', 'conflict', ${conflictId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
    `;
    return "ok" as const;
  });

  if (outcome === "not_found") return jsonError(404, "not_found", "Conflict not found.");
  if (outcome === "already_resolved") return jsonError(409, "conflict", "This conflict is already resolved.");
  if (outcome === "bad_fact") return jsonError(400, "bad_request", "authoritative_fact_id must be one of this conflict's two facts.");

  const [conflict] = await sql`SELECT * FROM conflicts WHERE id = ${conflictId}`;
  return Response.json(conflict);
}
