import { sql } from "../db/client";
import { assignCoverageStatus, detectConflicts } from "./rules";
import { matchMarker } from "@prelude/shared";
import type { ExtractedFactCandidate } from "@prelude/shared";

interface DocumentContext {
  id: string;
  patient_id: string;
  visit_id: string;
}

export interface PersistExtractionResult {
  createdFactIds: string[];
  needsManualDate: boolean;
}

/**
 * Persists ExtractedFactCandidate[] as FACT rows (docs/02 M2). For each
 * candidate:
 * - tracked_marker_id is set only on a confident match against the
 *   patient's *existing* TRACKED_MARKER rows (case/whitespace-insensitive
 *   exact match) — not just against the abstract controlled marker list,
 *   since the column is a real FK and can't point at a marker the patient
 *   isn't tracking yet. No match -> tracked_marker_id null, raw_marker_label
 *   set to the candidate's raw label, and coverage_status forced to
 *   extraction_uncertain regardless of the rules engine's own result, so
 *   staff always sees it as needing a mapping decision. This only applies
 *   to candidates that actually carry a trackedMarkerLabel (marker_value /
 *   reference_range candidates) — other field types have no marker to map
 *   and are left alone.
 * - source_page/source_location/source_snippet are copied through exactly
 *   as extracted, including nulls — never invented here.
 * - verification_state is hardcoded 'unverified' at creation, never taken
 *   from the extraction pass.
 * - A candidate with no extractable as_of_date is never dropped and never
 *   given a fabricated date: it is persisted with as_of_date NULL and
 *   facts.needs_manual_date = true, for staff to supply a date in review.
 *   documents.needs_manual_date is set as a derived summary when any fact of
 *   the document needs one.
 *
 * All inserts for the document run in one transaction: either every fact
 * and its audit_log row lands, or none do (and the error propagates so the
 * caller can record extraction_status='failed').
 *
 * Logs an audit_log row (action='upload', entity_type='fact') per fact
 * created, attributed to the uploading user.
 */
export async function persistExtractedFacts(
  document: DocumentContext,
  candidates: ExtractedFactCandidate[],
  actorId: string,
): Promise<PersistExtractionResult> {
  if (candidates.length === 0) {
    return { createdFactIds: [], needsManualDate: false };
  }

  return sql.begin(async (tx) => {
    const trackedMarkerRows = await tx`
      SELECT id, marker_name FROM tracked_markers WHERE patient_id = ${document.patient_id}
    `;
    // Keyed by canonical name (falling back to the tracked marker's own name when it
    // doesn't resolve to one, e.g. a custom marker) so a tracked marker named by any
    // alias — "PSA", not just "Total PSA" — still matches a raw label normalized to
    // the same canonical name.
    const trackedMarkerIdByName = new Map<string, string>(
      trackedMarkerRows.map((row: any) => {
        const name = String(row.marker_name);
        return [(matchMarker(name) ?? name).trim().toLowerCase(), row.id as string];
      }),
    );

    const createdFactIds: string[] = [];
    let needsManualDate = false;

    for (const candidate of candidates) {
      let trackedMarkerId: string | null = null;
      let rawMarkerLabel: string | null = null;
      let coverageStatus = assignCoverageStatus(candidate);

      if (candidate.trackedMarkerLabel) {
        // matchMarker is the deterministic (in-code, not LLM-trusted) normalization step:
        // it resolves a raw extracted label like "Carcinoembryonic Antigen" to its
        // canonical controlled name ("CEA") before looking up the patient's tracked
        // markers, so a tracked marker named "CEA" still matches. No canonical match
        // falls back to the raw label unchanged (custom markers, genuinely unmapped names).
        const lookupLabel = matchMarker(candidate.trackedMarkerLabel) ?? candidate.trackedMarkerLabel;
        const matchId = trackedMarkerIdByName.get(lookupLabel.trim().toLowerCase());
        if (matchId) {
          trackedMarkerId = matchId;
        } else {
          rawMarkerLabel = candidate.trackedMarkerLabel;
          coverageStatus = "extraction_uncertain";
        }
      }

      const undated = candidate.asOfDate === null;
      if (undated) needsManualDate = true;

      const [fact] = await tx`
        INSERT INTO facts (
          patient_id, visit_id, document_id, tracked_marker_id, raw_marker_label,
          field_type, value, unit, reference_range, as_of_date, needs_manual_date,
          coverage_status, verification_state,
          source_page, source_location, source_snippet
        )
        VALUES (
          ${document.patient_id}, ${document.visit_id}, ${document.id}, ${trackedMarkerId}, ${rawMarkerLabel},
          ${candidate.fieldType}, ${candidate.value}, ${candidate.unit}, ${candidate.referenceRange}, ${candidate.asOfDate}, ${undated},
          ${coverageStatus}, 'unverified',
          ${candidate.sourcePage}, ${candidate.sourceLocation}, ${candidate.sourceSnippet}
        )
        RETURNING *
      `;
      createdFactIds.push(fact.id);

      await tx`
        INSERT INTO audit_log (actor_id, action, entity_type, entity_id, after_value)
        VALUES (${actorId}, 'upload', 'fact', ${fact.id}, ${JSON.stringify(fact)}::jsonb)
      `;

      await detectConflicts(tx, fact);
    }

    if (needsManualDate) {
      await tx`UPDATE documents SET needs_manual_date = true WHERE id = ${document.id}`;
    }

    return { createdFactIds, needsManualDate };
  });
}
