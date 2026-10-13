import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { loadCandidateDocuments } from "../services/carePlan";
import { approximateDate, derivePlanStatus, suggestMatches, type PlanItemType } from "../services/carePlanLogic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
const PLAN_TYPES: readonly string[] = ["test", "procedure", "review"];

function isRealDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && !s.startsWith("0000");
}

const ITEM_COLUMNS = sql`
  i.id, i.type, i.text, to_char(i.advised_at, 'YYYY-MM-DD') AS advised_at, i.source_fact_id,
  i.matched_document_id, i.match_confirmed_at, f.document_id AS source_document_id
`;

export async function getPatientPlan(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;
  if (!isUuid(patientId)) return jsonError(404, "not_found", "Patient not found.");
  const [patient] = await sql`SELECT id FROM patients WHERE id = ${patientId}`;
  if (!patient) return jsonError(404, "not_found", "Patient not found.");

  const rows = await sql`
    SELECT ${ITEM_COLUMNS} FROM care_plan_items i
    LEFT JOIN facts f ON f.id = i.source_fact_id
    WHERE i.patient_id = ${patientId}
    ORDER BY i.advised_at DESC, i.created_at DESC, i.id
  `;
  const candidates = await loadCandidateDocuments(patientId);
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const today = new Date().toISOString().slice(0, 10);

  const items = rows.map((r: any) => {
    const approx = approximateDate(r.text, r.advised_at);
    // A confirmed match to a document that has since been held or rejected no longer counts.
    const matched = r.matched_document_id && r.match_confirmed_at ? byId.get(r.matched_document_id) ?? null : null;
    const suggested = matched ? null : suggestMatches({ type: r.type as PlanItemType, text: r.text, advised_at: r.advised_at }, candidates)[0] ?? null;
    const status = derivePlanStatus({
      advised_at: r.advised_at, approx_date: approx, hasConfirmedMatch: !!matched, hasSuggestion: !!suggested, today,
    });
    return {
      id: r.id as string,
      type: r.type as PlanItemType,
      text: r.text as string,
      advised_at: r.advised_at as string,
      approx_date: approx,
      status,
      past_advised: status === "past_advised",
      matched_document: matched ? { id: matched.id, label: matched.label } : null,
      suggested_document: suggested ? { id: suggested.id, label: suggested.label } : null,
      source_fact_id: (r.source_fact_id as string | null) ?? null,
      source_document_id: (r.source_document_id as string | null) ?? null,
    };
  });
  // The most recently advised review is "the next review".
  const next_review = items.find((i: { type: string }) => i.type === "review") ?? null;
  return Response.json({ next_review, items });
}

export async function addPlanItem(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const patientId = req.params.id;
  if (!isUuid(patientId)) return jsonError(404, "not_found", "Patient not found.");
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }
  if (typeof body !== "object" || body === null) return jsonError(400, "bad_request", "Expected a JSON object.");
  const { type, text, advised_at: advisedAt } = body;
  if (typeof type !== "string" || !PLAN_TYPES.includes(type)) {
    return jsonError(400, "bad_request", "type must be one of: test, procedure, review.");
  }
  if (typeof text !== "string" || text.trim() === "") return jsonError(400, "bad_request", "text must be a non-empty string.");
  if (!isRealDate(advisedAt)) return jsonError(400, "bad_request", "advised_at must be a real date in YYYY-MM-DD format.");

  const [patient] = await sql`SELECT id FROM patients WHERE id = ${patientId}`;
  if (!patient) return jsonError(404, "not_found", "Patient not found.");

  const [row] = await sql`
    INSERT INTO care_plan_items (patient_id, type, text, advised_at, created_by)
    VALUES (${patientId}, ${type}, ${text.trim()}, ${advisedAt}::date, ${user.id})
    RETURNING id
  `;
  return Response.json({ id: row.id }, { status: 201 });
}

// Staff confirm (document_id) or remove (null) a suggested report match. Never automatic.
export async function setPlanItemMatch(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const itemId = req.params.id;
  if (!isUuid(itemId)) return jsonError(404, "not_found", "Plan item not found.");
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }
  const documentId = body?.document_id;
  if (documentId !== null && !isUuid(documentId)) return jsonError(400, "bad_request", "document_id must be a UUID or null.");

  const [item] = await sql`SELECT id, patient_id FROM care_plan_items WHERE id = ${itemId}`;
  if (!item) return jsonError(404, "not_found", "Plan item not found.");

  if (documentId === null) {
    await sql`
      UPDATE care_plan_items SET matched_document_id = NULL, match_confirmed_by = NULL, match_confirmed_at = NULL
      WHERE id = ${itemId}
    `;
    return Response.json({ id: itemId, matched_document_id: null });
  }

  const [doc] = await sql`
    SELECT id, identity_status FROM documents WHERE id = ${documentId} AND patient_id = ${item.patient_id}
  `;
  if (!doc) return jsonError(400, "bad_request", "document_id does not belong to this patient.");
  if (doc.identity_status === "mismatch" || doc.identity_status === "rejected") {
    return jsonError(409, "conflict", "This document is held for an identity check and cannot be matched.");
  }
  await sql`
    UPDATE care_plan_items
    SET matched_document_id = ${documentId}, match_confirmed_by = ${user.id}, match_confirmed_at = now()
    WHERE id = ${itemId}
  `;
  return Response.json({ id: itemId, matched_document_id: documentId });
}
