import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { deltaKey, deltaForCurrentFact, deltaForAbsentField, loadDeltaBaselines } from "./delta";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

test("deltaForCurrentFact returns 'new' when there is no prior baseline", () => {
  expect(deltaForCurrentFact("4.2", undefined)).toBe("new");
});

test("deltaForCurrentFact returns 'unchanged' when the value matches the baseline", () => {
  expect(deltaForCurrentFact("4.2", { value: "4.2" })).toBe("unchanged");
});

test("deltaForCurrentFact returns 'changed' when the value differs from the baseline", () => {
  expect(deltaForCurrentFact("5.0", { value: "4.2" })).toBe("changed");
});

test("deltaForCurrentFact treats a null current value matching a null baseline as unchanged", () => {
  expect(deltaForCurrentFact(null, { value: null })).toBe("unchanged");
});

test("deltaForAbsentField returns 'not_observed_in_current_document_set' when a prior baseline exists", () => {
  expect(deltaForAbsentField({ value: "4.2" })).toBe("not_observed_in_current_document_set");
});

test("deltaForAbsentField returns null when there is no prior baseline at all", () => {
  expect(deltaForAbsentField(undefined)).toBeNull();
});

test("deltaKey combines field_type and tracked_marker_id, treating null marker distinctly from any id", () => {
  expect(deltaKey("marker_value", "abc")).toBe(deltaKey("marker_value", "abc"));
  expect(deltaKey("marker_value", "abc")).not.toBe(deltaKey("marker_value", "def"));
  expect(deltaKey("marker_value", null)).not.toBe(deltaKey("treatment_regimen", null));
});

// --- loadDeltaBaselines: DB-backed ---

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let markerId: string;
let v1: string; // 2026-01-01, oldest
let v2: string; // 2026-02-01, middle
let v3: string; // 2026-03-01, current for these tests

beforeAll(async () => {
  staff = await createTestUser("staff", "delta-test-staff");
  oncologist = await createTestUser("oncologist", "delta-test-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: markerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  [{ id: v1 }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: v2 }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  [{ id: v3 }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-03-01') RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newDocument(visitId: string): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  return doc.id;
}

async function newFact(visitId: string, o: Record<string, unknown> = {}): Promise<string> {
  const f = {
    fieldType: "marker_value", value: "4.2", asOf: "2026-01-01", verification: "unverified",
    markerId: markerId as string | null, ...o,
  };
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, as_of_date,
      coverage_status, verification_state, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${await newDocument(visitId)}, ${f.markerId}, ${f.fieldType}, ${f.value},
      ${f.asOf}, 'value_found', ${f.verification}, ${f.verification === "oncologist_signed_off" ? oncologist.id : null})
    RETURNING id`;
  return row.id;
}

test("loadDeltaBaselines ignores an unsigned fact and returns nothing for that key", async () => {
  await newFact(v1, { verification: "unverified", value: "1.0" });
  const baselines = await loadDeltaBaselines(patientId, "2026-03-01");
  expect(baselines.get(deltaKey("marker_value", markerId))).toBeUndefined();
});

test("loadDeltaBaselines reaches back past an intervening visit with no signed-off fact for that key (patient history isn't visit-bounded)", async () => {
  const [{ id: otherMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'PSA', false, ${staff.id}) RETURNING id`;
  await newFact(v1, { markerId: otherMarkerId, verification: "oncologist_signed_off", value: "7.7" });
  // v2 has no signed-off fact for otherMarkerId at all.
  const baselines = await loadDeltaBaselines(patientId, "2026-03-01");
  expect(baselines.get(deltaKey("marker_value", otherMarkerId))).toEqual({ value: "7.7" });
});

test("loadDeltaBaselines picks the most recent prior visit's signed-off fact when multiple prior visits qualify", async () => {
  const [{ id: m }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CA-125', false, ${staff.id}) RETURNING id`;
  await newFact(v1, { markerId: m, verification: "oncologist_signed_off", value: "old" });
  await newFact(v2, { markerId: m, verification: "oncologist_signed_off", value: "newer" });
  const baselines = await loadDeltaBaselines(patientId, "2026-03-01");
  expect(baselines.get(deltaKey("marker_value", m))).toEqual({ value: "newer" });
});

test("loadDeltaBaselines never includes a fact from the current visit or a later one", async () => {
  const [{ id: m }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'AFP', false, ${staff.id}) RETURNING id`;
  await newFact(v3, { markerId: m, verification: "oncologist_signed_off", value: "same-visit" });
  const baselines = await loadDeltaBaselines(patientId, "2026-03-01");
  expect(baselines.get(deltaKey("marker_value", m))).toBeUndefined();
});

test("loadDeltaBaselines treats a custom marker exactly like a controlled one: keyed by tracked_marker_id, not marker_name or is_custom", async () => {
  const [{ id: customId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'Some Custom Marker', true, ${staff.id}) RETURNING id`;
  await newFact(v1, { markerId: customId, verification: "oncologist_signed_off", value: "custom-baseline" });
  const baselines = await loadDeltaBaselines(patientId, "2026-03-01");
  expect(baselines.get(deltaKey("marker_value", customId))).toEqual({ value: "custom-baseline" });
});

test("loadDeltaBaselines never picks a fact that lost an authoritative-pick conflict resolution, even if it's the later-dated signed-off fact", async () => {
  const [{ id: m }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'Conflict-Marker', false, ${staff.id}) RETURNING id`;
  const winner = await newFact(v1, { markerId: m, verification: "oncologist_signed_off", value: "4.0", asOf: "2026-01-01" });
  const loser = await newFact(v1, { markerId: m, verification: "oncologist_signed_off", value: "9.0", asOf: "2026-01-02" });
  const [{ id: conflictId }] = await sql`
    INSERT INTO conflicts (fact_id_a, fact_id_b, status, authoritative_fact_id) VALUES (${winner}, ${loser}, 'resolved', ${winner}) RETURNING id`;

  try {
    const baselines = await loadDeltaBaselines(patientId, "2026-03-01");
    expect(baselines.get(deltaKey("marker_value", m))).toEqual({ value: "4.0" });
  } finally {
    await sql`DELETE FROM conflicts WHERE id = ${conflictId}`;
  }
});
