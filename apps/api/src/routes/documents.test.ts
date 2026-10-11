import { test, expect, beforeAll, afterAll } from "bun:test";
import { uploadDocument, runExtraction, runOcrForTest, extractWithFallback, setDocumentIdentityStatus } from "./documents";
import type { ExtractedFactCandidate, ExtractionProvider, FieldType } from "@prelude/shared";
import { createOrOpenVisit } from "./visits";
import { sql } from "../db/client";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

// Keep tests hermetic: a developer .env with real providers must not send dummy uploads to paid vendors.
delete process.env.OCR_PROVIDER;
delete process.env.EXTRACTION_PROVIDER;

let staff: TestUser;
let patientId: string;
let otherPatientId: string;
let visitId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "documents-test-staff");
  patientId = (await createTestPatient(staff.id)).id;
  otherPatientId = (await createTestPatient(staff.id)).id;

  const visitReq = new Request(`http://localhost/patients/${patientId}/visits`, {
    method: "POST",
    body: "",
  }) as Request & { params: { id: string } };
  visitReq.params = { id: patientId };
  const visitRes = await createOrOpenVisit(visitReq, asAuthedUser(staff));
  visitId = ((await visitRes.json()) as any).id;
});

afterAll(async () => {
  await deleteTestPatients(patientId, otherPatientId);
  await deleteTestUsers(staff.id);
});

function uploadRequest(form: FormData): Request & { params: { id: string } } {
  const req = new Request(`http://localhost/patients/${patientId}/documents`, {
    method: "POST",
    body: form,
  }) as Request & { params: { id: string } };
  req.params = { id: patientId };
  return req;
}

test("uploadDocument 404s for an unknown patient", async () => {
  const form = new FormData();
  const req = new Request("http://localhost/patients/x/documents", { method: "POST", body: form }) as Request & {
    params: { id: string };
  };
  req.params = { id: "00000000-0000-0000-0000-000000000000" };
  const res = await uploadDocument(req, asAuthedUser(staff));
  expect(res.status).toBe(404);
});

test("uploadDocument rejects an invalid document_type", async () => {
  const form = new FormData();
  form.set("visit_id", visitId);
  form.set("document_type", "xray");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
  const res = await uploadDocument(uploadRequest(form), asAuthedUser(staff));
  expect(res.status).toBe(400);
});

test("uploadDocument requires imaging_modality when document_type is radiology", async () => {
  const form = new FormData();
  form.set("visit_id", visitId);
  form.set("document_type", "radiology");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
  const res = await uploadDocument(uploadRequest(form), asAuthedUser(staff));
  expect(res.status).toBe(400);
});

test("uploadDocument rejects an invalid imaging_modality value", async () => {
  const form = new FormData();
  form.set("visit_id", visitId);
  form.set("document_type", "radiology");
  form.set("imaging_modality", "x_ray_old_machine");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
  const res = await uploadDocument(uploadRequest(form), asAuthedUser(staff));
  expect(res.status).toBe(400);
});

test("uploadDocument persists imaging_modality for a radiology document", async () => {
  const form = new FormData();
  form.set("visit_id", visitId);
  form.set("document_type", "radiology");
  form.set("imaging_modality", "pet_ct");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
  const res = await uploadDocument(uploadRequest(form), asAuthedUser(staff));
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.imaging_modality).toBe("pet_ct");
});

test("uploadDocument ignores imaging_modality for a non-radiology document", async () => {
  const form = new FormData();
  form.set("visit_id", visitId);
  form.set("document_type", "blood");
  form.set("imaging_modality", "ct");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
  const res = await uploadDocument(uploadRequest(form), asAuthedUser(staff));
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.imaging_modality).toBeNull();
});

test("uploadDocument rejects an unsupported file type", async () => {
  const form = new FormData();
  form.set("visit_id", visitId);
  form.set("document_type", "blood");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.exe", { type: "application/x-msdownload" }));
  const res = await uploadDocument(uploadRequest(form), asAuthedUser(staff));
  expect(res.status).toBe(400);
});

test("uploadDocument rejects a visit that belongs to a different patient", async () => {
  const form = new FormData();
  form.set("visit_id", visitId); // belongs to `patientId`, not `otherPatientId`
  form.set("document_type", "blood");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
  const req = new Request(`http://localhost/patients/${otherPatientId}/documents`, {
    method: "POST",
    body: form,
  }) as Request & { params: { id: string } };
  req.params = { id: otherPatientId };
  const res = await uploadDocument(req, asAuthedUser(staff));
  expect(res.status).toBe(404);
});

test("uploadDocument succeeds for a valid PDF against the right visit", async () => {
  const form = new FormData();
  form.set("visit_id", visitId);
  form.set("document_type", "blood");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
  const res = await uploadDocument(uploadRequest(form), asAuthedUser(staff));
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.visit_id).toBe(visitId);
  // No OCR_PROVIDER is configured in the test environment, so the inline
  // OCR step (documents.ts's runOcr) fails closed to 'failed' rather than
  // leaving the row stuck on 'pending' or throwing out of the upload.
  expect(body.ocr_status).toBe("failed");
});

test("uploadDocument writes an audit_log row for the upload", async () => {
  const form = new FormData();
  form.set("visit_id", visitId);
  form.set("document_type", "blood");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
  const res = await uploadDocument(uploadRequest(form), asAuthedUser(staff));
  const body = (await res.json()) as any;

  const [auditRow] = await sql`SELECT * FROM audit_log WHERE entity_type = 'document' AND entity_id = ${body.id}`;
  expect(auditRow).toBeDefined();
  expect(auditRow.action).toBe("upload");
  expect(auditRow.actor_id).toBe(staff.id);
  const afterValue = JSON.parse(auditRow.after_value);
  expect(afterValue.id).toBe(body.id);
  expect(afterValue.patient_id).toBe(patientId);
});

async function newDocumentRow(
  overrides: Partial<{ file_sha256: string | null; ocr_status: string; identity_status: string }> = {},
): Promise<{ id: string; patient_id: string; visit_id: string }> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, file_sha256, identity_status)
    VALUES (
      ${patientId}, ${visitId}, 'local://test/x.pdf', 'blood', 'own_hospital', ${staff.id},
      ${overrides.ocr_status ?? "done"}, ${overrides.file_sha256 ?? null}, ${overrides.identity_status ?? null}::identity_status
    )
    RETURNING id, patient_id, visit_id
  `;
  return doc;
}

const ocrResult = { fullText: "x", pages: [], providerName: "test" };

function datedCandidate(overrides: Partial<ExtractedFactCandidate> = {}): ExtractedFactCandidate {
  return {
    fieldType: "radiology_impression",
    value: "Stable disease",
    unit: null,
    referenceRange: null,
    asOfDate: "2026-01-01",
    coverageStatus: "value_found",
    sourcePage: 1,
    sourceLocation: null,
    sourceSnippet: null,
    confidence: 0.9,
    ...overrides,
  };
}

function providerReturning(
  candidates: ExtractedFactCandidate[],
  failedFieldTypes: FieldType[] = [],
  failureMessages: Partial<Record<FieldType, string>> = {},
): ExtractionProvider {
  return { name: "fake", extractFacts: async () => ({ candidates, failedFieldTypes, failureMessages }) };
}

async function extractionErrorOf(documentId: string): Promise<string | null> {
  const [row] = await sql`SELECT extraction_error FROM documents WHERE id = ${documentId}`;
  return row.extraction_error;
}

async function extractionStatusOf(documentId: string): Promise<string> {
  const [row] = await sql`SELECT extraction_status FROM documents WHERE id = ${documentId}`;
  return row.extraction_status;
}

test("runExtraction marks the document 'done' and persists facts on success", async () => {
  const doc = await newDocumentRow();
  await runExtraction(doc, "blood", ocrResult, staff.id, null, providerReturning([datedCandidate()]));
  expect(await extractionStatusOf(doc.id)).toBe("done");
  const facts = await sql`SELECT id FROM facts WHERE document_id = ${doc.id}`;
  expect(facts).toHaveLength(1);
});

test("runExtraction marks the document 'done' when the pass legitimately finds nothing", async () => {
  const doc = await newDocumentRow();
  await runExtraction(doc, "blood", ocrResult, staff.id, null, providerReturning([]));
  expect(await extractionStatusOf(doc.id)).toBe("done");
});

test("runExtraction marks the document 'partial' (not 'done') when a field type failed but others survived", async () => {
  const doc = await newDocumentRow();
  await runExtraction(
    doc,
    "blood",
    ocrResult,
    staff.id,
    null,
    providerReturning([datedCandidate()], ["reference_range"], { reference_range: "LLM timeout" }),
  );
  expect(await extractionStatusOf(doc.id)).toBe("partial");
  const error = await extractionErrorOf(doc.id);
  expect(error).toContain("reference_range");
  expect(error).toContain("LLM timeout");
  const facts = await sql`SELECT id FROM facts WHERE document_id = ${doc.id}`;
  expect(facts).toHaveLength(1);
});

test("runExtraction marks the document 'failed' with an error when every field type failed and nothing survived", async () => {
  const doc = await newDocumentRow();
  await runExtraction(
    doc,
    "blood",
    ocrResult,
    staff.id,
    null,
    providerReturning([], ["marker_value", "reference_range"], { marker_value: "LLM API down" }),
  );
  expect(await extractionStatusOf(doc.id)).toBe("failed");
  const error = await extractionErrorOf(doc.id);
  expect(error).toContain("marker_value");
  expect(error).toContain("reference_range");
  expect(error).toContain("LLM API down");
});

test("runExtraction leaves extraction_error null on a clean 'done'", async () => {
  const doc = await newDocumentRow();
  await runExtraction(doc, "blood", ocrResult, staff.id, null, providerReturning([datedCandidate()]));
  expect(await extractionErrorOf(doc.id)).toBeNull();
});

test("runExtraction records the thrown error message when the provider throws", async () => {
  const doc = await newDocumentRow();
  const failing: ExtractionProvider = {
    name: "fake",
    extractFacts: async () => {
      throw new Error("provider exploded");
    },
  };
  await runExtraction(doc, "blood", ocrResult, staff.id, null, failing);
  expect(await extractionStatusOf(doc.id)).toBe("failed");
  expect(await extractionErrorOf(doc.id)).toContain("provider exploded");
});

test("runExtraction marks the document 'failed' when the extraction provider throws", async () => {
  const doc = await newDocumentRow();
  const failing: ExtractionProvider = {
    name: "fake",
    extractFacts: async () => {
      throw new Error("LLM API down");
    },
  };
  await runExtraction(doc, "blood", ocrResult, staff.id, null, failing);
  expect(await extractionStatusOf(doc.id)).toBe("failed");
});

test("runExtraction marks the document 'failed', with no partial facts, when persistence fails", async () => {
  const doc = await newDocumentRow();
  await runExtraction(
    doc,
    "blood",
    ocrResult,
    staff.id,
    null,
    providerReturning([datedCandidate(), datedCandidate({ asOfDate: "2026-13-45" })]),
  );
  expect(await extractionStatusOf(doc.id)).toBe("failed");
  const facts = await sql`SELECT id FROM facts WHERE document_id = ${doc.id}`;
  expect(facts).toHaveLength(0);
});

test("runExtraction marks the document 'failed' when no extraction provider is configured", async () => {
  const doc = await newDocumentRow();
  const saved = process.env.EXTRACTION_PROVIDER;
  delete process.env.EXTRACTION_PROVIDER;
  try {
    await runExtraction(doc, "blood", ocrResult, staff.id, null);
  } finally {
    if (saved !== undefined) process.env.EXTRACTION_PROVIDER = saved;
  }
  expect(await extractionStatusOf(doc.id)).toBe("failed");
});

test("uploadDocument leaves extraction_status 'pending' when OCR fails, since extraction never ran", async () => {
  const form = new FormData();
  form.set("visit_id", visitId);
  form.set("document_type", "blood");
  form.set("source_origin", "own_hospital");
  form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
  const res = await uploadDocument(uploadRequest(form), asAuthedUser(staff));
  const body = (await res.json()) as any;
  expect(body.ocr_status).toBe("failed");
  expect(body.extraction_status).toBe("pending");
});

test("uploadDocument stores a file_sha256 and two uploads of the same bytes for the same patient get the same hash", async () => {
  const bytes = "identical-content";
  const mk = (name: string) => {
    const form = new FormData();
    form.set("visit_id", visitId);
    form.set("document_type", "blood");
    form.set("source_origin", "own_hospital");
    form.set("file", new File([bytes], name, { type: "application/pdf" }));
    return form;
  };
  const docA = (await (await uploadDocument(uploadRequest(mk("a.pdf")), asAuthedUser(staff))).json()) as any;
  expect(docA.file_sha256).toMatch(/^[0-9a-f]{64}$/);
  const docB = (await (await uploadDocument(uploadRequest(mk("b.pdf")), asAuthedUser(staff))).json()) as any;
  expect(docB.file_sha256).toBe(docA.file_sha256);
});

test("runOcr reuses a same-patient, same-hash document's OCR result instead of calling the OCR provider again", async () => {
  const sha = "a".repeat(64);
  const existing = await newDocumentRow({ file_sha256: sha, ocr_status: "done" });
  const { saveOcrResult, readOcrResult } = await import("../services/storage");
  const { file_ref } = await saveOcrResult(patientId, existing.id, { fullText: "reused text", pages: [{ pageNumber: 1, text: "reused text" }], providerName: "test", providerRaw: null });
  await sql`UPDATE documents SET ocr_text_ref = ${file_ref} WHERE id = ${existing.id}`;

  const freshRef = await newDocumentRow({ file_sha256: sha, ocr_status: "pending" });
  const [fresh] = await sql`SELECT * FROM documents WHERE id = ${freshRef.id}`; // runOcr gets the full row in production
  const savedProvider = process.env.OCR_PROVIDER;
  const savedMode = process.env.EXTRACTION_MODE;
  process.env.EXTRACTION_MODE = "deterministic"; // OCR reuse is part of the deterministic mode only
  delete process.env.OCR_PROVIDER; // if reuse works, the (unconfigured) OCR provider is never called
  try {
    const updated = await runOcrForTest(fresh, new File(["anything"], "x.pdf", { type: "application/pdf" }), "blood", staff.id, null);
    expect(updated.ocr_status).toBe("done");
    const [{ ocr_text_ref }] = await sql`SELECT ocr_text_ref FROM documents WHERE id = ${updated.id}`;
    expect((await readOcrResult(ocr_text_ref)).fullText).toBe("reused text");
  } finally {
    if (savedProvider !== undefined) process.env.OCR_PROVIDER = savedProvider;
    if (savedMode === undefined) delete process.env.EXTRACTION_MODE; else process.env.EXTRACTION_MODE = savedMode;
  }
});

test("OCR reuse never crosses patients: the same hash on another patient's document is not reused", async () => {
  const sha = "b".repeat(64);
  const other = await createTestPatient(staff.id);
  const [otherVisit] = await sql`INSERT INTO visits (patient_id) VALUES (${other.id}) RETURNING id`;
  const [otherDoc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, ocr_text_ref, file_sha256)
    VALUES (${other.id}, ${otherVisit.id}, 'local://t/o.pdf', 'blood', 'own_hospital', ${staff.id}, 'done', NULL, ${sha})
    RETURNING id`;
  // A REAL stored OCR result: if reuse wrongly crossed patients it would succeed ('done'); correct scoping fails (no OCR provider).
  const { saveOcrResult } = await import("../services/storage");
  const { file_ref: otherOcrRef } = await saveOcrResult(other.id, otherDoc.id, { fullText: "other patient's text", pages: [{ pageNumber: 1, text: "other patient's text" }], providerName: "test", providerRaw: null });
  await sql`UPDATE documents SET ocr_text_ref = ${otherOcrRef} WHERE id = ${otherDoc.id}`;
  const freshRef = await newDocumentRow({ file_sha256: sha, ocr_status: "pending" });
  const [fresh] = await sql`SELECT * FROM documents WHERE id = ${freshRef.id}`;
  const savedProvider = process.env.OCR_PROVIDER;
  const savedMode = process.env.EXTRACTION_MODE;
  process.env.EXTRACTION_MODE = "deterministic";
  delete process.env.OCR_PROVIDER; // no reuse -> the unconfigured OCR provider is called -> OCR fails, recorded as 'failed'
  try {
    const updated = await runOcrForTest(fresh, new File(["x"], "x.pdf", { type: "application/pdf" }), "blood", staff.id, null);
    expect(updated.ocr_status).toBe("failed");
  } finally {
    if (savedProvider !== undefined) process.env.OCR_PROVIDER = savedProvider;
    if (savedMode === undefined) delete process.env.EXTRACTION_MODE; else process.env.EXTRACTION_MODE = savedMode;
    await sql`DELETE FROM documents WHERE id = ${otherDoc.id}`;
    await deleteTestPatients(other.id);
  }
});

test("runExtraction computes identity_status against the patient's name and writes header fields onto the document", async () => {
  const doc = await newDocumentRow();
  const provider: ExtractionProvider = {
    name: "fake-deterministic",
    extractFacts: async () => ({
      candidates: [datedCandidate()],
      failedFieldTypes: [],
      header: { labName: "Synthetic Labs", collectedOn: "2026-04-08", receivedOn: null, reportedOn: null, patientName: "Test Patient", labPatientRef: "L1" },
    }),
  };
  await runExtraction(doc, "blood", ocrResult, staff.id, "Test Patient", provider);
  const [row] = await sql`SELECT identity_status, lab_name FROM documents WHERE id = ${doc.id}`;
  expect(row).toMatchObject({ identity_status: "matched", lab_name: "Synthetic Labs" });
});

test("runExtraction holds a document (identity_status = 'mismatch') when the report's printed name doesn't match the patient", async () => {
  const doc = await newDocumentRow();
  const provider: ExtractionProvider = {
    name: "fake-deterministic",
    extractFacts: async () => ({
      candidates: [],
      failedFieldTypes: [],
      header: { labName: null, collectedOn: null, receivedOn: null, reportedOn: null, patientName: "Someone Else Entirely", labPatientRef: null },
    }),
  };
  await runExtraction(doc, "blood", ocrResult, staff.id, "Test Patient", provider);
  const [row] = await sql`SELECT identity_status FROM documents WHERE id = ${doc.id}`;
  expect(row.identity_status).toBe("mismatch");
});

test("extractWithFallback: a deterministic pass with zero candidates falls back to the LLM, keeping the deterministic header", async () => {
  let llmCalls = 0;
  const header = { labName: "Synthetic Labs", collectedOn: null, receivedOn: null, reportedOn: null, patientName: "Test Patient", labPatientRef: null };
  const deterministic: ExtractionProvider = { name: "deterministic", extractFacts: async () => ({ candidates: [], failedFieldTypes: [], stats: { rows: 0, unplacedNumericLines: 0, lines: 5 }, header }) };
  const llm: ExtractionProvider = { name: "llm", extractFacts: async () => { llmCalls++; return { candidates: [datedCandidate()], failedFieldTypes: [] }; } };
  const out = await extractWithFallback(ocrResult, "blood", deterministic, () => llm);
  expect(llmCalls).toBe(1);
  expect(out.candidates).toHaveLength(1);
  expect(out.header).toEqual(header);
});

test("extractWithFallback: a deterministic pass that found facts is used as is, and a non-deterministic provider never falls back", async () => {
  let llmCalls = 0;
  const llm: ExtractionProvider = { name: "llm", extractFacts: async () => { llmCalls++; return { candidates: [datedCandidate()], failedFieldTypes: [] }; } };
  const found: ExtractionProvider = { name: "deterministic", extractFacts: async () => ({ candidates: [datedCandidate(), datedCandidate({ value: "9" })], failedFieldTypes: [] }) };
  expect((await extractWithFallback(ocrResult, "blood", found, () => llm)).candidates).toHaveLength(2);
  const emptyLlm: ExtractionProvider = { name: "anthropic", extractFacts: async () => ({ candidates: [], failedFieldTypes: [] }) };
  expect((await extractWithFallback(ocrResult, "blood", emptyLlm, () => llm)).candidates).toHaveLength(0);
  expect(llmCalls).toBe(0);
});

test("extractWithFallback does not resolve the LLM provider unless a fallback is needed", async () => {
  const found: ExtractionProvider = { name: "deterministic", extractFacts: async () => ({ candidates: [datedCandidate()], failedFieldTypes: [] }) };
  const out = await extractWithFallback(ocrResult, "blood", found, () => {
    throw new Error("LLM provider must not be resolved");
  });
  expect(out.candidates).toHaveLength(1);
});

test("setDocumentIdentityStatus 404s for an unknown document", async () => {
  const req = new Request("http://localhost/documents/x/identity", { method: "POST", body: JSON.stringify({ action: "confirm" }) }) as Request & { params: { id: string } };
  req.params = { id: "00000000-0000-0000-0000-000000000000" };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(404);
});

test("setDocumentIdentityStatus rejects an action other than confirm/reject", async () => {
  const doc = await newDocumentRow({ identity_status: "mismatch" });
  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "ignore" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(400);
});

test("setDocumentIdentityStatus 409s when the document isn't currently held (identity_status != 'mismatch')", async () => {
  const doc = await newDocumentRow({ identity_status: "matched" });
  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "confirm" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(409);
});

test("confirm moves a held document to 'confirmed' and logs an audit_log row", async () => {
  const doc = await newDocumentRow({ identity_status: "mismatch" });
  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "confirm" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(200);
  const [row] = await sql`SELECT identity_status FROM documents WHERE id = ${doc.id}`;
  expect(row.identity_status).toBe("confirmed");
  const [audit] = await sql`SELECT action FROM audit_log WHERE entity_type = 'document' AND entity_id = ${doc.id} AND action = 'confirm_identity'`;
  expect(audit).toBeTruthy();
});

test("reject moves a held document to 'rejected'", async () => {
  const doc = await newDocumentRow({ identity_status: "mismatch" });
  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "reject" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  const res = await setDocumentIdentityStatus(req, asAuthedUser(staff));
  expect(res.status).toBe(200);
  const [row] = await sql`SELECT identity_status FROM documents WHERE id = ${doc.id}`;
  expect(row.identity_status).toBe("rejected");
});

test("confirming a held document detects conflicts for its now-live facts; the held persist created none", async () => {
  const doc = await newDocumentRow({ identity_status: "mismatch" });
  const [d] = await sql`SELECT patient_id, visit_id FROM documents WHERE id = ${doc.id}`;
  const [marker] = await sql`INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${d.patient_id}, 'CEA', false, ${staff.id}) RETURNING id`;
  const [liveDoc] = await sql`INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status) VALUES (${d.patient_id}, ${d.visit_id}, 'local://t/live.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  const ins = (documentId: string, value: string) => sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, as_of_date, coverage_status, verification_state)
    VALUES (${d.patient_id}, ${d.visit_id}, ${documentId}, ${marker.id}, 'marker_value', ${value}, 'ng/mL', '2026-05-01', 'value_found', 'unverified') RETURNING id`;
  const [live] = await ins(liveDoc.id, "4.2");
  const [held] = await ins(doc.id, "9.0");
  const before = await sql`SELECT id FROM conflicts WHERE fact_id_a IN (${live.id}, ${held.id}) OR fact_id_b IN (${live.id}, ${held.id})`;
  expect(before).toHaveLength(0);

  const req = new Request(`http://localhost/documents/${doc.id}/identity`, { method: "POST", body: JSON.stringify({ action: "confirm" }) }) as Request & { params: { id: string } };
  req.params = { id: doc.id };
  expect((await setDocumentIdentityStatus(req, asAuthedUser(staff))).status).toBe(200);
  const after = await sql`SELECT id FROM conflicts WHERE fact_id_a IN (${live.id}, ${held.id}) OR fact_id_b IN (${live.id}, ${held.id})`;
  expect(after.length).toBeGreaterThan(0);
});

// ---- fallback and OCR-reuse safety (review C4, I6) ----

const llmCandidate = () => datedCandidate({ trackedMarkerLabel: "CEA", value: "3.1" });
const stats = (rows: number, unplaced: number) => ({ rows, unplacedNumericLines: unplaced, lines: rows + unplaced + 5 });
const detProvider = (candidates: ExtractedFactCandidate[], st: { rows: number; unplacedNumericLines: number; lines: number }): ExtractionProvider => ({
  name: "deterministic",
  extractFacts: async () => ({ candidates, failedFieldTypes: [], stats: st, header: { labName: null, collectedOn: null, receivedOn: null, reportedOn: null, patientName: "Test Patient", labPatientRef: null } }),
});

test("extractWithFallback: a PARTIAL parse (many unplaced numeric lines) escalates to the LLM instead of recording a complete 'done'", async () => {
  let llmCalls = 0;
  const llm: ExtractionProvider = { name: "llm", extractFacts: async () => { llmCalls++; return { candidates: [llmCandidate(), datedCandidate()], failedFieldTypes: [] }; } };
  const out = await extractWithFallback(ocrResult, "blood", detProvider([datedCandidate()], stats(1, 4)), () => llm);
  expect(llmCalls).toBe(1);
  expect(out.candidates).toHaveLength(2);
  expect(out.header?.patientName).toBe("Test Patient");
});

test("extractWithFallback: a few benign unplaced lines on a well-parsed document do not trigger the LLM", async () => {
  let llmCalls = 0;
  const llm: ExtractionProvider = { name: "llm", extractFacts: async () => { llmCalls++; return { candidates: [], failedFieldTypes: [] }; } };
  const rows = Array.from({ length: 80 }, () => datedCandidate());
  const out = await extractWithFallback(ocrResult, "blood", detProvider(rows, stats(80, 10)), () => llm);
  expect(llmCalls).toBe(0);
  expect(out.candidates).toHaveLength(80);
});

test("extractWithFallback: if the LLM fallback throws, the deterministic result (and header) is kept and the gap is recorded as a failure, not lost", async () => {
  const llm: ExtractionProvider = { name: "llm", extractFacts: async () => { throw new Error("LLM down"); } };
  const out = await extractWithFallback(ocrResult, "blood", detProvider([datedCandidate()], stats(1, 4)), () => llm);
  expect(out.candidates).toHaveLength(1);
  expect(out.failedFieldTypes.length).toBeGreaterThan(0);
  expect(JSON.stringify(out.failureMessages)).toContain("LLM down");
  expect(out.header?.patientName).toBe("Test Patient");
});

test("extractWithFallback: an LLM that finds nothing does not discard what the deterministic pass found", async () => {
  const llm: ExtractionProvider = { name: "llm", extractFacts: async () => ({ candidates: [], failedFieldTypes: [] }) };
  const out = await extractWithFallback(ocrResult, "blood", detProvider([datedCandidate()], stats(1, 4)), () => llm);
  expect(out.candidates).toHaveLength(1);
});

test("OCR reuse is off in the default (llm) mode: the same bytes re-uploaded run OCR again", async () => {
  const sha = "c".repeat(64);
  const existing = await newDocumentRow({ file_sha256: sha, ocr_status: "done" });
  const { saveOcrResult } = await import("../services/storage");
  const { file_ref } = await saveOcrResult(patientId, existing.id, { fullText: "t", pages: [{ pageNumber: 1, text: "t" }], providerName: "test", providerRaw: null });
  await sql`UPDATE documents SET ocr_text_ref = ${file_ref} WHERE id = ${existing.id}`;
  const freshRef = await newDocumentRow({ file_sha256: sha, ocr_status: "pending" });
  const [fresh] = await sql`SELECT * FROM documents WHERE id = ${freshRef.id}`;
  const savedProvider = process.env.OCR_PROVIDER;
  const savedMode = process.env.EXTRACTION_MODE;
  delete process.env.OCR_PROVIDER;
  delete process.env.EXTRACTION_MODE;
  try {
    const updated = await runOcrForTest(fresh, new File(["x"], "x.pdf", { type: "application/pdf" }), "blood", staff.id, null);
    expect(updated.ocr_status).toBe("failed"); // reuse would have made this 'done'
  } finally {
    if (savedProvider !== undefined) process.env.OCR_PROVIDER = savedProvider;
    if (savedMode !== undefined) process.env.EXTRACTION_MODE = savedMode;
  }
});
