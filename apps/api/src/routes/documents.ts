import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import { deleteDocumentFile, saveDocumentFile } from "../services/storage";

const DOCUMENT_TYPES = ["prescription", "blood", "radiology"] as const;
const SOURCE_ORIGINS = ["own_hospital", "outside_paper", "outside_cd", "whatsapp_pdf"] as const;

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

  const [patient] = await sql`SELECT id FROM patients WHERE id = ${patientId}`;
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

  const { file_ref } = await saveDocumentFile(patientId, file.name, file);

  let document;
  try {
    [document] = await sql`
      INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
      VALUES (${patientId}, ${visitId}, ${file_ref}, ${documentType}, ${sourceOrigin}, ${user.id}, 'pending')
      RETURNING id, patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, uploaded_at, ocr_status, ocr_text_ref
    `;
  } catch (err) {
    // m1-backlog B4: don't orphan the file already written to storage if the
    // DB insert fails.
    await deleteDocumentFile(file_ref);
    throw err;
  }

  return Response.json(document, { status: 201 });
}
