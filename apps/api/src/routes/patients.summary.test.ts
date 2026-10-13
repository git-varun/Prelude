import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientSummary } from "./patients";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

let staff: TestUser;
let patientId: string;
let visitId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "summary-route-staff");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-03-01') RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id);
});

async function newDocument(documentType: string, identity: string | null = null, pid = patientId, vid = visitId) {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status)
    VALUES (${pid}, ${vid}, 'local://t/x.pdf', ${documentType}::document_type, 'own_hospital', ${staff.id}, 'done', ${identity}::identity_status)
    RETURNING id`;
  return doc.id as string;
}

async function newFact(documentId: string, fieldType: string, value: string | null, asOf: string | null, extra: { facility?: string } = {}) {
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status,
      verification_state, source_page, source_snippet, facility)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${fieldType}::field_type, ${value}, ${asOf}, 'value_found',
      'unverified', 1, ${value}, ${extra.facility ?? null})
    RETURNING id`;
  return row.id as string;
}

function summaryReq(id: string) {
  const req = new Request(`http://localhost/patients/${id}/summary`) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

async function summary(id = patientId): Promise<any> {
  const res = await getPatientSummary(summaryReq(id));
  expect(res.status).toBe(200);
  return res.json();
}

test("404s for an unknown or malformed patient id", async () => {
  expect((await getPatientSummary(summaryReq("00000000-0000-0000-0000-000000000000"))).status).toBe(404);
  expect((await getPatientSummary(summaryReq("not-a-uuid"))).status).toBe(404);
});

test("empty patient returns empty sections", async () => {
  const fresh = await createTestPatient(staff.id);
  try {
    const body = await summary(fresh.id);
    expect(body.documents_count).toBe(0);
    expect(body.what_happened).toEqual([]);
    expect(body.disease_history).toEqual({ diagnosis: [], histology_ihc: [], stage: [] });
    expect(body.procedures).toEqual([]);
    expect(body.prescriptions).toEqual([]);
  } finally {
    await deleteTestPatients(fresh.id);
  }
});

test("what_happened is dated, restricted to the listed types, ascending, verbatim, skipping null values", async () => {
  const doc = await newDocument("pathology");
  const surgery = await newFact(doc, "surgery_procedure", "  Lt MRM + ALND ", "2026-01-10", { facility: "Apollo" });
  const diag = await newFact(doc, "diagnosis", "IDC Lt breast", "2025-12-01");
  await newFact(doc, "diagnosis", null, "2025-11-01");
  await newFact(doc, "tests_advised", "CT chest", "2026-01-12");
  await newFact(doc, "stage", "cT2N1", null);
  const body = await summary();
  const ids = body.what_happened.map((i: any) => i.fact_id);
  expect(ids).toEqual([diag, surgery]);
  expect(body.what_happened[1].text).toBe("  Lt MRM + ALND ");
  expect(body.what_happened[1].facility).toBe("Apollo");
  expect(body.what_happened[1].provenance.fallback_level).toBe("exact");
  expect(body.what_happened[1].verification_state).toBe("unverified");
  // undated stage still shows under disease history; null diagnosis never does
  expect(body.disease_history.stage.map((i: any) => i.text)).toEqual(["cT2N1"]);
  expect(body.disease_history.diagnosis.map((i: any) => i.text)).toEqual(["IDC Lt breast"]);
  expect(body.procedures.map((i: any) => i.fact_id)).toEqual([surgery]);
});

test("facts from a held (mismatch) or rejected document never appear", async () => {
  const before = await summary();
  for (const status of ["mismatch", "rejected"]) {
    const doc = await newDocument("pathology", status);
    await newFact(doc, "diagnosis", `held ${status}`, "2026-02-01");
  }
  const after = await summary();
  expect(after.what_happened).toEqual(before.what_happened);
  expect(after.disease_history.diagnosis).toEqual(before.disease_history.diagnosis);
  expect(after.documents_count).toBe(before.documents_count);
});

test("prescriptions group by prescription document, newest first, with max fact date", async () => {
  const older = await newDocument("prescription");
  const newer = await newDocument("prescription");
  const regOld = await newFact(older, "treatment_regimen", "Tab X 10mg", "2026-01-05");
  const regNew = await newFact(newer, "treatment_regimen", "Tab Y 20mg", "2026-02-20");
  const tests = await newFact(newer, "tests_advised", "CBC, LFT", "2026-02-22");
  const review = await newFact(newer, "next_review_date", "after 3 weeks", "2026-02-20");
  const body = await summary();
  const [first, second] = body.prescriptions;
  expect(body.prescriptions.length).toBe(2);
  expect(first.document_id).toBe(newer);
  expect(first.date).toBe("2026-02-22");
  expect(first.regimen.fact_id).toBe(regNew);
  expect(first.tests_advised.map((i: any) => i.fact_id)).toEqual([tests]);
  expect(first.next_review.fact_id).toBe(review);
  expect(second.document_id).toBe(older);
  expect(second.regimen.fact_id).toBe(regOld);
  expect(second.next_review).toBeNull();
  expect(second.tests_advised).toEqual([]);
});
