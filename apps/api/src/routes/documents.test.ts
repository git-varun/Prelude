import { test, expect, beforeAll, afterAll } from "bun:test";
import { uploadDocument } from "./documents";
import { createOrOpenVisit } from "./visits";
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
  expect(body.ocr_status).toBe("pending");
});
