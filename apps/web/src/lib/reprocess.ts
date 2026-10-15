import type { DocumentRecord } from "../api/client";

/** Mirrors the API: only a document whose OCR or extraction failed can be re-run from the stored file. */
export function canReprocess(doc: Pick<DocumentRecord, "document_type" | "ocr_status" | "extraction_status" | "identity_status">): boolean {
  if (doc.document_type === "other" || doc.identity_status === "rejected") return false;
  return doc.ocr_status === "failed" || (doc.ocr_status === "done" && doc.extraction_status === "failed");
}

/** Which step failed, in plain words. */
export function failedStepLabel(doc: Pick<DocumentRecord, "ocr_status">): string {
  return doc.ocr_status === "failed" ? "Reading the text (OCR)" : "Extracting the facts";
}
