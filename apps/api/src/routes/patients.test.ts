import { test, expect, beforeAll, afterAll } from "bun:test";
import { createPatient, listPatients, getPatient, addMarker } from "./patients";
import { createTestUser, deleteTestUsers, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
const patientIds: string[] = [];

beforeAll(async () => {
  staff = await createTestUser("staff", "patients-test-staff");
});

afterAll(async () => {
  await deleteTestPatients(...patientIds);
  await deleteTestUsers(staff.id);
});

function jsonRequest(body: unknown): Request {
  return new Request("http://localhost/patients", { method: "POST", body: JSON.stringify(body) });
}

test("createPatient creates a patient with controlled and custom markers", async () => {
  const res = await createPatient(
    jsonRequest({ name: "Alice", cancer_type: "Breast", markers: [{ marker_name: "CEA" }, { marker_name: "Not-A-Real-Marker" }] }),
    asAuthedUser(staff),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  patientIds.push(body.id);
  expect(body.tracked_markers).toHaveLength(2);
  expect(body.tracked_markers.find((m: any) => m.marker_name === "CEA").is_custom).toBe(false);
  expect(body.tracked_markers.find((m: any) => m.marker_name === "Not-A-Real-Marker").is_custom).toBe(true);
});

test("createPatient rejects a marker with no marker_name", async () => {
  const res = await createPatient(jsonRequest({ name: "Bob", markers: [{}] }), asAuthedUser(staff));
  expect(res.status).toBe(400);
});

test("createPatient rejects malformed JSON", async () => {
  const req = new Request("http://localhost/patients", { method: "POST", body: "{not json" });
  const res = await createPatient(req, asAuthedUser(staff));
  expect(res.status).toBe(400);
});

test("getPatient 404s for an unknown id", async () => {
  const req = new Request("http://localhost/patients/00000000-0000-0000-0000-000000000000") as Request & {
    params: { id: string };
  };
  req.params = { id: "00000000-0000-0000-0000-000000000000" };
  const res = await getPatient(req);
  expect(res.status).toBe(404);
});

test("getPatient returns the patient with its tracked markers", async () => {
  const createRes = await createPatient(jsonRequest({ name: "Carol", markers: [{ marker_name: "PSA" }] }), asAuthedUser(staff));
  const created = (await createRes.json()) as any;
  patientIds.push(created.id);

  const req = new Request(`http://localhost/patients/${created.id}`) as Request & { params: { id: string } };
  req.params = { id: created.id };
  const res = await getPatient(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.name).toBe("Carol");
  expect(body.tracked_markers).toHaveLength(1);
});

test("addMarker 404s for an unknown patient", async () => {
  const req = new Request("http://localhost/patients/x/markers", {
    method: "POST",
    body: JSON.stringify({ marker_name: "CEA" }),
  }) as Request & { params: { id: string } };
  req.params = { id: "00000000-0000-0000-0000-000000000000" };
  const res = await addMarker(req, asAuthedUser(staff));
  expect(res.status).toBe(404);
});

test("addMarker adds a marker to an existing patient", async () => {
  const createRes = await createPatient(jsonRequest({ name: "Dan", markers: [] }), asAuthedUser(staff));
  const created = (await createRes.json()) as any;
  patientIds.push(created.id);

  const req = new Request(`http://localhost/patients/${created.id}/markers`, {
    method: "POST",
    body: JSON.stringify({ marker_name: "CA-125" }),
  }) as Request & { params: { id: string } };
  req.params = { id: created.id };
  const res = await addMarker(req, asAuthedUser(staff));
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.marker_name).toBe("CA-125");
  expect(body.is_custom).toBe(false);
});

test("listPatients supports search", async () => {
  const createRes = await createPatient(jsonRequest({ name: "Zebra Unique Name", markers: [] }), asAuthedUser(staff));
  const created = (await createRes.json()) as any;
  patientIds.push(created.id);

  const res = await listPatients(new Request("http://localhost/patients?search=Zebra%20Unique"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any[];
  expect(body.some((p) => p.id === created.id)).toBe(true);
});

test("listPatients respects limit and offset", async () => {
  const res = await listPatients(new Request("http://localhost/patients?limit=1&offset=0"));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any[];
  expect(body.length).toBeLessThanOrEqual(1);
});

test("listPatients unchecked_fact_count counts unchecked live facts on the latest visit only", async () => {
  const { sql } = await import("../db/client");
  const { createTestPatient } = await import("../test-helpers");
  const pid = (await createTestPatient(staff.id)).id;
  patientIds.push(pid);
  const [{ id: oldVisit }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${pid}, '2026-01-01') RETURNING id`;
  const [{ id: visit }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${pid}, '2026-02-01') RETURNING id`;
  const mkDoc = async (v: string, identity: string) => (await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status)
    VALUES (${pid}, ${v}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done', ${identity}) RETURNING id`)[0]!.id as string;
  const mkFact = async (v: string, d: string, state: string, excluded = false) => (await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, check_state, error_type, excluded_at)
    VALUES (${pid}, ${v}, ${d}, 'radiology_impression', 'x', '2026-02-01', 'value_found', 'unverified', ${state},
            ${excluded ? "not_in_document" : null}, ${excluded ? sql`now()` : null}) RETURNING id`)[0]!.id as string;
  const okDoc = await mkDoc(visit, "matched");
  const heldDoc = await mkDoc(visit, "mismatch");
  const oldDoc = await mkDoc(oldVisit, "matched");
  const live1 = await mkFact(visit, okDoc, "unchecked");
  const live2 = await mkFact(visit, okDoc, "unchecked");
  await mkFact(visit, okDoc, "incorrect", true);
  await mkFact(visit, heldDoc, "unchecked");
  await mkFact(oldVisit, oldDoc, "unchecked");

  const count = async () => {
    const rows = (await (await listPatients(new Request("http://localhost/patients?search=Test%20Patient&limit=200"))).json()) as any[];
    return rows.find((p) => p.id === pid).unchecked_fact_count;
  };
  expect(await count()).toBe(2);
  await sql`UPDATE facts SET check_state = 'correct' WHERE id IN ${sql([live1, live2])}`;
  expect(await count()).toBe(0);
});
