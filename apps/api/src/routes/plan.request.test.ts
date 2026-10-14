import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientPlan, requestPlanItemReport, clearPlanItemReportRequest, setPlanItemMatch } from "./plan";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

// M3-09 interim for B7: the oncologist asks staff to find a report; staff clear the request.
let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let pastItem: string;
let seenItem: string;

const withId = (id: string) => Object.assign(new Request("http://localhost/x", { method: "POST" }), { params: { id } });
const request = (id: string, user = oncologist) => requestPlanItemReport(withId(id), asAuthedUser(user));
const clear = (id: string, user = staff) => clearPlanItemReportRequest(withId(id), asAuthedUser(user));
const planItem = async (id: string): Promise<any> => {
  const res = await getPatientPlan(Object.assign(new Request("http://localhost/p"), { params: { id: patientId } }));
  return ((await res.json()) as any).items.find((i: any) => i.id === id);
};

beforeAll(async () => {
  staff = await createTestUser("staff", "reqrep-staff");
  oncologist = await createTestUser("oncologist", "reqrep-onc");
  patientId = (await createTestPatient(staff.id)).id;
  const [{ id: visit }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  const [{ id: doc }] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visit}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  [{ id: pastItem }] = await sql`INSERT INTO care_plan_items (patient_id, type, text, advised_at, created_by) VALUES (${patientId}, 'test', 'Bone scan in 2 weeks', '2026-01-01', ${staff.id}) RETURNING id`;
  [{ id: seenItem }] = await sql`
    INSERT INTO care_plan_items (patient_id, type, text, advised_at, created_by, matched_document_id, match_confirmed_at)
    VALUES (${patientId}, 'test', 'Bone scan in 2 weeks', '2026-01-01', ${staff.id}, ${doc}, now()) RETURNING id`;
});

afterAll(async () => {
  await sql`DELETE FROM audit_log WHERE entity_type = 'care_plan_item' AND entity_id IN (${pastItem}, ${seenItem})`;
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

test("the oncologist's request is stored with who and when, shown on the plan item, and audited", async () => {
  expect((await planItem(pastItem)).report_request).toBeNull();
  const res = await request(pastItem);
  expect(res.status).toBe(200);
  const shown = await planItem(pastItem);
  expect(shown.status).toBe("past_advised");
  expect(shown.report_request).toMatchObject({ by_id: oncologist.id, by_name: "reqrep-onc" });
  expect(shown.report_request.at).toBeTruthy();
  const rows = await sql`SELECT actor_id, after_value FROM audit_log WHERE entity_type = 'care_plan_item' AND entity_id = ${pastItem} AND action = 'request_report'`;
  expect(rows).toHaveLength(1);
  expect(rows[0].actor_id).toBe(oncologist.id);
  expect(JSON.parse(rows[0].after_value).report_requested_by).toBe(oncologist.id);
});

test("staff clear the request (audited); clearing twice writes nothing more", async () => {
  expect((await clear(pastItem)).status).toBe(200);
  expect((await planItem(pastItem)).report_request).toBeNull();
  expect((await clear(pastItem)).status).toBe(200);
  const rows = await sql`SELECT actor_id FROM audit_log WHERE entity_type = 'care_plan_item' AND entity_id = ${pastItem} AND action = 'clear_report_request'`;
  expect(rows.map((r: any) => r.actor_id)).toEqual([staff.id]);
});

test("an item that already has a confirmed report cannot be asked for; unknown ids are 404", async () => {
  expect((await request(seenItem)).status).toBe(409);
  expect((await planItem(seenItem)).report_request).toBeNull();
  expect((await request(crypto.randomUUID())).status).toBe(404);
  expect((await request("nope")).status).toBe(404);
  expect((await clear("nope")).status).toBe(404);
});

test("a second request on an already-requested item is refused and writes no second audit row", async () => {
  expect((await request(pastItem)).status).toBe(200);
  expect((await request(pastItem, staff)).status).toBe(409);
  const rows = await sql`SELECT 1 FROM audit_log WHERE entity_type = 'care_plan_item' AND entity_id = ${pastItem} AND action = 'request_report'`;
  const before = rows.length;
  expect((await request(pastItem)).status).toBe(409);
  const after = await sql`SELECT 1 FROM audit_log WHERE entity_type = 'care_plan_item' AND entity_id = ${pastItem} AND action = 'request_report'`;
  expect(after.length).toBe(before);
});

test("confirming a report clears the request (audited); a stale request is not shown", async () => {
  const [{ id: doc }] = await sql`SELECT id FROM documents WHERE patient_id = ${patientId} LIMIT 1`;
  const match = (id: string, document_id: string) =>
    setPlanItemMatch(Object.assign(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ document_id }) }), { params: { id } }), asAuthedUser(staff));
  expect((await match(pastItem, doc)).status).toBe(200);
  expect((await planItem(pastItem)).report_request).toBeNull();
  const [row] = await sql`SELECT report_requested_by FROM care_plan_items WHERE id = ${pastItem}`;
  expect(row.report_requested_by).toBeNull();
  const audit = await sql`SELECT after_value FROM audit_log WHERE entity_type = 'care_plan_item' AND entity_id = ${pastItem} AND action = 'clear_report_request' ORDER BY created_at DESC LIMIT 1`;
  expect(JSON.parse(audit[0].after_value).reason).toBe("report_confirmed");

  await sql`UPDATE care_plan_items SET report_requested_by = ${oncologist.id}, report_requested_at = now() WHERE id = ${seenItem}`;
  expect((await planItem(seenItem)).report_request).toBeNull();
});
