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
