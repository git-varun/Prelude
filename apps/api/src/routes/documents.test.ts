import { test, expect, beforeAll, afterAll } from "bun:test";
import { uploadDocument, runExtraction } from "./documents";
import type { ExtractedFactCandidate, ExtractionProvider } from "@opd/shared";
import { createOrOpenVisit } from "./visits";
import { sql } from "../db/client";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

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

async function newDocumentRow(): Promise<{ id: string; patient_id: string; visit_id: string }> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://test/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done')
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

function providerReturning(candidates: ExtractedFactCandidate[]): ExtractionProvider {
  return { name: "fake", extractFacts: async () => candidates };
}

async function extractionStatusOf(documentId: string): Promise<string> {
  const [row] = await sql`SELECT extraction_status FROM documents WHERE id = ${documentId}`;
  return row.extraction_status;
}

test("runExtraction marks the document 'done' and persists facts on success", async () => {
  const doc = await newDocumentRow();
  await runExtraction(doc, "blood", ocrResult, staff.id, providerReturning([datedCandidate()]));
  expect(await extractionStatusOf(doc.id)).toBe("done");
  const facts = await sql`SELECT id FROM facts WHERE document_id = ${doc.id}`;
  expect(facts).toHaveLength(1);
});

test("runExtraction marks the document 'done' when the pass legitimately finds nothing", async () => {
  const doc = await newDocumentRow();
  await runExtraction(doc, "blood", ocrResult, staff.id, providerReturning([]));
  expect(await extractionStatusOf(doc.id)).toBe("done");
});

test("runExtraction marks the document 'failed' when the extraction provider throws", async () => {
  const doc = await newDocumentRow();
  const failing: ExtractionProvider = {
    name: "fake",
    extractFacts: async () => {
      throw new Error("LLM API down");
    },
  };
  await runExtraction(doc, "blood", ocrResult, staff.id, failing);
  expect(await extractionStatusOf(doc.id)).toBe("failed");
});

test("runExtraction marks the document 'failed', with no partial facts, when persistence fails", async () => {
  const doc = await newDocumentRow();
  await runExtraction(
    doc,
    "blood",
    ocrResult,
    staff.id,
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
    await runExtraction(doc, "blood", ocrResult, staff.id);
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
