import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { signOffFactsBatch, undoSignOffFactsBatch, reopenFact } from "./facts";
import { getPatientPlan } from "./plan";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
let onc: TestUser;
let onc2: TestUser;
let patientId: string;
let otherPatientId: string;
let visitId: string;
let otherVisitId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "batch-staff");
  onc = await createTestUser("oncologist", "batch-onc");
  onc2 = await createTestUser("oncologist", "batch-onc2");
  patientId = (await createTestPatient(staff.id)).id;
  otherPatientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: otherVisitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${otherPatientId}, '2026-01-01') RETURNING id`;
});
afterAll(async () => {
  await deleteTestPatients(patientId, otherPatientId);
  await deleteTestUsers(staff.id, onc.id, onc2.id);
});

async function newDoc(pid = patientId, vid = visitId, identity: string | null = null) {
  const [d] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status)
    VALUES (${pid}, ${vid}, 'local://t/x.pdf', 'prescription', 'own_hospital', ${staff.id}, 'done', ${identity}::identity_status) RETURNING id`;
  return d.id as string;
}
async function newFact(o: { doc?: string; pid?: string; vid?: string; type?: string; value?: string; asOf?: string | null; check?: string; extra?: string } = {}) {
  const doc = o.doc ?? (await newDoc(o.pid, o.vid));
  const [f] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, check_state)
    VALUES (${o.pid ?? patientId}, ${o.vid ?? visitId}, ${doc}, ${o.type ?? "diagnosis"}::field_type, ${o.value ?? "IDC"},
            ${o.asOf === undefined ? "2026-01-01" : o.asOf}, 'value_found', 'unverified', ${o.check ?? "correct"}::check_state) RETURNING id`;
  return f.id as string;
}
const post = (fn: (r: Request, u: any) => Promise<Response>, ids: unknown, user = onc) =>
  fn(new Request("http://localhost/b", { method: "POST", body: JSON.stringify({ fact_ids: ids }) }), asAuthedUser(user));
const signBatch = (ids: unknown, user = onc) => post(signOffFactsBatch, ids, user);
const undoBatch = (ids: unknown, user = onc) => post(undoSignOffFactsBatch, ids, user);
const state = async (id: string) => (await sql`SELECT verification_state FROM facts WHERE id = ${id}`)[0].verification_state as string;
const auditCount = async (ids: string[], action: string) =>
  (await sql`SELECT count(*)::int AS n FROM audit_log WHERE entity_id IN ${sql(ids)} AND action = ${action}`)[0].n as number;

test("batch sign-off signs every fact with one audit row each and creates plan items per fact", async () => {
  const doc = await newDoc();
  const a = await newFact({ doc, type: "tests_advised", value: "CBC within 2 weeks", asOf: "2030-02-01" });
  const b = await newFact({ doc, type: "procedures_planned", value: "Port insertion", asOf: "2030-02-01" });
  const c = await newFact({ doc, type: "diagnosis" });
  const ids = [a, b, c];
  const res = await signBatch(ids);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ count: 3 });
  for (const id of ids) expect(await state(id)).toBe("oncologist_signed_off");
  for (const id of ids) expect(await auditCount([id], "sign_off")).toBe(1);
  const rows = await sql`SELECT source_fact_id FROM care_plan_items WHERE source_fact_id IN ${sql(ids)}`;
  expect(rows.map((r: any) => r.source_fact_id).sort()).toEqual([a, b].sort());
});

test("each ineligibility rejects the whole batch with a per-fact reason and signs nothing", async () => {
  const good = await newFact();
  const heldDoc = await newDoc(patientId, visitId, "mismatch");
  const cases: Record<string, string> = {
    unchecked: await newFact({ check: "unchecked" }),
    not_correct: await sql`INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, check_state, error_type)
      VALUES (${patientId}, ${visitId}, ${await newDoc()}, 'diagnosis', 'x', '2026-01-01', 'value_found', 'unverified', 'incorrect', 'value') RETURNING id`.then((r: any) => r[0].id),
    undated: await newFact({ asOf: null }),
    held: await newFact({ doc: heldDoc }),
    excluded: await sql`INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, check_state, error_type, excluded_at)
      VALUES (${patientId}, ${visitId}, ${await newDoc()}, 'diagnosis', 'x', '2026-01-01', 'value_found', 'unverified', 'incorrect', 'wrong_patient', now()) RETURNING id`.then((r: any) => r[0].id),
  };
  const conflictA = await newFact({ value: "ca" });
  const conflictB = await newFact({ value: "cb" });
  await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${conflictA}, ${conflictB}, 'annotated')`;
  cases.conflict = conflictA;
  const signed = await newFact();
  expect((await signBatch([signed])).status).toBe(200);
  cases.already_signed_off = signed;

  for (const [reason, id] of Object.entries(cases)) {
    const res = await signBatch([good, id]);
    expect(res.status).toBe(409);
    const body: any = await res.json();
    expect(body.failures).toEqual([{ fact_id: id, reason, message: expect.any(String) }]);
    expect(await state(good)).toBe("unverified");
  }
  expect(await auditCount([good], "sign_off")).toBe(0);

  // Several failures are all listed.
  const res = await signBatch([good, cases.unchecked, cases.undated]);
  expect(((await res.json()) as any).failures.map((f: any) => f.reason).sort()).toEqual(["unchecked", "undated"]);
});

test("validation: empty and oversized lists 400, bad ids 400, mixed patients 400 and nothing is signed", async () => {
  expect((await signBatch([])).status).toBe(400);
  expect((await signBatch("nope")).status).toBe(400);
  expect((await signBatch(["not-a-uuid"])).status).toBe(400);
  expect((await signBatch(Array.from({ length: 101 }, () => crypto.randomUUID()))).status).toBe(400);
  const mine = await newFact();
  const theirs = await newFact({ pid: otherPatientId, vid: otherVisitId });
  expect((await signBatch([mine, theirs])).status).toBe(400);
  expect(await state(mine)).toBe("unverified");
  expect(await state(theirs)).toBe("unverified");
  const missing = await signBatch([mine, crypto.randomUUID()]);
  expect(missing.status).toBe(409);
  expect(((await missing.json()) as any).failures[0].reason).toBe("not_found");
});

test("undo within the window reopens the facts with one reversal audit row each; plan items disappear", async () => {
  const doc = await newDoc();
  const t = await newFact({ doc, type: "tests_advised", value: "MRI in 2 weeks", asOf: "2031-01-01" });
  const d = await newFact({ doc });
  const ids = [t, d];
  expect((await signBatch(ids)).status).toBe(200);
  const planTexts = async () =>
    ((await (await getPatientPlan(Object.assign(new Request("http://localhost/p"), { params: { id: patientId } }))).json()) as any).items.map((i: any) => i.text);
  expect(await planTexts()).toContain("MRI in 2 weeks");

  const res = await undoBatch(ids);
  expect(res.status).toBe(200);
  for (const id of ids) {
    expect(await state(id)).toBe("reopened_by_oncologist");
    expect(await auditCount([id], "sign_off_undo")).toBe(1);
  }
  expect(await planTexts()).not.toContain("MRI in 2 weeks");
  // Not signed off any more: a second undo is rejected whole.
  expect((await undoBatch(ids)).status).toBe(409);
  // The ordinary reopen route still works and audits as 'reopen'.
  expect((await signBatch([d])).status).toBe(200);
  const r = await reopenFact(Object.assign(new Request("http://localhost/r", { method: "POST" }), { params: { id: d } }), asAuthedUser(onc));
  expect(r.status).toBe(200);
  expect(await auditCount([d], "reopen")).toBe(1);
});

test("undo is refused after the window and for another user's sign-off, changing nothing", async () => {
  const a = await newFact();
  const b = await newFact();
  expect((await signBatch([a, b])).status).toBe(200);

  const other = await undoBatch([a, b], onc2);
  expect(other.status).toBe(409);
  expect(((await other.json()) as any).failures.map((f: any) => f.reason)).toEqual(["not_yours", "not_yours"]);

  await sql`UPDATE facts SET signed_off_at = now() - interval '11 seconds' WHERE id = ${b}`;
  const late = await undoBatch([a, b]);
  expect(late.status).toBe(409);
  expect(((await late.json()) as any).failures).toEqual([{ fact_id: b, reason: "window_expired", message: expect.any(String) }]);
  expect(await state(a)).toBe("oncologist_signed_off");
  expect(await state(b)).toBe("oncologist_signed_off");
  expect(await auditCount([a, b], "sign_off_undo")).toBe(0);
});
