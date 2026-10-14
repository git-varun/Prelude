import { sql } from "../db/client";
export interface Provenance {
  document_id: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
  fallback_level: "exact" | "page" | "document";
}

// Single source of truth for "how exact is this fact's source pointer" (docs/M6 Source
// view): exact (page + snippet), page (page only — no provider populates source_location
// in practice), or document (neither). Shared by every endpoint that surfaces provenance,
// so the frontend never has to re-derive it and risk drifting from the backend's rule.
export function provenanceFor(
  documentId: string,
  sourcePage: number | null,
  sourceLocation: string | null,
  sourceSnippet: string | null,
): Provenance {
  const fallback_level = sourcePage != null && sourceSnippet != null ? "exact" : sourcePage != null ? "page" : "document";
  return { document_id: documentId, source_page: sourcePage, source_location: sourceLocation, source_snippet: sourceSnippet, fallback_level };
}

// AM-03: the visit elsewhere a row came from, read off the oe_* columns of a LEFT JOIN outside_encounters (null for visits here).
export function outsideRefOf(r: { oe_id: string | null; oe_facility: string | null; oe_date: string | null }) {
  return r.oe_id ? { id: r.oe_id, facility: r.oe_facility as string, date: r.oe_date as string } : null;
}

export async function outsideRefForDocument(outsideEncounterId: string | null) {
  if (!outsideEncounterId) return null;
  const [r] = await sql`SELECT id, facility, to_char(encounter_date, 'YYYY-MM-DD') AS date FROM outside_encounters WHERE id = ${outsideEncounterId}`;
  return r ? { id: r.id as string, facility: r.facility as string, date: r.date as string } : null;
}
