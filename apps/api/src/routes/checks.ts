import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import { isUuid } from "../services/corrections";
import type { CheckErrorType } from "../services/factChecks";

const ERROR_TYPE_KEYS: readonly CheckErrorType[] = ["value", "unit", "marker", "date", "range", "not_in_document", "wrong_patient"];

function emptyErrors(): Record<CheckErrorType, number> {
  return Object.fromEntries(ERROR_TYPE_KEYS.map((k) => [k, 0])) as Record<CheckErrorType, number>;
}

// Backfilled marks (checked_by IS NULL) were not spot-checked, so they never count toward agreement.
function agreement(spotCorrect: number, spotIncorrect: number): number | null {
  const n = spotCorrect + spotIncorrect;
  return n === 0 ? null : spotCorrect / n;
}

export async function getDocumentCheckSummary(req: Request & { params: { id: string } }): Promise<Response> {
  const documentId = req.params.id;
  if (!isUuid(documentId)) return jsonError(404, "not_found", "Document not found.");
  const [doc] = await sql`SELECT id, lab_name, identity_status FROM documents WHERE id = ${documentId}`;
  if (!doc) return jsonError(404, "not_found", "Document not found.");
  if (doc.identity_status === "mismatch" || doc.identity_status === "rejected") {
    return jsonError(409, "conflict", "This document is held or rejected; it has no check summary.");
  }

  const [t] = await sql`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE check_state = 'correct')::int AS correct,
           count(*) FILTER (WHERE check_state = 'incorrect')::int AS incorrect,
           count(*) FILTER (WHERE check_state = 'unchecked')::int AS unchecked,
           count(*) FILTER (WHERE check_state = 'correct' AND checked_by IS NOT NULL)::int AS spot_correct,
           count(*) FILTER (WHERE check_state = 'incorrect' AND checked_by IS NOT NULL)::int AS spot_incorrect
    FROM facts WHERE document_id = ${documentId}`;
  const errorRows = await sql`
    SELECT error_type, count(*)::int AS n FROM facts
    WHERE document_id = ${documentId} AND check_state = 'incorrect' AND error_type IS NOT NULL GROUP BY error_type`;
  const errors = emptyErrors();
  for (const r of errorRows) if (r.error_type in errors) errors[r.error_type as CheckErrorType] = r.n;

  const byRows = await sql`
    SELECT f.checked_by AS user_id, COALESCE(u.name, 'backfilled') AS name, count(*)::int AS count
    FROM facts f LEFT JOIN users u ON u.id = f.checked_by
    WHERE f.document_id = ${documentId} AND f.check_state <> 'unchecked'
    GROUP BY f.checked_by, u.name ORDER BY count(*) DESC, u.name`;

  return Response.json({
    document_id: documentId,
    lab_name: doc.lab_name ?? null,
    total: t.total,
    checked: t.correct + t.incorrect,
    correct: t.correct,
    incorrect: t.incorrect,
    unchecked: t.unchecked,
    agreement: agreement(t.spot_correct, t.spot_incorrect),
    errors_by_type: errors,
    checked_by: byRows.map((r: any) => ({ user_id: r.user_id ?? null, name: r.name, count: r.count })),
  });
}

export async function getLabCheckSummary(_req: Request): Promise<Response> {
  const rows = await sql`
    SELECT COALESCE(d.lab_name, 'unknown') AS lab_name,
           count(DISTINCT d.id)::int AS documents,
           count(*) FILTER (WHERE f.check_state IN ('correct', 'incorrect'))::int AS checked,
           count(*) FILTER (WHERE f.check_state = 'correct')::int AS correct,
           count(*) FILTER (WHERE f.check_state = 'incorrect')::int AS incorrect,
           count(*) FILTER (WHERE f.check_state = 'correct' AND f.checked_by IS NOT NULL)::int AS spot_correct,
           count(*) FILTER (WHERE f.check_state = 'incorrect' AND f.checked_by IS NOT NULL)::int AS spot_incorrect
    FROM documents d LEFT JOIN facts f ON f.document_id = d.id
    WHERE d.identity_status IS DISTINCT FROM 'mismatch' AND d.identity_status IS DISTINCT FROM 'rejected'
    GROUP BY COALESCE(d.lab_name, 'unknown')
    ORDER BY lab_name`;
  const errorRows = await sql`
    SELECT COALESCE(d.lab_name, 'unknown') AS lab_name, f.error_type, count(*)::int AS n
    FROM facts f JOIN documents d ON d.id = f.document_id
    WHERE f.check_state = 'incorrect' AND f.error_type IS NOT NULL
      AND d.identity_status IS DISTINCT FROM 'mismatch' AND d.identity_status IS DISTINCT FROM 'rejected'
    GROUP BY 1, 2`;
  const errs = new Map<string, Record<CheckErrorType, number>>();
  for (const r of errorRows) {
    const e = errs.get(r.lab_name) ?? emptyErrors();
    if (r.error_type in e) e[r.error_type as CheckErrorType] = r.n;
    errs.set(r.lab_name, e);
  }
  return Response.json(rows.map((r: any) => ({
    lab_name: r.lab_name,
    documents: r.documents,
    checked: r.checked,
    correct: r.correct,
    incorrect: r.incorrect,
    agreement: agreement(r.spot_correct, r.spot_incorrect),
    errors_by_type: errs.get(r.lab_name) ?? emptyErrors(),
  })));
}
