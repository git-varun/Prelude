import { test, expect, beforeAll, afterAll } from "bun:test";
import { createOrOpenVisit } from "./visits";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
let patientId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "visits-test-staff");
  patientId = (await createTestPatient(staff.id)).id;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id);
});

function visitRequest(body: unknown = {}): Request & { params: { id: string } } {
  const req = new Request(`http://localhost/patients/${patientId}/visits`, {
    method: "POST",
    body: JSON.stringify(body),
  }) as Request & { params: { id: string } };
  req.params = { id: patientId };
  return req;
}

test("createOrOpenVisit 404s for an unknown patient", async () => {
  const req = new Request("http://localhost/patients/x/visits", { method: "POST", body: "" }) as Request & {
    params: { id: string };
  };
  req.params = { id: "00000000-0000-0000-0000-000000000000" };
  const res = await createOrOpenVisit(req, asAuthedUser(staff));
  expect(res.status).toBe(404);
});

test("createOrOpenVisit creates a visit for today by default", async () => {
  const res = await createOrOpenVisit(visitRequest(), asAuthedUser(staff));
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  expect(body.patient_id).toBe(patientId);
});

test("createOrOpenVisit is idempotent for the same patient/date", async () => {
  const first = await createOrOpenVisit(visitRequest({ visit_date: "2026-01-15" }), asAuthedUser(staff));
  const firstBody = (await first.json()) as any;
  expect(first.status).toBe(201);

  const second = await createOrOpenVisit(visitRequest({ visit_date: "2026-01-15" }), asAuthedUser(staff));
  const secondBody = (await second.json()) as any;
  expect(second.status).toBe(200);
  expect(secondBody.id).toBe(firstBody.id);
});

test("createOrOpenVisit rejects malformed JSON", async () => {
  const req = new Request(`http://localhost/patients/${patientId}/visits`, {
    method: "POST",
    body: "{not json",
  }) as Request & { params: { id: string } };
  req.params = { id: patientId };
  const res = await createOrOpenVisit(req, asAuthedUser(staff));
  expect(res.status).toBe(400);
});
