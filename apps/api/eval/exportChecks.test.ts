import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../src/db/client";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../src/test-helpers";
import { buildExpectedDoc, slugForDocument } from "./exportChecks";
import { ExpectedDocSchema } from "./types";

let staff: TestUser;
const patients: string[] = [];

beforeAll(async () => {
  staff = await createTestUser("staff", "export-checks-staff");
});
afterAll(async () => {
  await deleteTestPatients(...patients);
  await deleteTestUsers(staff.id);
});

async function scope() {
  const patientId = (await createTestPatient(staff.id)).id;
  patients.push(patientId);
  const [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  const [{ id: markerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  const [{ id: docId }] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, lab_name, collected_on)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done', 'Synthetic Labs', '2026-02-01') RETURNING id`;
  return { patientId, visitId, markerId, docId: docId as string };
}

type S = Awaited<ReturnType<typeof scope>>;
async function fact(s: S, o: { markerId?: string | null; value: string; state: "unchecked" | "correct" | "incorrect"; err?: string; rawLabel?: string | null }) {
  const excluded = o.err === "not_in_document";
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, as_of_date,
      source_page, check_state, error_type, excluded_at, checked_by, checked_at)
    VALUES (${s.patientId}, ${s.visitId}, ${s.docId}, ${o.markerId ?? null}, 'marker_value', ${o.value}, 'ng/mL', '2026-02-01',
      1, ${o.state}, ${o.err ?? null}, ${excluded ? sql`now()` : null}, ${o.state === "unchecked" ? null : staff.id}, ${o.state === "unchecked" ? null : sql`now()`})
    RETURNING id`;
  if (o.rawLabel) {
    await sql`INSERT INTO audit_log (actor_id, action, entity_type, entity_id, after_value)
      VALUES (${staff.id}, 'upload', 'fact', ${row.id}, ${JSON.stringify({ raw_marker_label: o.rawLabel, value: "4.2" })}::jsonb)`;
  }
  return row.id as string;
}

test("exports checked facts with corrected values, printed labels, and spot_check origin", async () => {
  const s = await scope();
  await fact(s, { markerId: s.markerId, value: "5.0", state: "incorrect", err: "value", rawLabel: "Carcino Emb Ag" });
  await fact(s, { markerId: null, value: "9", state: "correct" });
  await fact(s, { markerId: null, value: "1", state: "incorrect", err: "not_in_document" });

  const doc = await buildExpectedDoc(s.docId);
  expect("skipped" in doc).toBe(false);
  const parsed = ExpectedDocSchema.parse(doc);
  expect(parsed.keyOrigin).toBe("spot_check");
  expect(parsed.source).toBe("real");
  expect(parsed.documentType).toBe("blood");
  expect(parsed.header?.labName).toBe("Synthetic Labs");
  expect(parsed.header?.collectedOn).toBe("2026-02-01");
  expect(parsed.facts).toHaveLength(2);
  const mapped = parsed.facts.find((f) => f.canonicalMarker === "CEA")!;
  expect(mapped.value).toBe("5.0");
  expect(mapped.markerLabel).toBe("Carcino Emb Ag");
  expect(mapped.asOfDate).toBe("2026-02-01");
  expect(mapped.sourcePage).toBe(1);
  expect(parsed.facts.some((f) => f.value === "1")).toBe(false);
});

test("a mapped marker with no upload audit row falls back to the tracked marker name", async () => {
  const s = await scope();
  await fact(s, { markerId: s.markerId, value: "4.0", state: "correct" });
  const doc = await buildExpectedDoc(s.docId);
  if ("skipped" in doc) throw new Error("unexpected skip");
  expect(doc.facts[0]!.markerLabel).toBe("CEA");
});

test("skips a document with an unchecked fact", async () => {
  const s = await scope();
  await fact(s, { markerId: s.markerId, value: "4.0", state: "correct" });
  await fact(s, { markerId: null, value: "2", state: "unchecked" });
  expect(await buildExpectedDoc(s.docId)).toHaveProperty("skipped");
});

test("skips a document with only excluded facts", async () => {
  const s = await scope();
  await fact(s, { markerId: null, value: "1", state: "incorrect", err: "not_in_document" });
  expect(await buildExpectedDoc(s.docId)).toHaveProperty("skipped");
});

test("skips a held or rejected document", async () => {
  const s = await scope();
  await fact(s, { markerId: s.markerId, value: "4.0", state: "correct" });
  await sql`UPDATE documents SET identity_status = 'mismatch' WHERE id = ${s.docId}`;
  expect(await buildExpectedDoc(s.docId)).toHaveProperty("skipped");
  await sql`UPDATE documents SET identity_status = 'rejected' WHERE id = ${s.docId}`;
  expect(await buildExpectedDoc(s.docId)).toHaveProperty("skipped");
});

test("slug falls back to spotcheck-<id prefix> when no report file matches the hash", async () => {
  const id = "abcdef12-0000-0000-0000-000000000000";
  expect(await slugForDocument(id, "0".repeat(64), new Map())).toBe("spotcheck-abcdef12");
  expect(await slugForDocument(id, "h1", new Map([["h1", "My Report 1.pdf"]]))).toBe("my-report-1");
});
