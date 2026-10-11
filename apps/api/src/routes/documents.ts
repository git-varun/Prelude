import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { deleteDocumentFile, documentFile, readOcrResult, saveDocumentFile, saveOcrResult } from "../services/storage";
import { getExtractionProvider, getLlmExtractionProvider, getOcrProvider } from "../services/providerFactory";
import { persistExtractedFacts } from "../services/facts";
import { matchIdentity } from "../services/extraction/deterministic/identity";
import { IMAGING_MODALITY_OPTIONS } from "@prelude/shared";
import type { DocumentType, ExtractionProvider, ExtractionResult, OcrResult } from "@prelude/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

const DOCUMENT_TYPES = ["prescription", "blood", "radiology"] as const;
const SOURCE_ORIGINS = ["own_hospital", "outside_paper", "outside_cd", "whatsapp_pdf"] as const;

// file_ref's suffix preserves the original upload's extension (saveDocumentFile), so the
// content type for serving it back is inferred from that rather than a stored mime column.
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  heic: "image/heic",
};

function contentTypeForFileRef(fileRef: string): string {
  const ext = fileRef.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// m1-backlog B3: all three document types legitimately arrive as either a
// scanned/exported PDF or a phone photo, so this is a single allowlist
// rather than a per-document_type mapping. `file.type` is client-supplied
// (no magic-byte sniffing here) — it's a UX guard against obviously wrong
// files, not a security control.
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic"]);
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

export async function uploadDocument(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const patientId = req.params.id;

  // Cheap rejection before spending memory parsing the multipart body
  // (Bun's server-level maxRequestBodySize is the hard cap; this gives a
  // clean 400 instead of a connection-level failure for the common case).
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FILE_SIZE_BYTES) {
    return jsonError(400, "bad_request", `File exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit.`);
  }

  const [patient] = await sql`SELECT id, name FROM patients WHERE id = ${patientId}`;
  if (!patient) {
    return jsonError(404, "not_found", "Patient not found.");
  }

  let form: Awaited<ReturnType<Request["formData"]>>;
  try {
    form = await req.formData();
  } catch {
    return jsonError(400, "bad_request", "Expected multipart/form-data.");
  }

  const visitId = form.get("visit_id");
  const documentType = form.get("document_type");
  const sourceOrigin = form.get("source_origin");
  const imagingModality = form.get("imaging_modality");
  const file = form.get("file");

  if (typeof visitId !== "string" || !visitId) {
    return jsonError(400, "bad_request", "visit_id is required.");
  }
  if (typeof documentType !== "string" || !(DOCUMENT_TYPES as readonly string[]).includes(documentType)) {
    return jsonError(400, "bad_request", `document_type must be one of: ${DOCUMENT_TYPES.join(", ")}.`);
  }
  if (typeof sourceOrigin !== "string" || !(SOURCE_ORIGINS as readonly string[]).includes(sourceOrigin)) {
    return jsonError(400, "bad_request", `source_origin must be one of: ${SOURCE_ORIGINS.join(", ")}.`);
  }
  // Purely descriptive metadata (m3-backlog #3) -- required only for radiology, since
  // the other document types have no scan modality to record.
  if (
    documentType === "radiology" &&
    (typeof imagingModality !== "string" || !(IMAGING_MODALITY_OPTIONS as readonly string[]).includes(imagingModality))
  ) {
    return jsonError(400, "bad_request", `imaging_modality must be one of: ${IMAGING_MODALITY_OPTIONS.join(", ")}.`);
  }
  if (!(file instanceof File)) {
    return jsonError(400, "bad_request", "file is required.");
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return jsonError(400, "bad_request", `File exceeds the ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB limit.`);
  }
  if (!ALLOWED_MIME_TYPES.has(file.type)) {
    return jsonError(400, "bad_request", `Unsupported file type: ${file.type || "unknown"}.`);
  }

  // A document belongs to exactly one visit, and that visit must belong to
  // this patient (docs/01 §11) — not just any visit id the client passes.
  const [visit] = await sql`SELECT id FROM visits WHERE id = ${visitId} AND patient_id = ${patientId}`;
  if (!visit) {
    return jsonError(404, "not_found", "Visit not found for this patient.");
  }

  // Same bytes for the same patient hash the same; runOcr reuses the stored OCR text by (patient, hash).
  const fileSha256 = new Bun.CryptoHasher("sha256").update(Buffer.from(await file.arrayBuffer())).digest("hex");

  const { file_ref } = await saveDocumentFile(patientId, file.name, file);

  let document;
  try {
    // One transaction for the document row and its audit_log entry --
    // previously two independent statements, so a failure between them left
    // a document (and its file on disk) with no corresponding audit_log row,
    // silently breaking the audit trail this PHI data otherwise maintains
    // everywhere else (facts.ts/conflicts.ts already do this correctly).
    document = await sql.begin(async (tx) => {
      const [doc] = await tx`
        INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, imaging_modality, uploaded_by, ocr_status, file_sha256)
        VALUES (${patientId}, ${visitId}, ${file_ref}, ${documentType}, ${sourceOrigin}, ${documentType === "radiology" ? (imagingModality as string) : null}, ${user.id}, 'pending', ${fileSha256})
        RETURNING *
      `;
      await tx`
        INSERT INTO audit_log (actor_id, action, entity_type, entity_id, after_value)
        VALUES (${user.id}, 'upload', 'document', ${doc.id}, ${JSON.stringify(doc)}::jsonb)
      `;
      return doc;
    });
  } catch (err) {
    // m1-backlog B4: don't orphan the file already written to storage if the
    // transaction fails.
    await deleteDocumentFile(file_ref);
    throw err;
  }

  document = await runOcr(document, file, documentType as (typeof DOCUMENT_TYPES)[number], user.id, patient.name ?? null);

  return Response.json(document, { status: 201 });
}

// docs/02 M2: "on upload, run OCR and update ocr_status to done/failed."
// Runs inline in the upload request rather than a background queue — no
// queue infrastructure exists yet, and this matches the M2 checklist's
// wording. Never fabricates source_page/source_location: both OCR providers
// (services/ocr/*) discard bounding-box/geometry data when building
// OcrResult.pages, keeping only plain per-line text, and the extraction step
// (services/extraction/anthropicExtraction.ts) never reads providerRaw to
// recover it. source_location is therefore left null in practice; provenance
// resolution (routes/patients.ts provenanceFor) relies on source_page and
// source_snippet instead.
async function runOcr(
  document: any,
  file: File,
  documentType: (typeof DOCUMENT_TYPES)[number],
  actorId: string,
  patientName: string | null,
): Promise<any> {
  try {
    let result: OcrResult;
    // Reuse OCR text only within the same patient: two patients uploading byte-identical form PDFs must never see
    // each other's OCR text.
    const [reusable] = document.file_sha256
      ? await sql`
          SELECT ocr_text_ref FROM documents
          WHERE patient_id = ${document.patient_id} AND file_sha256 = ${document.file_sha256}
            AND id != ${document.id} AND ocr_status = 'done' AND ocr_text_ref IS NOT NULL
          ORDER BY uploaded_at ASC LIMIT 1
        `
      : [];
    if (reusable) {
      result = await readOcrResult(reusable.ocr_text_ref);
    } else {
      const provider = getOcrProvider();
      const buffer = Buffer.from(await file.arrayBuffer());
      result = await provider.extractText(buffer, file.type);
    }
    const { file_ref: ocrTextRef } = await saveOcrResult(document.patient_id, document.id, result);

    const [updated] = await sql`
      UPDATE documents SET ocr_status = 'done', ocr_text_ref = ${ocrTextRef}
      WHERE id = ${document.id}
      RETURNING *
    `;

    await runExtraction(updated, documentType, result, actorId, patientName);

    // Re-fetch: runExtraction may have flipped needs_manual_date after the
    // row above was captured, and the response should reflect that.
    const [final] = await sql`
      SELECT *
      FROM documents WHERE id = ${document.id}
    `;
    return final;
  } catch (err) {
    console.error(`OCR failed for document ${document.id}:`, err);
    const [updated] = await sql`
      UPDATE documents SET ocr_status = 'failed'
      WHERE id = ${document.id}
      RETURNING *
    `;
    return updated;
  }
}

// Test-only: documents.test.ts exercises OCR reuse directly, since uploadDocument's multipart path can't inject a
// pre-existing same-hash document deterministically.
export const runOcrForTest = runOcr;

// Safety: the rule-based parser needs column structure, and plain OCR text (every upload is OCR'd today) often has
// none. A deterministic pass that found nothing (or a document type it does not handle) must never be recorded as
// "done, nothing extractable" -- the silent empty result the design forbids. It falls back to the LLM provider (tier T4
// of the spec), keeping the deterministic pass's header so the identity check still runs.
export async function extractWithFallback(
  ocr: OcrResult,
  documentType: DocumentType,
  primary: ExtractionProvider,
  // Lazy: the LLM provider is only resolved (and may be unconfigured) when a fallback is actually needed.
  llm: () => ExtractionProvider,
): Promise<ExtractionResult> {
  const first = await primary.extractFacts(ocr, documentType);
  if (primary.name !== "deterministic" || first.candidates.length > 0) return first;
  const second = await llm().extractFacts(ocr, documentType);
  return { ...second, header: second.header ?? first.header };
}

// docs/02 M2: "wire the LLM extraction client ... run after OCR completes."
// Runs the extraction pass and persists its output as FACT rows
// (services/facts.ts — tracked_marker_id resolution, coverage_status via
// the rules engine, audit logging). Extraction/persistence failure never
// affects the upload response or ocr_status (OCR already succeeded, and this
// is a downstream, independently retriable step) — but it is always recorded
// on the document as extraction_status, so "the pass failed" is never
// mistaken for "nothing extractable". `provider` exists so tests can inject
// one; it defaults to the env-configured provider, resolved inside the try so
// a missing/invalid EXTRACTION_PROVIDER is recorded as 'failed' too.
export async function runExtraction(
  document: any,
  documentType: (typeof DOCUMENT_TYPES)[number],
  ocr: OcrResult,
  actorId: string,
  patientName: string | null,
  provider?: ExtractionProvider,
): Promise<void> {
  try {
    const { candidates, failedFieldTypes, failureMessages, header } = await (provider
      ? provider.extractFacts(ocr, documentType)
      : extractWithFallback(ocr, documentType, getExtractionProvider(), getLlmExtractionProvider));
    // Nothing surviving only counts as 'failed' if a call actually failed;
    // an empty result with no failures is a legitimate "nothing extractable".
    const status =
      failedFieldTypes.length === 0 ? "done" : candidates.length > 0 ? "partial" : "failed";
    const error =
      status === "done"
        ? null
        : `Field type(s) failed: ${failedFieldTypes
            .map((f) => (failureMessages?.[f] ? `${f} (${failureMessages[f]})` : f))
            .join("; ")}`.slice(0, 1000);
    // Written inside persistExtractedFacts' own transaction now (D6), atomic
    // with the fact inserts it describes.
    const documentMetadata = header ? { header, identityStatus: matchIdentity(patientName, header.patientName).status } : null;
    const result = await persistExtractedFacts(document, candidates, actorId, { status, error }, documentMetadata);
    console.log(
      `Document ${document.id}: extraction ${status}, persisted ${result.createdFactIds.length} fact(s)` +
        (result.needsManualDate ? " (some need a manual as_of_date)." : "."),
    );
  } catch (err) {
    console.error(`Extraction failed for document ${document.id}:`, err);
    try {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      await sql`UPDATE documents SET extraction_status = 'failed', extraction_error = ${message} WHERE id = ${document.id}`;
    } catch (statusErr) {
      console.error(`Could not record extraction_status='failed' for document ${document.id}:`, statusErr);
    }
  }
}

// For the Source view (apps/web SourceView.tsx): document metadata plus its OCR text, so the
// screen can pick a page's text to search a fact's source_snippet against. providerRaw is
// dropped — it's internal OCR-vendor payload, never meant for the browser.
export async function getDocument(req: Request & { params: { id: string } }): Promise<Response> {
  const documentId = req.params.id;
  if (!isUuid(documentId)) return jsonError(404, "not_found", "Document not found.");

  const [document] = await sql`SELECT * FROM documents WHERE id = ${documentId}`;
  if (!document) return jsonError(404, "not_found", "Document not found.");

  let ocr: { fullText: string; pages: { pageNumber: number; text: string }[] } | null = null;
  if (document.ocr_text_ref) {
    try {
      const result = await readOcrResult(document.ocr_text_ref);
      ocr = { fullText: result.fullText, pages: result.pages };
    } catch (err) {
      console.error(`Could not read OCR result for document ${documentId}:`, err);
    }
  }

  return Response.json({ document, ocr });
}

// Streams the original uploaded file back, for the Source view to render (or probe for
// renderability — a non-ok response here is exactly the OCR-text-only fallback trigger).
export async function getDocumentFile(req: Request & { params: { id: string } }): Promise<Response> {
  const documentId = req.params.id;
  if (!isUuid(documentId)) return jsonError(404, "not_found", "Document not found.");

  const [document] = await sql`SELECT file_ref FROM documents WHERE id = ${documentId}`;
  if (!document) return jsonError(404, "not_found", "Document not found.");

  const file = documentFile(document.file_ref);
  if (!(await file.exists())) return jsonError(404, "not_found", "Document file is not available in storage.");

  return new Response(file, { headers: { "Content-Type": contentTypeForFileRef(document.file_ref) } });
}
