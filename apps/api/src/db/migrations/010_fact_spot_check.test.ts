import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../client";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../../test-helpers";

let staff: TestUser; let patientId: string; let docId: string; let visitId: string;
beforeAll(async () => {
  staff = await createTestUser("staff", "mig010");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: docId }] = await sql`INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
});
afterAll(async () => { await deleteTestPatients(patientId); await deleteTestUsers(staff.id); });

// async + await: expect().rejects needs a real Promise; the lazy sql query would never be executed.
const insert = async (extra: string) => await sql.unsafe(`
  INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, ${extra.split("|")[0]})
  VALUES ('${patientId}', '${visitId}', '${docId}', 'marker_value', '1', '2026-01-01', ${extra.split("|")[1]})`);

test("a new fact defaults to unchecked with no mark fields", async () => {
  const [f] = await sql`INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date)
    VALUES (${patientId}, ${visitId}, ${docId}, 'marker_value', '1', '2026-01-01') RETURNING *`;
  expect(f.check_state).toBe("unchecked");
  expect(f.error_type).toBeNull(); expect(f.excluded_at).toBeNull(); expect(f.checked_by).toBeNull();
});
test("incorrect requires an error_type; correct and unchecked forbid one", async () => {
  await expect(insert("check_state|'incorrect'")).rejects.toThrow();
  await expect(insert("check_state, error_type|'correct', 'value'")).rejects.toThrow();
  await expect(insert("check_state, error_type|'incorrect', 'value'")).resolves.toBeDefined();
});
test("excluded_at is set exactly when error_type is not_in_document or wrong_patient", async () => {
  await expect(insert("check_state, error_type|'incorrect', 'not_in_document'")).rejects.toThrow(); // no excluded_at
  await expect(insert("check_state, error_type, excluded_at|'incorrect', 'value', now()")).rejects.toThrow();
  await expect(insert("check_state, error_type, excluded_at|'incorrect', 'wrong_patient', now()")).resolves.toBeDefined();
});
test("a non-incorrect row with excluded_at set is rejected (null error_type is not a free pass)", async () => {
  await expect(insert("excluded_at|now()")).rejects.toThrow();
});
test("backfill marks signed-off facts correct with checked_by NULL, leaves others unchecked", async () => {
  const [signed] = await sql`INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, verification_state, signed_off_by, signed_off_at)
    VALUES (${patientId}, ${visitId}, ${docId}, 'marker_value', '2', '2026-01-01', 'oncologist_signed_off', ${staff.id}, '2026-02-02T10:00:00Z') RETURNING id`;
  const [plain] = await sql`INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, verification_state)
    VALUES (${patientId}, ${visitId}, ${docId}, 'marker_value', '3', '2026-01-01', 'unverified') RETURNING id`;
  // Statement copied verbatim from the migration, scoped to this test's patient.
  await sql`UPDATE facts SET check_state = 'correct', checked_at = signed_off_at
    WHERE verification_state = 'oncologist_signed_off' AND patient_id = ${patientId}`;
  const [a] = await sql`SELECT check_state, checked_by, checked_at, signed_off_at FROM facts WHERE id = ${signed.id}`;
  const [b] = await sql`SELECT check_state FROM facts WHERE id = ${plain.id}`;
  expect(a.check_state).toBe("correct");
  expect(a.checked_by).toBeNull();
  expect(new Date(a.checked_at).getTime()).toBe(new Date(a.signed_off_at).getTime());
  expect(b.check_state).toBe("unchecked");
});
