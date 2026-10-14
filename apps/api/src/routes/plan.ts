import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { LIVE_FACT_FILTER, isHeldIdentityStatus } from "../services/delta";
import { outsideRefOf } from "../services/provenance";
import { loadCandidateDocuments } from "../services/carePlan";
import { planItemStatus, type PlanItemType } from "../services/carePlanLogic";

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
  i.matched_document_id, i.match_confirmed_at, f.document_id AS source_document_id,
  oe.id AS oe_id, oe.facility AS oe_facility, to_char(oe.encounter_date, 'YYYY-MM-DD') AS oe_date,
  i.report_requested_by, i.report_requested_at, ru.name AS report_requested_by_name
`;

export async function getPatientPlan(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;
  if (!isUuid(patientId)) return jsonError(404, "not_found", "Patient not found.");
  const [patient] = await sql`SELECT id FROM patients WHERE id = ${patientId}`;
  if (!patient) return jsonError(404, "not_found", "Patient not found.");

  const rows = await sql`
    SELECT ${ITEM_COLUMNS} FROM care_plan_items i
    LEFT JOIN facts f ON f.id = i.source_fact_id
    LEFT JOIN outside_encounters oe ON oe.id = f.outside_encounter_id
    LEFT JOIN users ru ON ru.id = i.report_requested_by
    WHERE i.patient_id = ${patientId}
      AND (i.source_fact_id IS NULL OR (f.verification_state = 'oncologist_signed_off' AND ${LIVE_FACT_FILTER}))
    ORDER BY i.advised_at DESC, i.created_at DESC, i.id
  `;
  const candidates = await loadCandidateDocuments(patientId);
  const today = new Date().toISOString().slice(0, 10);

  const items = rows.map((r: any) => {
    const { stated, approx, matched, suggested, status } = planItemStatus(r, candidates, today);
    return {
      id: r.id as string,
      type: r.type as PlanItemType,
      text: r.text as string,
      advised_at: r.advised_at as string,
      approx_date: approx,
      stated_date: stated,
      status,
      past_advised: status === "past_advised",
      matched_document: matched ? { id: matched.id, label: matched.label } : null,
      suggested_document: suggested ? { id: suggested.id, label: suggested.label } : null,
      source_fact_id: (r.source_fact_id as string | null) ?? null,
      source_document_id: (r.source_document_id as string | null) ?? null,
      outside_encounter: outsideRefOf(r),
      report_request: r.report_requested_by
        ? { by_id: r.report_requested_by as string, by_name: (r.report_requested_by_name as string | null) ?? null, at: new Date(r.report_requested_at).toISOString() }
        : null,
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
    SELECT id, identity_status, document_type FROM documents WHERE id = ${documentId} AND patient_id = ${item.patient_id}
  `;
  if (!doc) return jsonError(400, "bad_request", "document_id does not belong to this patient.");
  if (doc.document_type === "other") return jsonError(400, "bad_request", "An 'Other' document cannot be matched to a plan item.");
  if (isHeldIdentityStatus(doc.identity_status)) {
    return jsonError(409, "conflict", "This document is held for an identity check and cannot be matched.");
  }
  await sql`
    UPDATE care_plan_items
    SET matched_document_id = ${documentId}, match_confirmed_by = ${user.id}, match_confirmed_at = now()
    WHERE id = ${itemId}
  `;
  return Response.json({ id: itemId, matched_document_id: documentId });
}

// M3-09 interim for B7: the oncologist asks staff to find the report for a plan item; staff clear the request.
// Only an item with no report yet (planned or past advised date) can be asked for.
async function withPlanItem(
  req: Request & { params: { id: string } },
  change: (tx: typeof sql, item: any) => Promise<Response>,
): Promise<Response> {
  const itemId = req.params.id;
  if (!isUuid(itemId)) return jsonError(404, "not_found", "Plan item not found.");
  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as typeof sql;
    const [item] = await tx`SELECT *, to_char(advised_at, 'YYYY-MM-DD') AS advised_text FROM care_plan_items WHERE id = ${itemId} FOR UPDATE`;
    if (!item) return jsonError(404, "not_found", "Plan item not found.");
    return change(tx, item);
  });
}

const requestState = (i: any) => ({ report_requested_by: i.report_requested_by, report_requested_at: i.report_requested_at });

export async function requestPlanItemReport(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  return withPlanItem(req, async (tx, item) => {
    const itemRow = { ...item, advised_at: item.advised_text as string };
    const candidates = await loadCandidateDocuments(item.patient_id);
    const { status } = planItemStatus(itemRow, candidates, new Date().toISOString().slice(0, 10));
    if (status !== "planned" && status !== "past_advised") {
      return jsonError(409, "conflict", "A report has already been found for this item.");
    }
    const [after] = await tx`
      UPDATE care_plan_items SET report_requested_by = ${user.id}, report_requested_at = now() WHERE id = ${item.id}
      RETURNING report_requested_by, report_requested_at
    `;
    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, 'request_report', 'care_plan_item', ${item.id}, ${JSON.stringify(requestState(item))}::jsonb, ${JSON.stringify(requestState(after))}::jsonb)
    `;
    return Response.json({ id: item.id, requested: true });
  });
}

export async function clearPlanItemReportRequest(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  return withPlanItem(req, async (tx, item) => {
    if (!item.report_requested_by) return Response.json({ id: item.id, requested: false });
    await tx`UPDATE care_plan_items SET report_requested_by = NULL, report_requested_at = NULL WHERE id = ${item.id}`;
    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, 'clear_report_request', 'care_plan_item', ${item.id}, ${JSON.stringify(requestState(item))}::jsonb, ${JSON.stringify({ report_requested_by: null, report_requested_at: null })}::jsonb)
    `;
    return Response.json({ id: item.id, requested: false });
  });
}
