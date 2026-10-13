import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getDocumentCheckSummary, getLabCheckSummary } from "./checks";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

let staff: TestUser;
let other: TestUser;
let patientId: string;
let visitId: string;
const LAB_A = `LabA-${crypto.randomUUID()}`;

beforeAll(async () => {
  staff = await createTestUser("staff", "checks-staff");
  other = await createTestUser("staff", "checks-other");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
});
afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, other.id);
});

async function doc(lab: string | null, identity = "matched"): Promise<string> {
  return (await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, lab_name, identity_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done', ${lab}, ${identity}) RETURNING id`)[0]!.id;
}
async function fact(docId: string, state: string, by: string | null, errorType: string | null = null) {
  await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state,
                       check_state, checked_by, checked_at, error_type, excluded_at)
    VALUES (${patientId}, ${visitId}, ${docId}, 'radiology_impression', 'x', '2026-01-01', 'value_found', 'unverified',
            ${state}, ${by}, ${state === "unchecked" ? null : sql`now()`}, ${errorType},
            ${errorType === "not_in_document" ? sql`now()` : null})`;
}
function req(path: string, id?: string) {
  const r = new Request(`http://localhost${path}`) as Request & { params: { id: string } };
  r.params = { id: id! };
  return r;
}
const summary = async (id: string) => getDocumentCheckSummary(req(`/documents/${id}/check-summary`, id));

test("per-document summary: agreement, errors_by_type, checked_by", async () => {
  const d = await doc(LAB_A);
  await fact(d, "correct", staff.id);
  await fact(d, "correct", other.id);
  await fact(d, "incorrect", staff.id, "value");
  await fact(d, "unchecked", null);
  const res = await summary(d);
  expect(res.status).toBe(200);
  const b = (await res.json()) as any;
  expect(b).toMatchObject({ document_id: d, lab_name: LAB_A, total: 4, checked: 3, correct: 2, incorrect: 1, unchecked: 1 });
  expect(b.agreement).toBeCloseTo(2 / 3);
  expect(b.errors_by_type.value).toBe(1);
  expect(b.errors_by_type.unit).toBe(0);
  expect(b.checked_by.find((c: any) => c.user_id === staff.id)).toMatchObject({ name: "checks-staff", count: 2 });
  expect(b.checked_by.find((c: any) => c.user_id === other.id).count).toBe(1);
});

test("agreement is null when nothing is checked; backfilled marks are listed but excluded from agreement", async () => {
  const none = await doc(LAB_A);
  await fact(none, "unchecked", null);
  const b0 = (await (await summary(none)).json()) as any;
  expect(b0.agreement).toBeNull();
  expect(b0.checked).toBe(0);

  const bf = await doc(LAB_A);
  await fact(bf, "correct", null);
  await fact(bf, "correct", null);
  await fact(bf, "incorrect", staff.id, "unit");
  const b = (await (await summary(bf)).json()) as any;
  expect(b.agreement).toBe(0);
  expect(b.checked_by).toContainEqual({ user_id: null, name: "backfilled", count: 2 });

  const onlyBf = await doc(LAB_A);
  await fact(onlyBf, "correct", null);
  expect(((await (await summary(onlyBf)).json()) as any).agreement).toBeNull();
});

test("check-summary 404 for unknown/malformed id, 409 for held and rejected documents", async () => {
  expect((await summary("00000000-0000-0000-0000-000000000000")).status).toBe(404);
  expect((await summary("nope")).status).toBe(404);
  expect((await summary(await doc(LAB_A, "mismatch"))).status).toBe(409);
  expect((await summary(await doc(LAB_A, "rejected"))).status).toBe(409);
});

test("by-lab groups per lab with an 'unknown' bucket and errors_by_type", async () => {
  const lab = `LabB-${crypto.randomUUID()}`;
  const d1 = await doc(lab);
  const d2 = await doc(lab);
  await fact(d1, "correct", staff.id);
  await fact(d1, "incorrect", staff.id, "marker");
  await fact(d2, "correct", staff.id);
  await fact(d2, "correct", null);
  const dn = await doc(null);
  await fact(dn, "incorrect", staff.id, "not_in_document");

  const rows = (await (await getLabCheckSummary(req("/checks/by-lab"))).json()) as any[];
  const l = rows.find((r) => r.lab_name === lab);
  expect(l).toMatchObject({ documents: 2, checked: 4, correct: 3, incorrect: 1 });
  expect(l.agreement).toBeCloseTo(2 / 3); // backfilled correct excluded: 2 correct / 3 spot-checked
  expect(l.errors_by_type.marker).toBe(1);
  const u = rows.find((r) => r.lab_name === "unknown");
  expect(u.incorrect).toBeGreaterThanOrEqual(1);
  expect(u.errors_by_type.not_in_document).toBeGreaterThanOrEqual(1);
});
