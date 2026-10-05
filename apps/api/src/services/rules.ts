import type { CoverageStatus, ExtractedFactCandidate } from "@prelude/shared";
import { sql } from "../db/client";
import { LIVE_FACT_FILTER } from "./delta";

type Exec = typeof sql;

// Below this confidence, a candidate is treated as extraction_uncertain
// regardless of what the extraction pass itself guessed — a named constant
// per docs/02 M2's rules-engine checklist item, not a magic number.
export const EXTRACTION_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Deterministic coverage_status assignment (docs/02 M2, docs/03 §1). Pure —
 * no DB or network calls — and unit-testable in isolation. The extraction
 * pass's own `coverageStatus` guess is a signal, not authoritative; this
 * function is what actually decides the value that gets stored on a FACT
 * row.
 *
 * Rules, in priority order:
 * 1. Source explicitly states the test/field wasn't performed -> not_applicable
 * 2. No usable evidence extracted -> not_assessed
 * 3. Low-confidence or ambiguous extraction -> extraction_uncertain
 * 4. Usable value, confidently extracted -> value_found
 */
export function assignCoverageStatus(candidate: ExtractedFactCandidate): CoverageStatus {
  if (candidate.coverageStatus === "not_applicable") {
    return "not_applicable";
  }
  if (candidate.value === null || candidate.coverageStatus === "not_assessed") {
    return "not_assessed";
  }
  if (candidate.coverageStatus === "extraction_uncertain" || candidate.confidence < EXTRACTION_CONFIDENCE_THRESHOLD) {
    return "extraction_uncertain";
  }
  return "value_found";
}

export interface FactForConflictDetection {
  id: string;
  patient_id: string;
  field_type: string;
  tracked_marker_id: string | null;
  as_of_date: string | Date | null;
  value: string | null;
  needs_manual_date: boolean;
}

/**
 * Conflict detection (docs M7). Looks for another *live* FACT (docs/03 §3;
 * excludes anything already dropped by LIVE_FACT_FILTER) for the same
 * patient_id/field_type/tracked_marker_id with the same as_of_date but a
 * differing value. On a match: an open CONFLICT row is created for the pair
 * (skipped if one already exists, so repeated calls — e.g. the backfill
 * script, or detection running from both sides of a pair — stay idempotent),
 * and coverage_status is forced to 'conflicting_sources' on both facts, even
 * one that's already oncologist_signed_off — verification_state is never
 * touched here; only an oncologist action (reopen) changes it.
 *
 * Skips entirely for a fact with needs_manual_date = true: an undated fact
 * has no as_of_date to match on, and isn't eligible until a commit path
 * (ingestion or a date correction) gives it a real date.
 *
 * `tx` should be the same transaction the fact was just inserted/updated in,
 * so detection sees its own write.
 */
// Field types whose tracked_marker_id is meaningful identity, not incidental.
// A NULL here means "not yet mapped to a controlled marker", not "the same
// marker as every other unmapped candidate" — two unmapped facts sharing a
// NULL must never be treated as the same marker.
const MARKER_CARRYING_FIELD_TYPES = new Set(["marker_value", "reference_range"]);

export interface ConflictPair {
  factIdA: string;
  factIdB: string;
  /** Whether a conflicts row for this pair already existed before this call. */
  alreadyExists: boolean;
}

/**
 * `dryRun: true` performs only the read-side matching (including the
 * existing-row idempotency check) and writes nothing — no INSERT, no
 * coverage_status UPDATE. Used by backfillConflicts.ts --dry-run to report
 * what a real run would do without touching the database.
 */
export async function detectConflicts(
  tx: Exec,
  fact: FactForConflictDetection,
  opts: { dryRun?: boolean } = {},
): Promise<ConflictPair[]> {
  if (fact.needs_manual_date || fact.as_of_date === null) {
    return [];
  }
  if (MARKER_CARRYING_FIELD_TYPES.has(fact.field_type) && fact.tracked_marker_id === null) {
    return [];
  }

  // Compares against the fact's own just-written as_of_date via a subquery
  // (rather than re-serializing fact.as_of_date, which may already be a JS
  // Date from a RETURNING * — round-tripping that through toISOString() is a
  // timezone bug waiting to happen).
  const matches = await tx`
    SELECT f.id FROM facts f
    WHERE f.patient_id = ${fact.patient_id}::uuid
      AND f.field_type = ${fact.field_type}::field_type
      AND f.tracked_marker_id IS NOT DISTINCT FROM ${fact.tracked_marker_id}::uuid
      AND f.as_of_date = (SELECT as_of_date FROM facts WHERE id = ${fact.id}::uuid)
      AND f.id != ${fact.id}::uuid
      AND f.value IS DISTINCT FROM ${fact.value}::text
      AND ${LIVE_FACT_FILTER}
  `;

  const pairs: ConflictPair[] = [];
  for (const match of matches) {
    const [existing] = await tx`
      SELECT id FROM conflicts
      WHERE (fact_id_a = ${fact.id}::uuid AND fact_id_b = ${match.id}::uuid)
         OR (fact_id_a = ${match.id}::uuid AND fact_id_b = ${fact.id}::uuid)
    `;
    pairs.push({ factIdA: fact.id, factIdB: match.id, alreadyExists: !!existing });
    if (opts.dryRun) continue;

    if (!existing) {
      await tx`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${fact.id}, ${match.id}, 'open')`;
    }
    await tx`
      UPDATE facts SET coverage_status = 'conflicting_sources'
      WHERE id = ${fact.id}::uuid OR id = ${match.id}::uuid
    `;
  }
  return pairs;
}
