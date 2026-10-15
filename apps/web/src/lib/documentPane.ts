import type { DocumentOcr, PatientDocumentEntry } from "../api/client";

// Tree groups of the document pane (README section 4): Reports, Radiology, Prescriptions, Other.
// Mapping: blood -> Reports, radiology -> Radiology, prescription -> Prescriptions. The README names no group for
// pathology or discharge summaries, so they sit under Other with the "other" type, never guessed into Reports.
export const PANE_GROUPS = ["Reports", "Radiology", "Prescriptions", "Other"] as const;
export type PaneGroup = (typeof PANE_GROUPS)[number];

export function paneGroupOf(documentType: string): PaneGroup {
  switch (documentType) {
    case "blood": return "Reports";
    case "radiology": return "Radiology";
    case "prescription": return "Prescriptions";
    default: return "Other";
  }
}

/** Non-empty groups in README order; documents keep the order the API gave them (newest first). */
export function groupDocuments(docs: PatientDocumentEntry[]): { group: PaneGroup; docs: PatientDocumentEntry[] }[] {
  return PANE_GROUPS
    .map((group) => ({ group, docs: docs.filter((d) => paneGroupOf(d.document_type) === group) }))
    .filter((g) => g.docs.length > 0);
}

/** The date shown for a document: the report date, else the collection date, else the upload date. */
export function documentDate(doc: Pick<PatientDocumentEntry, "reported_on" | "collected_on" | "uploaded_at">): string {
  return doc.reported_on ?? doc.collected_on ?? doc.uploaded_at.slice(0, 10);
}

/** "lab · date · outside/elsewhere" -- parts that do not exist are left out, nothing is invented. */
export function documentMetaLine(doc: PatientDocumentEntry): string {
  const where = doc.outside_facility
    ? `${doc.outside_facility} · elsewhere`
    : doc.source_origin.startsWith("outside_") ? "outside" : null;
  return [doc.lab_name, documentDate(doc), where].filter(Boolean).join(" · ");
}

/** Plain substring search of a fact's snippet in the page text (no geometry exists to highlight against). */
export function locateSnippet(text: string, snippet: string | null): { start: number; end: number } | null {
  if (!snippet) return null;
  const start = text.indexOf(snippet);
  return start === -1 ? null : { start, end: start + snippet.length };
}

export function pageText(ocr: DocumentOcr | null, pageNumber: number | null): string | null {
  if (!ocr) return null;
  if (pageNumber === null) return ocr.fullText;
  return ocr.pages.find((p) => p.pageNumber === pageNumber)?.text ?? ocr.fullText;
}

/**
 * The pane's provenance tag. Only two wordings exist: "Exact match" when the fact says its location is exact AND the
 * snippet is really found on the page shown; otherwise "Document" (page-level, document-level or snippet not found).
 */
export function provenanceTag(input: { level: string | null; snippet: string | null; text: string | null; page: number | null }): string {
  const page = input.page ?? 1;
  const exact = input.level === "exact" && input.text !== null && locateSnippet(input.text, input.snippet) !== null;
  return `${exact ? "Exact match" : "Document"} · page ${page}`;
}
