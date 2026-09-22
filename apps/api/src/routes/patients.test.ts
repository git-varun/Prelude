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
