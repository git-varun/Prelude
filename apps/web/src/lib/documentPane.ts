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

/** How a document is named in the pane's tree ("Blood report", not just "Blood"). */
const PANE_LABELS: Record<string, string> = {
  blood: "Blood report", radiology: "Radiology report", prescription: "Prescription", pathology: "Pathology report",
  discharge: "Discharge summary", other: "Other document",
};

export function paneItemLabel(documentType: string): string {
  return PANE_LABELS[documentType] ?? documentType;
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

/** Identity statuses whose document is not part of the record: the pane shows a notice and never the content. */
export function isHeldIdentity(status: string | null): boolean {
  return status === "mismatch" || status === "awaiting_oncologist" || status === "rejected";
}

export const HELD_NOTICE = "Held for identity check. Not part of the record until the oncologist decides.";

/**
 * Where a fact's source_location points in the page text, when it can be read as a character offset ("120",
 * "120-140", "chars 120-140") or a 1-based line number ("line 5"). Anything else is not parseable: null.
 */
export function parseLocationOffset(text: string, location: string | null): number | null {
  if (!location) return null;
  const chars = location.trim().match(/^(?:chars?\s*)?(\d+)(?:\s*[-–:]\s*\d+)?$/i);
  if (chars) return Number(chars[1]);
  const line = location.trim().match(/^lines?\s*(\d+)/i);
  if (line) {
    const lines = text.split("\n");
    const n = Number(line[1]);
    if (n < 1 || n > lines.length) return null;
    return lines.slice(0, n - 1).reduce((sum, l) => sum + l.length + 1, 0);
  }
  return null;
}

/**
 * Plain substring search of a fact's snippet in the page text (no geometry exists to highlight against). `count` is
 * how many times the snippet occurs. With several occurrences the one nearest the stored location is chosen when
 * the location is parseable, else the first.
 */
export function locateSnippet(text: string, snippet: string | null, location: string | null = null): { start: number; end: number; count: number } | null {
  if (!snippet) return null;
  const starts: number[] = [];
  for (let i = text.indexOf(snippet); i !== -1; i = text.indexOf(snippet, i + snippet.length)) starts.push(i);
  if (starts.length === 0) return null;
  const at = starts.length > 1 ? parseLocationOffset(text, location) : null;
  const start = at === null ? starts[0]! : starts.reduce((best, s) => (Math.abs(s - at) < Math.abs(best - at) ? s : best));
  return { start, end: start + snippet.length, count: starts.length };
}

export function pageText(ocr: DocumentOcr | null, pageNumber: number | null): string | null {
  if (!ocr) return null;
  if (pageNumber === null) return ocr.fullText;
  return ocr.pages.find((p) => p.pageNumber === pageNumber)?.text ?? ocr.fullText;
}

/**
 * What the pane shows for a fact, and how it labels it (README "Document pane": the tag says how precisely the place
 * is known, and never more than it is):
 *   "Exact match · page N"             the snippet is found once on page N, which exists in the OCR pages
 *   "Page · page N · k similar lines"  found k > 1 times on page N (the one nearest the stored location is marked)
 *   "Page · page N"                    the fact names page N, which exists, but the snippet is not found on it
 *   "Document"                         no page named, the named page is not in the OCR, or the fact was not found
 * No page is ever invented. When the named page is missing the whole text is shown, unmarked.
 */
export function paneView(input: {
  ocr: DocumentOcr | null; page: number | null; snippet: string | null; location: string | null;
}): { text: string | null; tag: string | null; hit: { start: number; end: number } | null } {
  const { ocr, page, snippet, location } = input;
  if (!ocr) return { text: null, tag: null, hit: null };
  const found = page === null ? undefined : ocr.pages.find((p) => p.pageNumber === page);
  if (!found || page === null) {
    return { text: ocr.fullText, tag: ocr.fullText.trim() === "" ? null : "Document", hit: null };
  }
  const hit = locateSnippet(found.text, snippet, location);
  const tag = !hit ? `Page · page ${page}`
    : hit.count === 1 ? `Exact match · page ${page}`
    : `Page · page ${page} · ${hit.count} similar lines`;
  return { text: found.text, tag: found.text.trim() === "" ? null : tag, hit: hit && { start: hit.start, end: hit.end } };
}
