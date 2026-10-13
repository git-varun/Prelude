import type { sql } from "../db/client";
import { applyCorrection, parseCorrection, recomputeDocumentNeedsManualDate, type Correction } from "./corrections";
import { CONFLICT_SIDES_LIVE } from "./delta";
import { detectConflicts } from "./rules";

type Tx = typeof sql;

export type CheckErrorType = "value" | "unit" | "marker" | "date" | "range" | "not_in_document" | "wrong_patient";
export type CheckInput =
  | { result: "correct" }
  | { result: "incorrect"; errorType: CheckErrorType; correction?: Correction };

// Each correctable error type names the Correction field that must carry the fix.
const CORRECTION_FIELD = {
  value: "value",
  unit: "unit",
  marker: "trackedMarkerId",
  date: "asOfDate",
  range: "referenceRange",
} as const satisfies Record<string, keyof Correction>;
const EXCLUSION_TYPES = new Set<CheckErrorType>(["not_in_document", "wrong_patient"]);
const ERROR_TYPES: readonly CheckErrorType[] = [...(Object.keys(CORRECTION_FIELD) as CheckErrorType[]), ...EXCLUSION_TYPES];

export function parseCheck(body: unknown): { ok: true; input: CheckInput } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) return { ok: false, message: "Expected a JSON object." };
  const b = body as Record<string, unknown>;
  if (b.result === "correct") {
    if (b.error_type !== undefined || b.correction !== undefined) {
      return { ok: false, message: "A correct mark takes no error_type or correction." };
    }
    return { ok: true, input: { result: "correct" } };
  }
  if (b.result !== "incorrect") return { ok: false, message: "result must be correct or incorrect." };

  const errorType = b.error_type;
  if (typeof errorType !== "string" || !ERROR_TYPES.includes(errorType as CheckErrorType)) {
    return { ok: false, message: `error_type must be one of: ${ERROR_TYPES.join(", ")}.` };
  }
  const et = errorType as CheckErrorType;
  if (EXCLUSION_TYPES.has(et)) {
    if (b.correction !== undefined) return { ok: false, message: `error_type ${et} takes no correction.` };
    return { ok: true, input: { result: "incorrect", errorType: et } };
  }

  if (b.correction === undefined) return { ok: false, message: `error_type ${et} requires a correction.` };
  const parsed = parseCorrection(b.correction);
  if (!parsed.ok) return { ok: false, message: `correction: ${parsed.message}` };
  const field = CORRECTION_FIELD[et as keyof typeof CORRECTION_FIELD];
  if (parsed.correction[field] === undefined) {
    return { ok: false, message: `error_type ${et} requires the correction to include the corrected field.` };
  }
  return { ok: true, input: { result: "incorrect", errorType: et, correction: parsed.correction } };
}

export type CheckOutcome =
  | { outcome: "ok" }
  | { outcome: "not_found" | "signed_off" | "held" | "needs_value" | "needs_date" | "bad_marker" | "not_uncertain" };

async function audit(tx: Tx, userId: string, factId: string, before: unknown, after: unknown): Promise<void> {
  await tx`
    INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
    VALUES (${userId}, 'check_fact', 'fact', ${factId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb)
  `;
}

/**
 * Records a reviewer's spot-check mark. Runs inside the caller's transaction; locks the fact, then its document
 * (the same order as applyCorrection / PATCH, so the two never deadlock). Every non-ok outcome is returned before
 * anything is written, so the caller's commit-on-return never persists a partial check.
 */
export async function checkFact(tx: Tx, factId: string, input: CheckInput, userId: string): Promise<CheckOutcome> {
  const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
  if (!before) return { outcome: "not_found" };
  if (before.verification_state === "oncologist_signed_off") return { outcome: "signed_off" };
  const [doc] = await tx`SELECT identity_status FROM documents WHERE id = ${before.document_id} FOR UPDATE`;
  if (doc && (doc.identity_status === "mismatch" || doc.identity_status === "rejected")) return { outcome: "held" };

  if (input.result === "correct") {
    if (before.value === null || String(before.value).trim() === "") return { outcome: "needs_value" };
    if (before.needs_manual_date) return { outcome: "needs_date" };
  } else if (input.correction) {
    const applied = await applyCorrection(tx, factId, input.correction, userId);
    if (applied.outcome !== "ok") return { outcome: applied.outcome };
  }

  const checkState = input.result;
  const errorType = input.result === "incorrect" ? input.errorType : null;
  const exclude = errorType === "not_in_document" || errorType === "wrong_patient";

  const [updated] = await tx`
    UPDATE facts SET
      check_state = ${checkState}::check_state,
      checked_by = ${userId},
      checked_at = now(),
      error_type = ${errorType}::check_error_type,
      excluded_at = CASE WHEN ${exclude} THEN COALESCE(excluded_at, now()) ELSE NULL END
    WHERE id = ${factId}
    RETURNING *
  `;

  const wasExcluded = before.excluded_at !== null;
  if (exclude && !wasExcluded) {
    // This fact's conflicts stopped counting (CONFLICT_SIDES_LIVE). Mirror resolveConflict: the other side goes back
    // to value_found unless another live open/annotated conflict still holds it.
    await tx`
      UPDATE facts o SET coverage_status = 'value_found'
      WHERE o.coverage_status = 'conflicting_sources'
        AND o.id IN (
          SELECT CASE WHEN x.fact_id_a = ${factId}::uuid THEN x.fact_id_b ELSE x.fact_id_a END
          FROM conflicts x
          WHERE (x.fact_id_a = ${factId}::uuid OR x.fact_id_b = ${factId}::uuid) AND x.status IN ('open', 'annotated')
        )
        AND NOT EXISTS (
          SELECT 1 FROM conflicts c
          WHERE (c.fact_id_a = o.id OR c.fact_id_b = o.id) AND c.status IN ('open', 'annotated') AND ${CONFLICT_SIDES_LIVE}
        )
    `;
  }
  if (wasExcluded && !exclude) {
    // excluded_at is already cleared above: detectConflicts returns early for a fact that is still excluded.
    await detectConflicts(tx, updated);
  }
  if (wasExcluded !== exclude) await recomputeDocumentNeedsManualDate(tx, before.document_id);

  const [after] = await tx`SELECT * FROM facts WHERE id = ${factId}`;
  await audit(tx, userId, factId, before, after);
  return { outcome: "ok" };
}

/** Clears a mark after an edit. Never for an excluded fact (PATCH 409s first); the guard keeps the DB constraints whole. */
export async function resetCheck(tx: Tx, factId: string, userId: string): Promise<boolean> {
  const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
  if (!before) return false;
  const [updated] = await tx`
    UPDATE facts SET check_state = 'unchecked', checked_by = NULL, checked_at = NULL, error_type = NULL
    WHERE id = ${factId} AND check_state != 'unchecked' AND excluded_at IS NULL
    RETURNING *
  `;
  if (!updated) return false;
  await audit(tx, userId, factId, before, updated);
  return true;
}
