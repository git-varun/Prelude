import type { sql } from "../db/client";
import { createPlanItemFromFact } from "./carePlan";
import { CONFLICT_SIDES_LIVE } from "./delta";

type Tx = typeof sql;

// One per-fact sign-off / reopen used by the single routes and the batch routes, so they cannot drift (AM-01).

export const SIGN_OFF_REASONS = {
  not_found: "Fact not found.",
  already_signed_off: "This fact is already oncologist signed-off.",
  undated: "A fact without an as-of date cannot be signed off; supply the date first.",
  unmapped: "A marker must be mapped to a tracked marker before sign-off.",
  conflict: "Sign-off is blocked by an unresolved conflict involving this fact.",
  excluded: "This fact was excluded from this document and cannot be signed off.",
  held: "This document is held for a patient identity mismatch; resolve the identity before signing off its facts.",
  unchecked: "This fact has not been checked against its source. Mark it Correct or Incorrect first.",
  not_correct: "Only facts checked Correct can be signed off in a batch.",
} as const;
export type SignOffOutcome = "ok" | keyof typeof SIGN_OFF_REASONS;

/** Runs inside the caller's transaction. `requireCorrect` is the batch rule: check_state must be 'correct'. */
export async function signOffOne(
  tx: Tx, factId: string, userId: string, opts: { requireCorrect?: boolean } = {},
): Promise<SignOffOutcome> {
  const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
  if (!before) return "not_found";
  if (before.verification_state === "oncologist_signed_off") return "already_signed_off";

  // Application-level checks so a violation is a clean 409; the DB constraints
  // (no_signoff_while_undated, signed_off_requires_oncologist) remain the backstop.
  if (before.as_of_date === null) return "undated";
  if (before.field_type === "marker_value" && before.tracked_marker_id === null) return "unmapped";
  const [conflict] = await tx`
    SELECT c.id FROM conflicts c
    WHERE (c.fact_id_a = ${factId} OR c.fact_id_b = ${factId}) AND c.status IN ('open', 'annotated')
      AND ${CONFLICT_SIDES_LIVE}
    LIMIT 1
  `;
  if (conflict) return "conflict";
  if (before.excluded_at !== null) return "excluded";
  const [doc] = await tx`SELECT identity_status FROM documents WHERE id = ${before.document_id}`;
  if (doc && (doc.identity_status === "mismatch" || doc.identity_status === "rejected")) return "held";
  if (before.check_state === "unchecked") return "unchecked";
  if (opts.requireCorrect && before.check_state !== "correct") return "not_correct";

  const [updated] = await tx`
    UPDATE facts SET verification_state = 'oncologist_signed_off', signed_off_by = ${userId}, signed_off_at = now()
    WHERE id = ${factId}
    RETURNING *
  `;
  await tx`
    INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
    VALUES (${userId}, 'sign_off', 'fact', ${factId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
  `;
  await createPlanItemFromFact(tx, factId, userId);
  return "ok";
}

/** Reopens a signed-off fact. `action` names the audit row ('reopen', or 'sign_off_undo' for a batch undo). */
export async function reopenOne(
  tx: Tx, factId: string, userId: string, action = "reopen",
): Promise<"ok" | "not_found" | "not_signed_off"> {
  const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
  if (!before) return "not_found";
  if (before.verification_state !== "oncologist_signed_off") return "not_signed_off";

  // signed_off_by / signed_off_at are deliberately left as the record of the most recent sign-off.
  const [updated] = await tx`
    UPDATE facts SET verification_state = 'reopened_by_oncologist', reopened_by = ${userId}, reopened_at = now()
    WHERE id = ${factId}
    RETURNING *
  `;
  await tx`
    INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
    VALUES (${userId}, ${action}, 'fact', ${factId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
  `;
  return "ok";
}

// ---- batch ----

export const MAX_BATCH = 100;
/** Server-side undo window: the UI offers 4 s; the rest is grace for latency. */
export const UNDO_WINDOW_SECONDS = 10;

export interface BatchFailure { fact_id: string; reason: string; message: string }
export type BatchResult =
  | { ok: true; count: number }
  | { ok: false; kind: "mixed_patients" }
  | { ok: false; kind: "ineligible"; failures: BatchFailure[] };

class Rollback extends Error {}

/** Runs `step` for each fact in one transaction; if any fails, nothing is kept and every failure is reported. */
async function allOrNothing(
  db: Tx, ids: string[], step: (tx: Tx, id: string) => Promise<{ reason: string; message: string } | null>,
): Promise<BatchResult> {
  const unique = [...new Set(ids)].sort(); // fixed lock order
  const failures: BatchFailure[] = [];
  try {
    await db.begin(async (tx) => {
      const patients = await tx`SELECT DISTINCT patient_id FROM facts WHERE id IN ${tx(unique)}`;
      if (patients.length > 1) throw new Rollback("mixed");
      for (const id of unique) {
        const failure = await step(tx, id);
        if (failure) failures.push({ fact_id: id, ...failure });
      }
      if (failures.length > 0) throw new Rollback("ineligible");
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
    return err.message === "mixed" ? { ok: false, kind: "mixed_patients" } : { ok: false, kind: "ineligible", failures };
  }
  return { ok: true, count: unique.length };
}

export function signOffBatch(db: Tx, ids: string[], userId: string): Promise<BatchResult> {
  return allOrNothing(db, ids, async (tx, id) => {
    const outcome = await signOffOne(tx, id, userId, { requireCorrect: true });
    return outcome === "ok" ? null : { reason: outcome, message: SIGN_OFF_REASONS[outcome] };
  });
}

export function undoSignOffBatch(db: Tx, ids: string[], userId: string): Promise<BatchResult> {
  return allOrNothing(db, ids, async (tx, id) => {
    const [f] = await tx`
      SELECT verification_state, signed_off_by,
             (signed_off_at >= now() - make_interval(secs => ${UNDO_WINDOW_SECONDS})) AS in_window
      FROM facts WHERE id = ${id} FOR UPDATE`;
    if (!f) return { reason: "not_found", message: SIGN_OFF_REASONS.not_found };
    if (f.verification_state !== "oncologist_signed_off") return { reason: "not_signed_off", message: "Only an oncologist signed-off fact can be undone." };
    if (f.signed_off_by !== userId) return { reason: "not_yours", message: "Only the user who signed this fact off can undo it." };
    if (!f.in_window) return { reason: "window_expired", message: "The undo window has passed; use Reopen instead." };
    await reopenOne(tx, id, userId, "sign_off_undo");
    return null;
  });
}
