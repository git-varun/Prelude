import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { signOffFact, checkFactRoute } from "./facts";
import { getPatientSummary } from "./patients";
import { getPatientPlan } from "./plan";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

// M3 x spot-check reconcile: excluded facts leave Summary and Plan; tier-1 facts can be checked; error options per type.
let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitId: string;
let docId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "m3sc-staff");
  oncologist = await createTestUser("oncologist", "m3sc-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: docId }] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'prescription', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newFact(fieldType: string, value: string, asOf = "2034-01-01") {
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, source_page, source_snippet)
    VALUES (${patientId}, ${visitId}, ${docId}, ${fieldType}::field_type, ${value}, ${asOf}, 'value_found', 'unverified', 1, ${value})
    RETURNING id`;
  return row.id as string;
}
function req(url: string, id: string, body?: unknown) {
  const r = new Request(url, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) as Request & { params: { id: string } };
  r.params = { id };
  return r;
}
const check = (id: string, body: unknown) => checkFactRoute(req("http://localhost/c", id, body), asAuthedUser(staff));

test("Summary excludes a spot-check-excluded fact", async () => {
  const keep = await newFact("diagnosis", "kept dx");
  const drop = await newFact("diagnosis", "excluded dx");
  await sql`UPDATE facts SET check_state = 'incorrect', error_type = 'not_in_document', excluded_at = now() WHERE id = ${drop}`;
  const s: any = await (await getPatientSummary(req("http://localhost/s", patientId))).json();
  const ids = [...s.what_happened, ...s.disease_history.diagnosis].map((i: any) => i.fact_id);
  expect(ids).toContain(keep);
  expect(ids).not.toContain(drop);
});

test("Plan drops the item of a spot-check-excluded source fact", async () => {
  const f = await newFact("tests_advised", "Excluded later in 2 weeks");
  expect((await check(f, { result: "correct" })).status).toBe(200);
  expect((await signOffFact(req("http://localhost/so", f), asAuthedUser(oncologist))).status).toBe(200);
  const texts = async () => ((await (await getPatientPlan(req("http://localhost/p", patientId))).json()) as any).items.map((i: any) => i.text);
  expect(await texts()).toContain("Excluded later in 2 weeks");
  await sql`UPDATE facts SET check_state = 'incorrect', error_type = 'wrong_patient', excluded_at = now() WHERE id = ${f}`;
  expect(await texts()).not.toContain("Excluded later in 2 weeks");
});

test("a tier-1 non-marker fact with content may be marked correct", async () => {
  const f = await newFact("histology_ihc", "ER positive 90%");
  const res = await check(f, { result: "correct" });
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).check_state).toBe("correct");
});

test("error_type is validated against the fact type; facility corrects a surgery fact", async () => {
  const diag = await newFact("diagnosis", "IDC");
  expect((await check(diag, { result: "incorrect", error_type: "facility", correction: { facility: "X" } })).status).toBe(400);
  expect((await check(diag, { result: "incorrect", error_type: "unit", correction: { unit: "mg" } })).status).toBe(400);

  const surg = await newFact("surgery_procedure", "Lt MRM");
  const res = await check(surg, { result: "incorrect", error_type: "facility", correction: { facility: "Apollo" } });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(body).toMatchObject({ check_state: "incorrect", error_type: "facility" });
  const [row] = await sql`SELECT facility FROM facts WHERE id = ${surg}`;
  expect(row.facility).toBe("Apollo");
});
