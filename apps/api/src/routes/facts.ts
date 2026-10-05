import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { detectConflicts } from "../services/rules";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

type Exec = typeof sql;

// Explicit column list (not f.*) so as_of_date is a YYYY-MM-DD string, never a JS Date.
async function queryFacts(exec: Exec, filter: { documentId?: string; factId?: string }) {
  return exec`
    SELECT f.id, f.patient_id, f.visit_id, f.document_id, f.tracked_marker_id,
           tm.marker_name AS tracked_marker_name, f.raw_marker_label, f.field_type, f.value, f.unit,
           f.reference_range, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.needs_manual_date,
           f.coverage_status, f.verification_state, f.source_page, f.source_location, f.source_snippet,
           EXISTS (
             SELECT 1 FROM conflicts c
             WHERE (c.fact_id_a = f.id OR c.fact_id_b = f.id) AND c.status IN ('open', 'annotated')
           ) AS has_blocking_conflict
    FROM facts f
    LEFT JOIN tracked_markers tm ON tm.id = f.tracked_marker_id
    WHERE (${filter.documentId ?? null}::uuid IS NULL OR f.document_id = ${filter.documentId ?? null}::uuid)
      AND (${filter.factId ?? null}::uuid IS NULL OR f.id = ${filter.factId ?? null}::uuid)
    ORDER BY f.source_page NULLS LAST, tm.marker_name NULLS LAST, f.field_type, f.id
  `;
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
  return Response.json({ document, facts, tracked_markers: trackedMarkers });
}

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
type Resolution = keyof typeof RESOLUTION_COVERAGE;
const isResolution = (r: unknown): r is Resolution => typeof r === "string" && Object.hasOwn(RESOLUTION_COVERAGE, r);

export async function patchFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }
  if (typeof body !== "object" || body === null) return jsonError(400, "bad_request", "Expected a JSON object.");

  const { value, unit, reference_range: referenceRange, tracked_marker_id: markerId, as_of_date: asOfDate, resolution } = body;
  if ("coverage_status" in body) {
    return jsonError(400, "bad_request", "coverage_status cannot be set directly; use resolution on an extraction_uncertain fact.");
  }
  if (
    value === undefined && unit === undefined && referenceRange === undefined && markerId === undefined &&
    asOfDate === undefined && resolution === undefined
  ) {
    return jsonError(400, "bad_request", "Provide at least one of value, unit, reference_range, tracked_marker_id, as_of_date, resolution.");
  }
  if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
    return jsonError(400, "bad_request", "value must be a non-empty string.");
  }
  for (const [name, v] of [["unit", unit], ["reference_range", referenceRange]] as const) {
    if (v !== undefined && (typeof v !== "string" || v.trim() === "")) {
      return jsonError(400, "bad_request", `${name} must be a non-empty string.`);
    }
  }
  if (markerId !== undefined && !isUuid(markerId)) {
    return jsonError(400, "bad_request", "tracked_marker_id must be a UUID.");
  }
  if (asOfDate !== undefined && (typeof asOfDate !== "string" || !isRealDate(asOfDate))) {
    return jsonError(400, "bad_request", "as_of_date must be a real date in YYYY-MM-DD format.");
  }
  if (resolution !== undefined) {
    if (!isResolution(resolution)) {
      return jsonError(400, "bad_request", `resolution must be one of: ${Object.keys(RESOLUTION_COVERAGE).join(", ")}.`);
    }
    if (resolution === "value_found" && value === undefined) {
      return jsonError(400, "bad_request", "resolution value_found requires a verified value.");
    }
    if (resolution !== "value_found" && value !== undefined) {
      return jsonError(400, "bad_request", `resolution ${resolution} must not include a value.`);
    }
  }

  const newValue = typeof value === "string" ? value.trim() : null;
  const newUnit = typeof unit === "string" ? unit.trim() : null;
  const newRange = typeof referenceRange === "string" ? referenceRange.trim() : null;
  const newMarkerId = typeof markerId === "string" ? markerId : null;
  const newDate = typeof asOfDate === "string" ? asOfDate : null;
  const clearValue = resolution !== undefined && resolution !== "value_found";

  const outcome = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
    if (!before) return "not_found" as const;
    if (before.verification_state === "oncologist_signed_off") return "signed_off" as const;

    if (resolution !== undefined && before.coverage_status !== "extraction_uncertain") return "not_uncertain" as const;

    // An explicit resolution wins; a bare verified value on an uncertain fact keeps meaning value_found.
    const newCoverage =
      before.coverage_status !== "extraction_uncertain" ? null
      : resolution !== undefined ? RESOLUTION_COVERAGE[resolution]
      : newValue !== null ? "value_found"
      : null;

    if (newMarkerId) {
      const [marker] = await tx`SELECT id FROM tracked_markers WHERE id = ${newMarkerId} AND patient_id = ${before.patient_id}`;
      if (!marker) return "bad_marker" as const;
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
        corrected_by = ${user.id}
      WHERE id = ${factId}
      RETURNING *
    `;

    await tx`
      UPDATE documents SET needs_manual_date =
        EXISTS (SELECT 1 FROM facts WHERE document_id = ${before.document_id} AND needs_manual_date)
      WHERE id = ${before.document_id}
    `;
    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, 'correct', 'fact', ${factId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
    `;

    // Only run detection on the transition from undated to dated — this is
    // when the fact becomes eligible for the first time. A value/marker edit
    // on an already-dated fact doesn't re-trigger detection here.
    if (before.as_of_date === null && updated.as_of_date !== null) {
      await detectConflicts(tx, updated);
    }

    return "ok" as const;
  });

  if (outcome === "not_found") return jsonError(404, "not_found", "Fact not found.");
  if (outcome === "signed_off") {
    return jsonError(409, "conflict", "This fact is oncologist signed-off; it must be reopened before it can be corrected.");
  }
  if (outcome === "not_uncertain") {
    return jsonError(409, "conflict", "resolution applies only to facts whose coverage_status is extraction_uncertain.");
  }
  if (outcome === "bad_marker") return jsonError(400, "bad_request", "tracked_marker_id does not belong to this fact's patient.");

  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}

export async function signOffFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");

  const outcome = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
    if (!before) return "not_found" as const;
    if (before.verification_state === "oncologist_signed_off") return "already_signed_off" as const;

    // Application-level checks so a violation is a clean 409; the DB constraints
    // (no_signoff_while_undated, signed_off_requires_oncologist) remain the backstop.
    if (before.as_of_date === null) return "undated" as const;
    if (before.field_type === "marker_value" && before.tracked_marker_id === null) return "unmapped" as const;
    const [conflict] = await tx`
      SELECT id FROM conflicts
      WHERE (fact_id_a = ${factId} OR fact_id_b = ${factId}) AND status IN ('open', 'annotated')
      LIMIT 1
    `;
    if (conflict) return "conflict" as const;

    const [updated] = await tx`
      UPDATE facts SET verification_state = 'oncologist_signed_off', signed_off_by = ${user.id}, signed_off_at = now()
      WHERE id = ${factId}
      RETURNING *
    `;
    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, 'sign_off', 'fact', ${factId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
    `;
    return "ok" as const;
  });

  if (outcome === "not_found") return jsonError(404, "not_found", "Fact not found.");
  if (outcome === "already_signed_off") return jsonError(409, "conflict", "This fact is already oncologist signed-off.");
  if (outcome === "undated") return jsonError(409, "conflict", "A fact without an as-of date cannot be signed off; supply the date first.");
  if (outcome === "unmapped") return jsonError(409, "conflict", "A marker must be mapped to a tracked marker before sign-off.");
  if (outcome === "conflict") return jsonError(409, "conflict", "Sign-off is blocked by an unresolved conflict involving this fact.");

  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}

export async function reopenFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");

  const outcome = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
    if (!before) return "not_found" as const;
    if (before.verification_state !== "oncologist_signed_off") return "not_signed_off" as const;

    // signed_off_by / signed_off_at are deliberately left as the record of the most recent sign-off.
    const [updated] = await tx`
      UPDATE facts SET verification_state = 'reopened_by_oncologist', reopened_by = ${user.id}, reopened_at = now()
      WHERE id = ${factId}
      RETURNING *
    `;
    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, 'reopen', 'fact', ${factId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
    `;
    return "ok" as const;
  });

  if (outcome === "not_found") return jsonError(404, "not_found", "Fact not found.");
  if (outcome === "not_signed_off") return jsonError(409, "conflict", "Only an oncologist signed-off fact can be reopened.");

  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}
