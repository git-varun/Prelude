import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getDocument, getDocumentFile } from "./documents";
import { saveDocumentFile, saveOcrResult } from "../services/storage";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

let staff: TestUser;
let patientId: string;
let visitId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "documents-source-staff");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id);
});

function getReq(id: string) {
  const req = new Request(`http://localhost/documents/${id}`) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

async function newDocument(fileRef: string, ocrTextRef: string | null): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, ocr_text_ref)
    VALUES (${patientId}, ${visitId}, ${fileRef}, 'radiology', 'own_hospital', ${staff.id}, 'done', ${ocrTextRef}) RETURNING id`;
  return doc.id;
}

test("getDocument 404s for an unknown or malformed document id", async () => {
  expect((await getDocument(getReq("00000000-0000-0000-0000-000000000000"))).status).toBe(404);
  expect((await getDocument(getReq("not-a-uuid"))).status).toBe(404);
});

test("getDocument returns the document plus its OCR text (minus providerRaw) when ocr_text_ref is set", async () => {
  const { file_ref } = await saveDocumentFile(patientId, "scan.pdf", new Blob(["pdf bytes"]));
  const docId = await newDocument(file_ref, null);
  const { file_ref: ocrRef } = await saveOcrResult(patientId, docId, {
    fullText: "page one\n\npage two",
    pages: [{ pageNumber: 1, text: "page one" }, { pageNumber: 2, text: "page two" }],
    providerName: "test",
    providerRaw: { secret: "vendor payload" },
  });
  await sql`UPDATE documents SET ocr_text_ref = ${ocrRef} WHERE id = ${docId}`;

  const res = await getDocument(getReq(docId));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.document.id).toBe(docId);
  expect(body.ocr).toEqual({
    fullText: "page one\n\npage two",
    pages: [{ pageNumber: 1, text: "page one" }, { pageNumber: 2, text: "page two" }],
  });
  expect(body.ocr.providerRaw).toBeUndefined();
});

test("getDocument returns ocr: null when ocr_text_ref is null", async () => {
  const { file_ref } = await saveDocumentFile(patientId, "scan.pdf", new Blob(["pdf bytes"]));
  const docId = await newDocument(file_ref, null);

  const res = await getDocument(getReq(docId));
  const body = (await res.json()) as any;
  expect(body.ocr).toBeNull();
});

test("getDocumentFile 404s for an unknown or malformed document id", async () => {
  expect((await getDocumentFile(getReq("00000000-0000-0000-0000-000000000000"))).status).toBe(404);
  expect((await getDocumentFile(getReq("not-a-uuid"))).status).toBe(404);
});

test("getDocumentFile streams the stored bytes back with a content type inferred from the file extension", async () => {
  const { file_ref } = await saveDocumentFile(patientId, "scan.pdf", new Blob(["%PDF-1.4 fake pdf bytes"]));
  const docId = await newDocument(file_ref, null);

  const res = await getDocumentFile(getReq(docId));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/pdf");
  expect(await res.text()).toBe("%PDF-1.4 fake pdf bytes");
});

test("getDocumentFile 404s when the document row exists but its file is missing from storage", async () => {
  const docId = await newDocument("local://nonexistent/missing.pdf", null);

  const res = await getDocumentFile(getReq(docId));
  expect(res.status).toBe(404);
});
