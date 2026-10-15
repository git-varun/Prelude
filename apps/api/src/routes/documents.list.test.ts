import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { listPatientDocuments } from "./documents";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

// M3-11: the document pane's tree. Rejected documents are not listed; file_ref never leaves the API.
let staff: TestUser;
let patientId: string;
let visitId: string;

const list = (id: string) => listPatientDocuments(Object.assign(new Request(`http://localhost/patients/${id}/documents`), { params: { id } }));

async function newDoc(type: string, origin: string, identity: string | null, extra: { lab?: string; encounter?: string } = {}) {
  const [d] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status, lab_name, outside_encounter_id, collected_on)
    VALUES (${patientId}, ${visitId}, 'local://t/secret.pdf', ${type}, ${origin}, ${staff.id}, 'done', ${identity}::identity_status, ${extra.lab ?? null}, ${extra.encounter ?? null}, '2026-02-01')
    RETURNING id`;
  return d.id as string;
}

beforeAll(async () => {
  staff = await createTestUser("staff", "docs-list-staff");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-03-01') RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id);
});

test("404 for an unknown or malformed patient id", async () => {
  expect((await list("00000000-0000-0000-0000-000000000000")).status).toBe(404);
  expect((await list("nope")).status).toBe(404);
});

test("lists every document except rejected ones, with the outside facility and without file_ref", async () => {
  const [enc] = await sql`INSERT INTO outside_encounters (patient_id, encounter_date, facility, confirmed_by) VALUES (${patientId}, '2026-02-20', 'Apollo', ${staff.id}) RETURNING id`;
  const kept = await newDoc("blood", "own_hospital", null, { lab: "Metro Labs" });
  const held = await newDoc("radiology", "outside_cd", "mismatch", { encounter: enc!.id });
  const rejected = await newDoc("blood", "own_hospital", "rejected");

  const body = (await (await list(patientId)).json()) as { documents: any[] };
  const ids = body.documents.map((d) => d.id);
  expect(ids).toContain(kept);
  expect(ids).toContain(held);
  expect(ids).not.toContain(rejected);
  const keptRow = body.documents.find((d) => d.id === kept);
  expect(keptRow).toMatchObject({ document_type: "blood", lab_name: "Metro Labs", collected_on: "2026-02-01", has_text: false, outside_facility: null });
  expect(body.documents.find((d) => d.id === held)).toMatchObject({ identity_status: "mismatch", outside_facility: "Apollo" });
  expect(JSON.stringify(body)).not.toContain("secret.pdf");
});
