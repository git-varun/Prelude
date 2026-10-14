import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { LIVE_FACT_FILTER } from "../services/delta";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PrepKey = "uploaded" | "facts_checked" | "dates_entered" | "held_reviewed";
export interface PrepItem { key: PrepKey; label: string; ok: boolean; count: number }

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// M3-09: the four prep checks for one visit. Open conflicts are not a check: they do not block "ready".
// Held reports are a patient-level check (a held report may sit on any visit).
export async function loadPrepChecklist(tx: typeof sql, visitId: string, patientId: string): Promise<PrepItem[]> {
  const [row] = await tx`
    SELECT
      (SELECT count(*)::int FROM documents d
        WHERE d.visit_id = ${visitId} AND d.document_type != 'other' AND COALESCE(d.identity_status::text, '') != 'rejected') AS documents,
      (SELECT count(*)::int FROM facts f WHERE f.visit_id = ${visitId} AND ${LIVE_FACT_FILTER} AND f.check_state = 'unchecked') AS unchecked,
      (SELECT count(*)::int FROM facts f WHERE f.visit_id = ${visitId} AND ${LIVE_FACT_FILTER} AND f.needs_manual_date) AS undated,
      (SELECT count(*)::int FROM documents d WHERE d.patient_id = ${patientId} AND d.identity_status IN ('mismatch', 'awaiting_oncologist')) AS held
  `;
  return [
    { key: "uploaded", label: "Reports uploaded", ok: row.documents > 0, count: row.documents },
    { key: "facts_checked", label: "All facts checked", ok: row.unchecked === 0, count: row.unchecked },
    { key: "dates_entered", label: "Dates entered", ok: row.undated === 0, count: row.undated },
    { key: "held_reviewed", label: "Held reports reviewed", ok: row.held === 0, count: row.held },
  ];
}

export function prepItemReason(i: PrepItem): string {
  switch (i.key) {
    case "uploaded": return "No report uploaded for this visit yet";
    case "facts_checked": return `${plural(i.count, "fact is", "facts are")} not checked yet`;
    case "dates_entered": return `${plural(i.count, "fact needs", "facts need")} a date`;
    case "held_reviewed": return `${plural(i.count, "report is", "reports are")} still held for an identity check`;
  }
}

async function prepState(tx: typeof sql, visitId: string) {
  const [v] = await tx`
    SELECT v.id, v.patient_id, to_char(v.visit_date, 'YYYY-MM-DD') AS visit_date, v.prep_status, v.prep_set_by, v.prep_set_at,
           u.name AS prep_set_by_name
    FROM visits v LEFT JOIN users u ON u.id = v.prep_set_by WHERE v.id = ${visitId}
  `;
  const items = (await loadPrepChecklist(tx, v.id, v.patient_id)).map((i) => ({ ...i, reason: i.ok ? null : prepItemReason(i) }));
  return {
    visit_id: v.id as string,
    visit_date: v.visit_date as string,
    prep_status: v.prep_status as "preparing" | "ready",
    prep_set_by: (v.prep_set_by as string | null) ?? null,
    prep_set_by_name: (v.prep_set_by_name as string | null) ?? null,
    prep_set_at: v.prep_set_at ? new Date(v.prep_set_at).toISOString() : null,
    items,
    can_mark_ready: items.every((i) => i.ok),
    // Marked ready earlier, but something has changed since: shown, never flipped silently.
    changed_since_ready: v.prep_status === "ready" ? items.filter((i) => !i.ok).map((i) => i.key) : [],
  };
}

export async function getVisitPrep(req: Request & { params: { id: string } }): Promise<Response> {
  const id = req.params.id;
  if (!UUID.test(id)) return jsonError(404, "not_found", "Visit not found.");
  const [visit] = await sql`SELECT id FROM visits WHERE id = ${id}`;
  if (!visit) return jsonError(404, "not_found", "Visit not found.");
  return Response.json(await prepState(sql, id));
}

export async function setVisitPrep(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const id = req.params.id;
  if (!UUID.test(id)) return jsonError(404, "not_found", "Visit not found.");
  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await req.json();
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {}
  if (!body || typeof body.ready !== "boolean") return jsonError(400, "bad_request", "ready (boolean) is required.");
  const target = body.ready ? "ready" : "preparing";

  return sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as typeof sql;
    const [visit] = await tx`SELECT id, patient_id, prep_status FROM visits WHERE id = ${id} FOR UPDATE`;
    if (!visit) return jsonError(404, "not_found", "Visit not found.");
    if (body.ready) {
      const failing = (await loadPrepChecklist(tx, visit.id, visit.patient_id)).filter((i) => !i.ok);
      if (failing.length > 0) {
        return Response.json(
          {
            error: "conflict",
            message: `Not ready yet: ${failing.map(prepItemReason).join("; ")}.`,
            failing: failing.map((i) => ({ key: i.key, label: i.label, reason: prepItemReason(i) })),
          },
          { status: 409 },
        );
      }
    }
    if (visit.prep_status !== target) {
      await tx`UPDATE visits SET prep_status = ${target}, prep_set_by = ${user.id}, prep_set_at = now() WHERE id = ${id}`;
      await tx`
        INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
        VALUES (${user.id}, 'set_prep_status', 'visit', ${id},
                ${JSON.stringify({ prep_status: visit.prep_status })}::jsonb, ${JSON.stringify({ prep_status: target })}::jsonb)
      `;
    }
    return Response.json(await prepState(tx, id));
  });
}
