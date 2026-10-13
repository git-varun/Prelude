import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { checkFactRoute, patchFact } from "./facts";
import { getPatientSnapshot } from "./patients";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let otherPatientId: string;
let otherPatientMarkerId: string;
const patients: string[] = [];

beforeAll(async () => {
  staff = await createTestUser("staff", "facts-check-staff");
  oncologist = await createTestUser("oncologist", "facts-check-onc");
  otherPatientId = (await createTestPatient(staff.id)).id;
  patients.push(otherPatientId);
  [{ id: otherPatientMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${otherPatientId}, 'PSA', false, ${staff.id}) RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(...patients);
  await deleteTestUsers(staff.id, oncologist.id);
});

// A fresh patient/visit/CEA marker/document per test, so un-exclusion never finds another test's CEA fact.
interface Scope { patientId: string; visitId: string; markerId: string; docId: string }
async function scope(): Promise<Scope> {
  const patientId = (await createTestPatient(staff.id)).id;
  patients.push(patientId);
  const [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  const [{ id: markerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  const [{ id: docId }] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  return { patientId, visitId, markerId, docId };
}

async function newFact(s: Scope, o: Record<string, unknown> = {}): Promise<string> {
  const f = {
    value: "4.2" as string | null, asOf: "2026-02-01" as string | null, needsDate: false, coverage: "value_found",
    verification: "unverified", markerId: s.markerId as string | null, excluded: false, ...o,
  };
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value,
      as_of_date, needs_manual_date, coverage_status, verification_state, signed_off_by,
      check_state, error_type, excluded_at)
    VALUES (${s.patientId}, ${s.visitId}, ${s.docId}, ${f.markerId}, 'marker_value', ${f.value},
      ${f.asOf}, ${f.needsDate}, ${f.coverage}, ${f.verification},
      ${f.verification === "oncologist_signed_off" ? oncologist.id : null},
      ${f.excluded ? "incorrect" : "unchecked"}, ${f.excluded ? "not_in_document" : null}, ${f.excluded ? sql`now()` : null})
    RETURNING id`;
  return row.id;
}

function checkReq(id: string, body: unknown) {
  const req = new Request(`http://localhost/facts/${id}/check`, { method: "POST", body: JSON.stringify(body) }) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}
function patchReq(id: string, body: unknown) {
  const req = new Request(`http://localhost/facts/${id}`, { method: "PATCH", body: JSON.stringify(body) }) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}
const check = (id: string, body: unknown, user: TestUser = staff) => checkFactRoute(checkReq(id, body), asAuthedUser(user));
const patch = (id: string, body: unknown) => patchFact(patchReq(id, body), asAuthedUser(staff));

async function factRow(id: string) {
  const [row] = await sql`SELECT * FROM facts WHERE id = ${id}`;
  return row;
}
async function audits(id: string, action: string) {
  return await sql`SELECT * FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${id} AND action = ${action} ORDER BY created_at, id`;
}
async function snapshotText(patientId: string): Promise<string> {
  const req = new Request(`http://localhost/patients/${patientId}/snapshot`) as Request & { params: { id: string } };
  req.params = { id: patientId };
  const res = await getPatientSnapshot(req);
  expect(res.status).toBe(200);
  return JSON.stringify(await res.json());
}

test("1. correct on a live valued dated fact sets the mark and writes one check_fact audit row", async () => {
  const s = await scope();
  const id = await newFact(s);
  const res = await check(id, { result: "correct" });
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.check_state).toBe("correct");
  expect(row.checked_by).toBe(staff.id);
  expect(row.checked_at).not.toBeNull();
  expect(row.error_type).toBeNull();
  expect(row.excluded_at).toBeNull();
  const rows = await audits(id, "check_fact");
  expect(rows).toHaveLength(1);
  expect(rows[0].actor_id).toBe(staff.id);
  expect(JSON.parse(rows[0].before_value).check_state).toBe("unchecked");
  expect(JSON.parse(rows[0].after_value).check_state).toBe("correct");
});

test("2. correct is a 409 on a NULL value, a needs_manual_date fact, a signed-off fact and a held document", async () => {
  const s = await scope();
  const nullValue = await newFact(s, { value: null });
  const undated = await newFact(s, { asOf: null, needsDate: true });
  const signedOff = await newFact(s, { verification: "oncologist_signed_off" });
  expect((await check(nullValue, { result: "correct" })).status).toBe(409);
  expect((await check(undated, { result: "correct" })).status).toBe(409);
  expect((await check(signedOff, { result: "correct" })).status).toBe(409);
  for (const id of [nullValue, undated, signedOff]) expect((await factRow(id)).check_state).not.toBe("correct");

  for (const status of ["mismatch", "rejected"]) {
    const h = await scope();
    await sql`UPDATE documents SET identity_status = ${status} WHERE id = ${h.docId}`;
    const id = await newFact(h);
    expect((await check(id, { result: "correct" })).status).toBe(409);
    expect((await factRow(id)).check_state).toBe("unchecked");
  }
});

test("2b. incorrect/not_in_document on a held (mismatch) document is a 409 and writes nothing", async () => {
  const s = await scope();
  await sql`UPDATE documents SET identity_status = 'mismatch' WHERE id = ${s.docId}`;
  const id = await newFact(s);
  const before = await factRow(id);
  expect((await check(id, { result: "incorrect", error_type: "not_in_document" })).status).toBe(409);
  const after = await factRow(id);
  expect(after).toEqual(before);
  expect(after.excluded_at).toBeNull();
  expect(after.check_state).toBe("unchecked");
  expect(await audits(id, "check_fact")).toHaveLength(0);
});

test("3. incorrect/value applies the correction and keeps the mark (both correct and check_fact audited)", async () => {
  const s = await scope();
  const id = await newFact(s);
  const res = await check(id, { result: "incorrect", error_type: "value", correction: { value: "5.0" } });
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.value).toBe("5.0");
  expect(row.verification_state).toBe("staff_corrected");
  expect(row.check_state).toBe("incorrect");
  expect(row.error_type).toBe("value");
  expect(row.checked_by).toBe(staff.id);
  expect(row.excluded_at).toBeNull();
  expect(await audits(id, "correct")).toHaveLength(1);
  const checkRows = await audits(id, "check_fact");
  expect(checkRows).toHaveLength(1);
  expect(JSON.parse(checkRows[0].before_value).value).toBe("4.2");
  expect(JSON.parse(checkRows[0].after_value).value).toBe("5.0");
});

test("4. incorrect/marker mapping to another patient's marker is a 400 and nothing is written", async () => {
  const s = await scope();
  const id = await newFact(s);
  const res = await check(id, { result: "incorrect", error_type: "marker", correction: { tracked_marker_id: otherPatientMarkerId } });
  expect(res.status).toBe(400);
  const row = await factRow(id);
  expect(row.check_state).toBe("unchecked");
  expect(row.error_type).toBeNull();
  expect(row.tracked_marker_id).toBe(s.markerId);
  expect(await audits(id, "check_fact")).toHaveLength(0);
});

test("5. incorrect/not_in_document excludes the fact from the snapshot", async () => {
  const s = await scope();
  const id = await newFact(s);
  expect(await snapshotText(s.patientId)).toContain(id);
  const res = await check(id, { result: "incorrect", error_type: "not_in_document" });
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.excluded_at).not.toBeNull();
  expect(row.check_state).toBe("incorrect");
  expect(row.error_type).toBe("not_in_document");
  expect(await snapshotText(s.patientId)).not.toContain(id);
});

test("5b. a correction on an exclusion type is a 400", async () => {
  const s = await scope();
  const id = await newFact(s);
  expect((await check(id, { result: "incorrect", error_type: "wrong_patient", correction: { value: "1" } })).status).toBe(400);
  expect((await factRow(id)).excluded_at).toBeNull();
});

test("6. changing an excluded fact's mark to correct brings it back", async () => {
  const s = await scope();
  const id = await newFact(s, { excluded: true });
  expect(await snapshotText(s.patientId)).not.toContain(id);
  const res = await check(id, { result: "correct" });
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.excluded_at).toBeNull();
  expect(row.error_type).toBeNull();
  expect(row.check_state).toBe("correct");
  expect(await snapshotText(s.patientId)).toContain(id);
});

test("7. un-exclusion re-runs conflict detection", async () => {
  const s = await scope();
  const a = await newFact(s, { value: "4" });
  const b = await newFact(s, { value: "9", excluded: true });
  expect(await sql`SELECT id FROM conflicts WHERE fact_id_a IN (${a}, ${b}) OR fact_id_b IN (${a}, ${b})`).toHaveLength(0);
  expect((await check(b, { result: "correct" })).status).toBe(200);
  const conflicts = await sql`
    SELECT * FROM conflicts WHERE status = 'open'
      AND ((fact_id_a = ${a} AND fact_id_b = ${b}) OR (fact_id_a = ${b} AND fact_id_b = ${a}))`;
  expect(conflicts).toHaveLength(1);
  expect((await factRow(a)).coverage_status).toBe("conflicting_sources");
  expect((await factRow(b)).coverage_status).toBe("conflicting_sources");
});

test("ruling 1: excluding a fact clears conflicting_sources on the other side unless it has another live conflict", async () => {
  const s = await scope();
  const a = await newFact(s, { value: "4", coverage: "conflicting_sources" });
  const b = await newFact(s, { value: "9", coverage: "conflicting_sources" });
  const c = await newFact(s, { value: "4", coverage: "conflicting_sources" });
  const d = await newFact(s, { value: "7", coverage: "conflicting_sources" });
  await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open'), (${b}, ${c}, 'annotated'), (${c}, ${d}, 'open')`;

  expect((await check(b, { result: "incorrect", error_type: "wrong_patient" })).status).toBe(200);
  expect((await factRow(a)).coverage_status).toBe("value_found");
  // c still has a live open conflict with d.
  expect((await factRow(c)).coverage_status).toBe("conflicting_sources");
  expect((await factRow(d)).coverage_status).toBe("conflicting_sources");

  // Un-excluding re-runs detection, which tags a again.
  expect((await check(b, { result: "correct" })).status).toBe(200);
  expect((await factRow(a)).coverage_status).toBe("conflicting_sources");
});

test("ruling 3: excluding a document's only undated fact clears documents.needs_manual_date; un-excluding restores it", async () => {
  const s = await scope();
  const id = await newFact(s, { asOf: null, needsDate: true });
  await sql`UPDATE documents SET needs_manual_date = true WHERE id = ${s.docId}`;
  expect((await check(id, { result: "incorrect", error_type: "not_in_document" })).status).toBe(200);
  let [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${s.docId}`;
  expect(doc.needs_manual_date).toBe(false);

  expect((await check(id, { result: "incorrect", error_type: "value", correction: { value: "5" } })).status).toBe(200);
  [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${s.docId}`;
  expect(doc.needs_manual_date).toBe(true);
  expect((await factRow(id)).excluded_at).toBeNull();
});

test("ruling 3: a PATCH on a sibling does not recount an excluded undated fact", async () => {
  const s = await scope();
  await newFact(s, { asOf: null, needsDate: true, excluded: true });
  const live = await newFact(s, { asOf: null, needsDate: true });
  await sql`UPDATE documents SET needs_manual_date = true WHERE id = ${s.docId}`;
  expect((await patch(live, { as_of_date: "2026-02-01" })).status).toBe(200);
  const [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${s.docId}`;
  expect(doc.needs_manual_date).toBe(false);
});

test("8. PATCH resets a mark and audits the reset", async () => {
  const s = await scope();
  const id = await newFact(s);
  expect((await check(id, { result: "correct" })).status).toBe(200);
  const res = await patch(id, { value: "4.3" });
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.value).toBe("4.3");
  expect(row.check_state).toBe("unchecked");
  expect(row.checked_by).toBeNull();
  expect(row.checked_at).toBeNull();
  expect(row.error_type).toBeNull();
  const rows = await audits(id, "check_fact");
  expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[1].before_value).check_state).toBe("correct");
  expect(JSON.parse(rows[1].after_value).check_state).toBe("unchecked");
});

test("8b. PATCH of an unchecked fact writes no check_fact row", async () => {
  const s = await scope();
  const id = await newFact(s);
  expect((await patch(id, { value: "4.3" })).status).toBe(200);
  expect(await audits(id, "check_fact")).toHaveLength(0);
});

test("9. PATCH on an excluded fact is a 409 and the row is unchanged", async () => {
  const s = await scope();
  const id = await newFact(s, { excluded: true });
  const res = await patch(id, { value: "5" });
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).message ?? "").toContain("not belonging to this document");
  const row = await factRow(id);
  expect(row.value).toBe("4.2");
  expect(row.excluded_at).not.toBeNull();
  expect(row.verification_state).toBe("unverified");
  expect(await audits(id, "correct")).toHaveLength(0);
});

test("10. a mark can be changed until sign-off, each change audited", async () => {
  const s = await scope();
  const id = await newFact(s);
  expect((await check(id, { result: "correct" })).status).toBe(200);
  expect((await check(id, { result: "incorrect", error_type: "unit", correction: { unit: "ng/mL" } })).status).toBe(200);
  expect((await factRow(id)).error_type).toBe("unit");
  expect((await check(id, { result: "correct" }, oncologist)).status).toBe(200);
  const row = await factRow(id);
  expect(row.check_state).toBe("correct");
  expect(row.checked_by).toBe(oncologist.id);
  expect(await audits(id, "check_fact")).toHaveLength(3);

  await sql`UPDATE facts SET verification_state = 'oncologist_signed_off', signed_off_by = ${oncologist.id}, signed_off_at = now() WHERE id = ${id}`;
  expect((await check(id, { result: "incorrect", error_type: "wrong_patient" })).status).toBe(409);
  expect((await factRow(id)).check_state).toBe("correct");
});

test("11. concurrent check and PATCH serialize on the fact row", async () => {
  const s = await scope();
  // Distinct dates per fact so no two facts conflict with each other.
  const ids = await Promise.all(
    Array.from({ length: 20 }, (_, i) => newFact(s, { asOf: `2026-01-${String(i + 1).padStart(2, "0")}` })),
  );
  const results = await Promise.allSettled(
    // Alternate which call is issued first so both orders reliably occur.
    ids.flatMap((id, i) => {
      const pair = [() => check(id, { result: "correct" }), () => patch(id, { value: "9" })];
      return (i % 2 === 0 ? pair : pair.reverse()).map((f) => f());
    }),
  );
  for (const r of results) {
    expect(r.status).toBe("fulfilled");
    if (r.status === "fulfilled") expect(r.value.status).toBe(200);
  }
  // Both calls lock the fact row first, so exactly one order happened per fact, and the audit trail shows which.
  const orders = { checkThenPatch: 0, patchThenCheck: 0 };
  for (const id of ids) {
    const row = await factRow(id);
    expect(row.value).toBe("9");
    const rows: { before: any; after: any }[] = (await audits(id, "check_fact")).map((r: any) => ({
      before: JSON.parse(r.before_value), after: JSON.parse(r.after_value),
    }));
    if (row.check_state === "correct") {
      // PATCH then check: the one mark must have been taken against the already-corrected value.
      orders.patchThenCheck++;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.before.value).toBe("9");
      expect(rows[0]!.after.value).toBe("9");
    } else {
      // check then PATCH: the mark (taken on 4.2) was reset by the PATCH.
      orders.checkThenPatch++;
      expect(row.check_state).toBe("unchecked");
      // audit created_at is the transaction start, not commit order, so pick the rows by content.
      expect(rows).toHaveLength(2);
      const mark = rows.find((r) => r.after.check_state === "correct");
      const reset = rows.find((r) => r.after.check_state === "unchecked");
      expect(mark?.before.value).toBe("4.2");
      expect(mark?.after.value).toBe("4.2");
      expect(reset?.before.check_state).toBe("correct");
      expect(reset?.after.value).toBe("9");
    }
  }
  expect(orders.checkThenPatch + orders.patchThenCheck).toBe(ids.length);
  // The test only exercises the race if both orders actually happen (issue order alternates per fact).
  expect(orders.checkThenPatch).toBeGreaterThan(0);
  expect(orders.patchThenCheck).toBeGreaterThan(0);
});

test("bad input: malformed id is 404, bad body is 400", async () => {
  expect((await check("not-a-uuid", { result: "correct" })).status).toBe(404);
  expect((await check("00000000-0000-0000-0000-000000000000", { result: "correct" })).status).toBe(404);
  const s = await scope();
  const id = await newFact(s);
  expect((await check(id, { result: "maybe" })).status).toBe(400);
  expect((await check(id, { result: "incorrect", error_type: "value" })).status).toBe(400);
});
