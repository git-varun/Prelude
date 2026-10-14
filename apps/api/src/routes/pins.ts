import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type MarkerReq = Request & { params: { id: string } };

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function audit(tx: typeof sql, userId: string, action: string, markerId: string, before: unknown, after: unknown) {
  await tx`
    INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
    VALUES (${userId}, ${action}, 'tracked_marker', ${markerId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)
  `;
}

const PIN_STATE = (m: any) => ({
  is_pinned: m.is_pinned, suggested_by: m.suggested_by, suggested_note: m.suggested_note,
});

// Runs `change` on the locked tracked marker inside one transaction, so the state it audits is the state it changed.
async function withMarker(
  req: MarkerReq,
  change: (tx: typeof sql, marker: any) => Promise<Response>,
): Promise<Response> {
  const id = req.params.id;
  if (!UUID.test(id)) return jsonError(404, "not_found", "Marker not found.");
  return sql.begin(async (tx) => {
    const [marker] = await tx`SELECT * FROM tracked_markers WHERE id = ${id} FOR UPDATE`;
    if (!marker) return jsonError(404, "not_found", "Marker not found.");
    return change(tx as unknown as typeof sql, marker);
  });
}

// Oncologist only. Pinning clears any staff suggestion on the marker.
export async function pinMarker(req: MarkerReq, user: AuthedUser): Promise<Response> {
  if (user.role !== "oncologist") return jsonError(403, "forbidden", "Only the oncologist can pin markers.");
  const body = await readBody(req);
  if (!body || typeof body.pinned !== "boolean") return jsonError(400, "bad_request", "pinned (boolean) is required.");
  const pinned = body.pinned;
  return withMarker(req, async (tx, marker) => {
    const [after] = pinned
      ? await tx`
          UPDATE tracked_markers SET is_pinned = true,
            pinned_by = CASE WHEN is_pinned THEN pinned_by ELSE ${user.id}::uuid END,
            pinned_at = CASE WHEN is_pinned THEN pinned_at ELSE now() END,
            suggested_by = NULL, suggested_at = NULL, suggested_note = NULL
          WHERE id = ${marker.id} RETURNING *`
      : await tx`
          UPDATE tracked_markers SET is_pinned = false, pinned_by = NULL, pinned_at = NULL
          WHERE id = ${marker.id} RETURNING *`;
    await audit(tx, user.id, pinned ? "pin_marker" : "unpin_marker", marker.id, PIN_STATE(marker), PIN_STATE(after));
    return Response.json({ id: after.id, is_pinned: after.is_pinned });
  });
}

// Staff (or anyone signed in) may only suggest: this never touches the pin fields.
export async function suggestPin(req: MarkerReq, user: AuthedUser): Promise<Response> {
  const body = await readBody(req);
  if (!body) return jsonError(400, "bad_request", "Malformed JSON body.");
  if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
    return jsonError(400, "bad_request", "note must be text.");
  }
  const note = typeof body.note === "string" && body.note.trim() !== "" ? body.note.trim().slice(0, 500) : null;
  return withMarker(req, async (tx, marker) => {
    if (marker.is_pinned) return jsonError(409, "already_pinned", "This marker is already pinned.");
    const [after] = await tx`
      UPDATE tracked_markers SET suggested_by = ${user.id}, suggested_at = now(), suggested_note = ${note}
      WHERE id = ${marker.id} RETURNING *`;
    await audit(tx, user.id, "suggest_pin", marker.id, PIN_STATE(marker), PIN_STATE(after));
    return Response.json({ id: after.id, suggested: true });
  });
}

// Oncologist only: drop a staff suggestion without pinning.
export async function dismissPinSuggestion(req: MarkerReq, user: AuthedUser): Promise<Response> {
  if (user.role !== "oncologist") return jsonError(403, "forbidden", "Only the oncologist can dismiss a suggestion.");
  return withMarker(req, async (tx, marker) => {
    if (!marker.suggested_by) return jsonError(409, "no_suggestion", "There is no suggestion to dismiss.");
    const [after] = await tx`
      UPDATE tracked_markers SET suggested_by = NULL, suggested_at = NULL, suggested_note = NULL
      WHERE id = ${marker.id} RETURNING *`;
    await audit(tx, user.id, "dismiss_pin_suggestion", marker.id, PIN_STATE(marker), PIN_STATE(after));
    return Response.json({ id: after.id, suggested: false });
  });
}
