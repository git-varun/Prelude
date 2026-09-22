import { sql } from "../db/client";
import { assignCoverageStatus } from "./rules";
import type { ExtractedFactCandidate } from "@opd/shared";

interface DocumentContext {
  id: string;
  patient_id: string;
  visit_id: string;
}

export interface PersistExtractionResult {
  createdFactIds: string[];
  heldForManualDate: boolean;
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
 * - as_of_date is NOT NULL on facts and is never fabricated: if NONE of a
 *   document's candidates carry an extractable date, nothing is persisted
 *   and documents.needs_manual_date is set instead, for the (future)
 *   Extraction Review screen to resolve with a manual date. If only *some*
 *   candidates lack a date, those individual ones are dropped (logged) since
 *   the document-level hold condition doesn't apply to them — the rest are
 *   persisted normally.
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
    return { createdFactIds: [], heldForManualDate: false };
  }

  const dated = candidates.filter((c) => c.asOfDate !== null);
  const undated = candidates.filter((c) => c.asOfDate === null);

  if (dated.length === 0) {
    await sql`UPDATE documents SET needs_manual_date = true WHERE id = ${document.id}`;
    return { createdFactIds: [], heldForManualDate: true };
  }

  if (undated.length > 0) {
    console.warn(
      `Document ${document.id}: dropping ${undated.length} extracted candidate(s) with no as_of_date ` +
        `(the document has other dated candidates, so needs_manual_date was not set for the whole document).`,
    );
  }

  const trackedMarkerRows = await sql`
    SELECT id, marker_name FROM tracked_markers WHERE patient_id = ${document.patient_id}
  `;
  const trackedMarkerIdByName = new Map<string, string>(
    trackedMarkerRows.map((row: any) => [String(row.marker_name).trim().toLowerCase(), row.id as string]),
  );

  const createdFactIds: string[] = [];

  for (const candidate of dated) {
    let trackedMarkerId: string | null = null;
    let rawMarkerLabel: string | null = null;
    let coverageStatus = assignCoverageStatus(candidate);

    if (candidate.trackedMarkerLabel) {
      const matchId = trackedMarkerIdByName.get(candidate.trackedMarkerLabel.trim().toLowerCase());
      if (matchId) {
        trackedMarkerId = matchId;
      } else {
        rawMarkerLabel = candidate.trackedMarkerLabel;
        coverageStatus = "extraction_uncertain";
      }
    }

    const [fact] = await sql`
      INSERT INTO facts (
        patient_id, visit_id, document_id, tracked_marker_id, raw_marker_label,
        field_type, value, unit, reference_range, as_of_date,
        coverage_status, verification_state,
        source_page, source_location, source_snippet
      )
      VALUES (
        ${document.patient_id}, ${document.visit_id}, ${document.id}, ${trackedMarkerId}, ${rawMarkerLabel},
        ${candidate.fieldType}, ${candidate.value}, ${candidate.unit}, ${candidate.referenceRange}, ${candidate.asOfDate},
        ${coverageStatus}, 'unverified',
        ${candidate.sourcePage}, ${candidate.sourceLocation}, ${candidate.sourceSnippet}
      )
      RETURNING *
    `;
    createdFactIds.push(fact.id);

    await sql`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, after_value)
      VALUES (${actorId}, 'upload', 'fact', ${fact.id}, ${JSON.stringify(fact)}::jsonb)
    `;
  }

  return { createdFactIds, heldForManualDate: false };
}
