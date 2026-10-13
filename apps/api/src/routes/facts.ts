import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { applyCorrection, isUuid, parseCorrection } from "../services/corrections";
import { provenanceFor } from "../services/provenance";
import {
  MAX_BATCH, SIGN_OFF_REASONS, reopenOne, signOffBatch, signOffOne, undoSignOffBatch, type BatchResult,
} from "../services/signOff";
import { CONFLICT_SIDES_LIVE } from "../services/delta";
import { checkFact, parseCheck, resetCheck } from "../services/factChecks";

type Exec = typeof sql;

// Explicit column list (not f.*) so as_of_date is a YYYY-MM-DD string, never a JS Date.
async function queryFacts(exec: Exec, filter: { documentId?: string; factId?: string }) {
  const rows = await exec`
    SELECT f.id, f.patient_id, f.visit_id, f.document_id, f.tracked_marker_id,
           tm.marker_name AS tracked_marker_name, f.raw_marker_label, f.field_type, f.value, f.unit,
           f.reference_range, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.needs_manual_date,
           f.coverage_status, f.verification_state, f.source_page, f.source_location, f.source_snippet,
           f.check_state, f.checked_by, f.checked_at, f.error_type, f.excluded_at, f.printed_flag, f.parse_checks,
           EXISTS (
             SELECT 1 FROM conflicts c
             WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id) AND c.status IN ('open', 'annotated') AND ${CONFLICT_SIDES_LIVE}
           ) AS has_blocking_conflict,
           (
             SELECT c.id FROM conflicts c
             WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id) AND c.status IN ('open', 'annotated') AND ${CONFLICT_SIDES_LIVE}
             LIMIT 1
           ) AS blocking_conflict_id
    FROM facts f
    LEFT JOIN tracked_markers tm ON tm.id = f.tracked_marker_id
    WHERE (${filter.documentId ?? null}::uuid IS NULL OR f.document_id = ${filter.documentId ?? null}::uuid)
      AND (${filter.factId ?? null}::uuid IS NULL OR f.id = ${filter.factId ?? null}::uuid)
    ORDER BY f.source_page NULLS LAST, tm.marker_name NULLS LAST, f.field_type, f.id
  `;
  return rows.map((row: any) => ({
    ...row,
    fallback_level: provenanceFor(row.document_id, row.source_page, row.source_location, row.source_snippet).fallback_level,
  }));
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
  // Every fact of the document counts; an excluded fact is check_state 'incorrect'.
  const check_summary = { total: facts.length, correct: 0, incorrect: 0, unchecked: 0 };
  for (const f of facts as any[]) check_summary[f.check_state as "correct" | "incorrect" | "unchecked"]++;
  return Response.json({ document, facts, tracked_markers: trackedMarkers, check_summary });
}

export async function patchFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "bad_request", "Malformed JSON body."); }
  const parsed = parseCorrection(body);
  if (!parsed.ok) return jsonError(400, "bad_request", parsed.message);

  const result = await sql.begin(async (tx) => {
    // Lock the fact first (applyCorrection then locks the document), the same order as POST /facts/:id/check.
    const [row] = await tx`SELECT excluded_at FROM facts WHERE id = ${factId} FOR UPDATE`;
    if (!row) return { outcome: "not_found" as const };
    if (row.excluded_at !== null) return { outcome: "excluded" as const };
    const applied = await applyCorrection(tx, factId, parsed.correction, user.id);
    // An edit invalidates a spot-check mark: the reviewer checked the old values.
    if (applied.outcome === "ok") await resetCheck(tx, factId, user.id);
    return applied;
  });
  if (result.outcome === "not_found") return jsonError(404, "not_found", "Fact not found.");
  if (result.outcome === "excluded") {
    return jsonError(409, "conflict", "This fact was marked as not belonging to this document; change its check mark before editing it.");
  }
  if (result.outcome === "signed_off") {
    return jsonError(409, "conflict", "This fact is oncologist signed-off; it must be reopened before it can be corrected.");
  }
  if (result.outcome === "not_uncertain") {
    return jsonError(409, "conflict", "resolution applies only to facts whose coverage_status is extraction_uncertain.");
  }
  if (result.outcome === "bad_marker") return jsonError(400, "bad_request", "tracked_marker_id does not belong to this fact's patient.");
  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}

export async function checkFactRoute(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "bad_request", "Malformed JSON body."); }
  const parsed = parseCheck(body);
  if (!parsed.ok) return jsonError(400, "bad_request", parsed.message);

  const { outcome } = await sql.begin((tx) => checkFact(tx, factId, parsed.input, user.id));
  switch (outcome) {
    case "ok": break;
    case "not_found": return jsonError(404, "not_found", "Fact not found.");
    case "signed_off":
      return jsonError(409, "conflict", "This fact is oncologist signed-off; it must be reopened before its check mark can change.");
    case "held":
      return jsonError(409, "conflict", "This document is held for a patient identity mismatch; resolve the identity before checking its facts.");
    case "bad_error_type":
      return jsonError(400, "bad_request", "That error type does not apply to this kind of fact.");
    case "needs_value":
      return jsonError(409, "conflict", "A fact with no value cannot be marked correct; mark it incorrect with the value instead.");
    case "needs_date":
      return jsonError(409, "conflict", "A fact without an as-of date cannot be marked correct; supply the date first.");
    case "not_uncertain":
      return jsonError(409, "conflict", "resolution applies only to facts whose coverage_status is extraction_uncertain.");
    case "bad_marker":
      return jsonError(400, "bad_request", "tracked_marker_id does not belong to this fact's patient.");
  }
  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}

export async function signOffFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");

  const outcome = await sql.begin((tx) => signOffOne(tx, factId, user.id));
  if (outcome === "not_found") return jsonError(404, "not_found", SIGN_OFF_REASONS.not_found);
  if (outcome !== "ok") return jsonError(409, "conflict", SIGN_OFF_REASONS[outcome]);

  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}

async function parseBatch(req: Request): Promise<{ ids: string[] } | Response> {
  let body: any;
  try { body = await req.json(); } catch { return jsonError(400, "bad_request", "Malformed JSON body."); }
  const ids = body?.fact_ids;
  if (!Array.isArray(ids) || ids.length === 0) return jsonError(400, "bad_request", "fact_ids must be a non-empty array.");
  if (ids.length > MAX_BATCH) return jsonError(400, "bad_request", `At most ${MAX_BATCH} facts per batch.`);
  if (!ids.every(isUuid)) return jsonError(400, "bad_request", "fact_ids must be UUIDs.");
  return { ids };
}

function batchResponse(result: BatchResult): Response {
  if (result.ok) return Response.json({ count: result.count });
  if (result.kind === "mixed_patients") return jsonError(400, "bad_request", "A batch must contain facts of a single patient.");
  return Response.json(
    { error: { code: "conflict", message: "Some facts cannot be processed; nothing was changed." }, failures: result.failures },
    { status: 409 },
  );
}

/** POST /facts/sign-off-batch {fact_ids}: all-or-nothing, one audit row per fact. */
export async function signOffFactsBatch(req: Request, user: AuthedUser): Promise<Response> {
  const parsed = await parseBatch(req);
  if (parsed instanceof Response) return parsed;
  return batchResponse(await signOffBatch(sql, parsed.ids, user.id));
}

/** POST /facts/sign-off-batch/undo {fact_ids}: reopens the caller's own fresh sign-offs, one audit row per fact. */
export async function undoSignOffFactsBatch(req: Request, user: AuthedUser): Promise<Response> {
  const parsed = await parseBatch(req);
  if (parsed instanceof Response) return parsed;
  return batchResponse(await undoSignOffBatch(sql, parsed.ids, user.id));
}

export async function reopenFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");

  const outcome = await sql.begin((tx) => reopenOne(tx, factId, user.id));

  if (outcome === "not_found") return jsonError(404, "not_found", "Fact not found.");
  if (outcome === "not_signed_off") return jsonError(409, "conflict", "Only an oncologist signed-off fact can be reopened.");

  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}
