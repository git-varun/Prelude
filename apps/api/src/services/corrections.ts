import type { sql } from "../db/client";
import { detectConflicts } from "./rules";

type Tx = typeof sql;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s && !s.startsWith("0000");
}

// How a reviewer resolves an extraction_uncertain fact. Stated explicitly by the caller, never inferred from
// whether `value` is null. Deliberately excludes conflicting_sources / not_found_in_document_set: those are
// system-derived and no correction may set them.
const RESOLUTION_COVERAGE = {
  value_found: "value_found",
  no_usable_value: "not_assessed",
  source_states_not_performed: "not_applicable",
} as const;
export type Resolution = keyof typeof RESOLUTION_COVERAGE;
const isResolution = (r: unknown): r is Resolution => typeof r === "string" && Object.hasOwn(RESOLUTION_COVERAGE, r);

export interface Correction {
  value?: string;
  unit?: string;
  referenceRange?: string;
  trackedMarkerId?: string;
  asOfDate?: string;
  resolution?: Resolution;
}

export type ApplyOutcome =
  | { outcome: "ok"; before: Record<string, any>; updated: Record<string, any> }
  | { outcome: "not_found" | "signed_off" | "not_uncertain" | "bad_marker" };

export function parseCorrection(body: unknown): { ok: true; correction: Correction } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) return { ok: false, message: "Expected a JSON object." };
  const b = body as Record<string, unknown>;
  const { value, unit, reference_range: referenceRange, tracked_marker_id: markerId, as_of_date: asOfDate, resolution } = b;
  if ("coverage_status" in b) {
    return { ok: false, message: "coverage_status cannot be set directly; use resolution on an extraction_uncertain fact." };
  }
  if (
    value === undefined && unit === undefined && referenceRange === undefined && markerId === undefined &&
    asOfDate === undefined && resolution === undefined
  ) {
    return { ok: false, message: "Provide at least one of value, unit, reference_range, tracked_marker_id, as_of_date, resolution." };
  }
  if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
    return { ok: false, message: "value must be a non-empty string." };
  }
  for (const [name, v] of [["unit", unit], ["reference_range", referenceRange]] as const) {
    if (v !== undefined && (typeof v !== "string" || v.trim() === "")) {
      return { ok: false, message: `${name} must be a non-empty string.` };
    }
  }
  if (markerId !== undefined && !isUuid(markerId)) {
    return { ok: false, message: "tracked_marker_id must be a UUID." };
  }
  if (asOfDate !== undefined && (typeof asOfDate !== "string" || !isRealDate(asOfDate))) {
    return { ok: false, message: "as_of_date must be a real date in YYYY-MM-DD format." };
  }
  if (resolution !== undefined) {
    if (!isResolution(resolution)) {
      return { ok: false, message: `resolution must be one of: ${Object.keys(RESOLUTION_COVERAGE).join(", ")}.` };
    }
    if (resolution === "value_found" && value === undefined) {
      return { ok: false, message: "resolution value_found requires a verified value." };
    }
    if (resolution !== "value_found" && value !== undefined) {
      return { ok: false, message: `resolution ${resolution} must not include a value.` };
    }
  }

  const c: Correction = {};
  if (typeof value === "string") c.value = value.trim();
  if (typeof unit === "string") c.unit = unit.trim();
  if (typeof referenceRange === "string") c.referenceRange = referenceRange.trim();
  if (typeof markerId === "string") c.trackedMarkerId = markerId;
  if (typeof asOfDate === "string") c.asOfDate = asOfDate;
  if (isResolution(resolution)) c.resolution = resolution;
  return { ok: true, correction: c };
}

/** An excluded fact (spot-check: not in the document / wrong patient) never holds its document in "needs a date".
 * The caller must hold the document row lock. */
export async function recomputeDocumentNeedsManualDate(tx: Tx, documentId: string): Promise<void> {
  await tx`
    UPDATE documents SET needs_manual_date =
      EXISTS (SELECT 1 FROM facts WHERE document_id = ${documentId} AND needs_manual_date AND excluded_at IS NULL)
    WHERE id = ${documentId}
  `;
}

/** Runs inside the caller's transaction. Locks fact, then document (re-locking an already-held row is a no-op). */
export async function applyCorrection(tx: Tx, factId: string, c: Correction, userId: string): Promise<ApplyOutcome> {
  const newValue = c.value ?? null;
  const newUnit = c.unit ?? null;
  const newRange = c.referenceRange ?? null;
  const newMarkerId = c.trackedMarkerId ?? null;
  const newDate = c.asOfDate ?? null;
  const resolution = c.resolution;
  const clearValue = resolution !== undefined && resolution !== "value_found";

  const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
  if (!before) return { outcome: "not_found" };
  if (before.verification_state === "oncologist_signed_off") return { outcome: "signed_off" };

  if (resolution !== undefined && before.coverage_status !== "extraction_uncertain") return { outcome: "not_uncertain" };

  // An explicit resolution wins; a bare verified value on an uncertain fact keeps meaning value_found.
  const newCoverage =
    before.coverage_status !== "extraction_uncertain" ? null
    : resolution !== undefined ? RESOLUTION_COVERAGE[resolution]
    : newValue !== null ? "value_found"
    : null;

  if (newMarkerId) {
    const [marker] = await tx`SELECT id FROM tracked_markers WHERE id = ${newMarkerId} AND patient_id = ${before.patient_id}`;
    if (!marker) return { outcome: "bad_marker" };
  }

  // Serialize PATCHes per document so the needs_manual_date recompute sees committed siblings.
  await tx`SELECT 1 FROM documents WHERE id = ${before.document_id} FOR UPDATE`;

  const [updated] = await tx`
    UPDATE facts SET
      value = CASE WHEN ${clearValue} THEN NULL ELSE COALESCE(${newValue}::text, value) END,
      unit = COALESCE(${newUnit}::text, unit),
      reference_range = COALESCE(${newRange}::text, reference_range),
      tracked_marker_id = COALESCE(${newMarkerId}::uuid, tracked_marker_id),
      raw_marker_label = CASE WHEN ${newMarkerId}::uuid IS NOT NULL THEN NULL ELSE raw_marker_label END,
      as_of_date = COALESCE(${newDate}::date, as_of_date),
      needs_manual_date = CASE WHEN ${newDate}::date IS NOT NULL THEN false ELSE needs_manual_date END,
      coverage_status = COALESCE(${newCoverage}::coverage_status, coverage_status),
      verification_state = 'staff_corrected',
      corrected_by = ${userId}
    WHERE id = ${factId}
    RETURNING *
  `;

  await recomputeDocumentNeedsManualDate(tx, before.document_id);
  await tx`
    INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
    VALUES (${userId}, 'correct', 'fact', ${factId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
  `;

  // Only run detection on the transition from undated to dated — this is
  // when the fact becomes eligible for the first time. A value/marker edit
  // on an already-dated fact doesn't re-trigger detection here.
  if (before.as_of_date === null && updated.as_of_date !== null) {
    await detectConflicts(tx, updated);
  }

  return { outcome: "ok", before, updated };
}
