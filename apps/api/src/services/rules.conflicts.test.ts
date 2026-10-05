import { test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { sql } from "../db/client";
import { detectConflicts } from "./rules";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitId: string;
let documentId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "conflicts-test-staff");
  oncologist = await createTestUser("oncologist", "conflicts-test-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: documentId }] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://test/conflicts.pdf', 'blood', 'own_hospital', ${staff.id}, 'done')
    RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

afterEach(async () => {
  await sql`DELETE FROM conflicts WHERE fact_id_a IN (SELECT id FROM facts WHERE patient_id = ${patientId}) OR fact_id_b IN (SELECT id FROM facts WHERE patient_id = ${patientId})`;
  await sql`DELETE FROM facts WHERE patient_id = ${patientId}`;
});

interface NewFactOpts {
  value?: string | null;
  asOf?: string | null;
  needsDate?: boolean;
  verification?: string;
  fieldType?: string;
}

async function newFact(o: NewFactOpts = {}): Promise<any> {
  const f = {
    value: "4.2",
    asOf: "2026-05-01",
    needsDate: false,
    verification: "unverified",
    fieldType: "treatment_regimen", // not marker-carrying: tracked_marker_id stays null on both sides deliberately
    ...o,
  };
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, needs_manual_date,
      coverage_status, verification_state, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${f.fieldType}, ${f.value}, ${f.asOf}, ${f.needsDate},
      'value_found', ${f.verification}, ${f.verification === "oncologist_signed_off" ? oncologist.id : null})
    RETURNING *`;
  return row;
}

async function conflictRow(a: string, b: string) {
  const [row] = await sql`
    SELECT * FROM conflicts WHERE (fact_id_a = ${a} AND fact_id_b = ${b}) OR (fact_id_a = ${b} AND fact_id_b = ${a})`;
  return row;
}

test("same as_of_date and differing value creates a conflict and sets conflicting_sources on both facts", async () => {
  const a = await newFact({ value: "4.2" });
  const b = await newFact({ value: "9.0" });

  await sql.begin(async (tx) => {
    await detectConflicts(tx, a);
  });

  const conflict = await conflictRow(a.id, b.id);
  expect(conflict).toBeTruthy();
  expect(conflict.status).toBe("open");

  const [aAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${a.id}`;
  const [bAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${b.id}`;
  expect(aAfter.coverage_status).toBe("conflicting_sources");
  expect(bAfter.coverage_status).toBe("conflicting_sources");
});

test("same value and same date does not create a conflict", async () => {
  const a = await newFact({ value: "4.2" });
  const b = await newFact({ value: "4.2" });

  await sql.begin(async (tx) => {
    await detectConflicts(tx, a);
  });

  const conflict = await conflictRow(a.id, b.id);
  expect(conflict).toBeUndefined();

  const [aAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${a.id}`;
  expect(aAfter.coverage_status).toBe("value_found");
});

test("different dates never conflict regardless of value", async () => {
  const a = await newFact({ value: "4.2", asOf: "2026-05-01" });
  const b = await newFact({ value: "9.0", asOf: "2026-05-02" });

  await sql.begin(async (tx) => {
    await detectConflicts(tx, a);
  });

  const conflict = await conflictRow(a.id, b.id);
  expect(conflict).toBeUndefined();

  const [aAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${a.id}`;
  expect(aAfter.coverage_status).toBe("value_found");
});

test("a signed-off fact hit by a new conflict keeps oncologist_signed_off but gains conflicting_sources", async () => {
  const a = await newFact({ value: "4.2", verification: "oncologist_signed_off" });
  const b = await newFact({ value: "9.0" });

  await sql.begin(async (tx) => {
    await detectConflicts(tx, b);
  });

  const [aAfter] = await sql`SELECT coverage_status, verification_state FROM facts WHERE id = ${a.id}`;
  expect(aAfter.verification_state).toBe("oncologist_signed_off");
  expect(aAfter.coverage_status).toBe("conflicting_sources");

  const conflict = await conflictRow(a.id, b.id);
  expect(conflict).toBeTruthy();
});

test("skips detection entirely for a fact with needs_manual_date = true", async () => {
  const a = await newFact({ value: "4.2", asOf: null, needsDate: true });
  const b = await newFact({ value: "9.0", asOf: "2026-05-01" });

  await sql.begin(async (tx) => {
    await detectConflicts(tx, a);
  });

  const conflict = await conflictRow(a.id, b.id);
  expect(conflict).toBeUndefined();

  const [aAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${a.id}`;
  const [bAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${b.id}`;
  expect(aAfter.coverage_status).toBe("value_found");
  expect(bAfter.coverage_status).toBe("value_found");
});

test("two unmapped marker_value facts (tracked_marker_id null) with different raw labels, same date, different values do not conflict", async () => {
  // Both null tracked_marker_id here means "not yet mapped", not "the same marker" —
  // staff hasn't said these are the same thing, so treating the shared null as a
  // match would fabricate a conflict between two unrelated unmapped candidates
  // (e.g. Hemoglobin and WBC on the same blood report).
  const a = await newFact({ value: "4.2", fieldType: "marker_value" });
  const b = await newFact({ value: "9.0", fieldType: "marker_value" });

  await sql.begin(async (tx) => {
    await detectConflicts(tx, a);
  });
  await sql.begin(async (tx) => {
    await detectConflicts(tx, b);
  });

  const conflict = await conflictRow(a.id, b.id);
  expect(conflict).toBeUndefined();

  const [aAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${a.id}`;
  const [bAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${b.id}`;
  expect(aAfter.coverage_status).toBe("value_found");
  expect(bAfter.coverage_status).toBe("value_found");
});

test("a mapped marker_value fact still conflicts against another fact mapped to the same tracked_marker_id", async () => {
  const [{ id: markerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  const [a] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, tracked_marker_id, value, as_of_date, needs_manual_date, coverage_status, verification_state)
    VALUES (${patientId}, ${visitId}, ${documentId}, 'marker_value', ${markerId}, '4.2', '2026-05-01', false, 'value_found', 'unverified') RETURNING *`;
  const [b] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, tracked_marker_id, value, as_of_date, needs_manual_date, coverage_status, verification_state)
    VALUES (${patientId}, ${visitId}, ${documentId}, 'marker_value', ${markerId}, '9.0', '2026-05-01', false, 'value_found', 'unverified') RETURNING *`;

  await sql.begin(async (tx) => {
    await detectConflicts(tx, a);
  });

  const conflict = await conflictRow(a.id, b.id);
  expect(conflict).toBeTruthy();
});

test("running detection twice for the same pair does not create a duplicate conflict row", async () => {
  const a = await newFact({ value: "4.2" });
  const b = await newFact({ value: "9.0" });

  await sql.begin(async (tx) => {
    await detectConflicts(tx, a);
  });
  await sql.begin(async (tx) => {
    await detectConflicts(tx, b);
  });

  const rows = await sql`
    SELECT id FROM conflicts WHERE (fact_id_a = ${a.id} AND fact_id_b = ${b.id}) OR (fact_id_a = ${b.id} AND fact_id_b = ${a.id})`;
  expect(rows).toHaveLength(1);
});

test("does not match a live fact against itself", async () => {
  const a = await newFact({ value: "4.2" });

  await sql.begin(async (tx) => {
    await detectConflicts(tx, a);
  });

  const [aAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${a.id}`;
  expect(aAfter.coverage_status).toBe("value_found");
});

// --- dry run: reports what would happen, writes nothing ---

test("dry run reports a would-create pair and writes nothing", async () => {
  const a = await newFact({ value: "4.2" });
  const b = await newFact({ value: "9.0" });

  const pairs = await sql.begin(async (tx) => detectConflicts(tx, a, { dryRun: true }));

  expect(pairs).toHaveLength(1);
  const [pair] = pairs;
  expect(pair!.alreadyExists).toBe(false);
  expect([pair!.factIdA, pair!.factIdB].sort()).toEqual([a.id, b.id].sort());

  const conflict = await conflictRow(a.id, b.id);
  expect(conflict).toBeUndefined();
  const [aAfter] = await sql`SELECT coverage_status FROM facts WHERE id = ${a.id}`;
  expect(aAfter.coverage_status).toBe("value_found");
});

test("dry run reports alreadyExists true for a pair that already has a conflict row, and still writes nothing new", async () => {
  const a = await newFact({ value: "4.2" });
  const b = await newFact({ value: "9.0" });
  await sql.begin(async (tx) => {
    await detectConflicts(tx, a);
  });

  const pairs = await sql.begin(async (tx) => detectConflicts(tx, b, { dryRun: true }));

  expect(pairs).toHaveLength(1);
  expect(pairs[0]!.alreadyExists).toBe(true);

  const rows = await sql`
    SELECT id FROM conflicts WHERE (fact_id_a = ${a.id} AND fact_id_b = ${b.id}) OR (fact_id_a = ${b.id} AND fact_id_b = ${a.id})`;
  expect(rows).toHaveLength(1);
});
