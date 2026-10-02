import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { persistExtractedFacts } from "./facts";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";
import type { ExtractedFactCandidate } from "@prelude/shared";

let staff: TestUser;
let patientId: string;
let visitId: string;
let documentId: string;

function candidate(overrides: Partial<ExtractedFactCandidate> = {}): ExtractedFactCandidate {
  return {
    fieldType: "marker_value",
    trackedMarkerLabel: "CEA",
    value: "4.2",
    unit: "ng/mL",
    referenceRange: "0-5",
    asOfDate: "2026-01-01",
    coverageStatus: "value_found",
    sourcePage: 2,
    sourceLocation: "line 14",
    sourceSnippet: "CEA 4.2 ng/mL",
    confidence: 0.95,
    ...overrides,
  };
}

beforeAll(async () => {
  staff = await createTestUser("staff", "facts-test-staff");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`
    INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id
  `;
  [{ id: documentId }] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://test/a.pdf', 'blood', 'own_hospital', ${staff.id}, 'done')
    RETURNING id
  `;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id);
});

function docContext() {
  return { id: documentId, patient_id: patientId, visit_id: visitId };
}

test("persists a fact with tracked_marker_id set on a confident match", async () => {
  await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
    VALUES (${patientId}, 'CEA', false, ${staff.id})
  `;

  const result = await persistExtractedFacts(docContext(), [candidate()], staff.id);
  expect(result.needsManualDate).toBe(false);
  expect(result.createdFactIds).toHaveLength(1);

  const [fact] = await sql`SELECT * FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.tracked_marker_id).not.toBeNull();
  expect(fact.raw_marker_label).toBeNull();
  expect(fact.coverage_status).toBe("value_found");
  expect(fact.verification_state).toBe("unverified");
  expect(fact.source_page).toBe(2);
  expect(fact.source_location).toBe("line 14");
  expect(fact.source_snippet).toBe("CEA 4.2 ng/mL");

  const [auditRow] = await sql`SELECT * FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${fact.id}`;
  expect(auditRow.action).toBe("upload");
  expect(auditRow.actor_id).toBe(staff.id);
});

test("forces extraction_uncertain and leaves tracked_marker_id null when the marker has no confident match", async () => {
  const result = await persistExtractedFacts(
    docContext(),
    [candidate({ trackedMarkerLabel: "Some Unmapped Marker", confidence: 0.99 })],
    staff.id,
  );
  expect(result.createdFactIds).toHaveLength(1);

  const [fact] = await sql`SELECT * FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.tracked_marker_id).toBeNull();
  expect(fact.raw_marker_label).toBe("Some Unmapped Marker");
  expect(fact.coverage_status).toBe("extraction_uncertain");
});

async function newDocument(): Promise<{ id: string; patient_id: string; visit_id: string }> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://test/b.pdf', 'blood', 'own_hospital', ${staff.id}, 'done')
    RETURNING id, patient_id, visit_id
  `;
  return doc;
}

test("persists an undated candidate with as_of_date null and needs_manual_date set, rather than dropping it", async () => {
  const doc = await newDocument();
  const result = await persistExtractedFacts(doc, [candidate({ asOfDate: null, trackedMarkerLabel: undefined })], staff.id);
  expect(result.needsManualDate).toBe(true);
  expect(result.createdFactIds).toHaveLength(1);

  const [fact] = await sql`SELECT as_of_date, needs_manual_date FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.as_of_date).toBeNull();
  expect(fact.needs_manual_date).toBe(true);

  const [docRow] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${doc.id}`;
  expect(docRow.needs_manual_date).toBe(true);

  const [auditRow] = await sql`SELECT after_value FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${result.createdFactIds[0]}`;
  expect(JSON.parse(auditRow.after_value).needs_manual_date).toBe(true);
});

test("in a mixed batch, keeps the dated fact dated and flags only the undated one", async () => {
  const doc = await newDocument();
  const result = await persistExtractedFacts(
    doc,
    [candidate({ asOfDate: "2026-02-01", trackedMarkerLabel: undefined }), candidate({ asOfDate: null, trackedMarkerLabel: undefined })],
    staff.id,
  );
  expect(result.createdFactIds).toHaveLength(2);
  expect(result.needsManualDate).toBe(true);

  const facts = await sql`SELECT as_of_date, needs_manual_date FROM facts WHERE document_id = ${doc.id} ORDER BY needs_manual_date`;
  expect(facts.map((f: any) => f.needs_manual_date)).toEqual([false, true]);
  expect(facts[0].as_of_date).not.toBeNull();
  expect(facts[1].as_of_date).toBeNull();

  const [docRow] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${doc.id}`;
  expect(docRow.needs_manual_date).toBe(true);
});

test("leaves documents.needs_manual_date false when every candidate is dated", async () => {
  const doc = await newDocument();
  const result = await persistExtractedFacts(doc, [candidate({ trackedMarkerLabel: undefined })], staff.id);
  expect(result.needsManualDate).toBe(false);
  const [docRow] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${doc.id}`;
  expect(docRow.needs_manual_date).toBe(false);
});

test("rolls back every fact and audit row for the document when a later insert fails", async () => {
  const doc = await newDocument();
  await expect(
    persistExtractedFacts(
      doc,
      [candidate({ trackedMarkerLabel: undefined }), candidate({ asOfDate: "2026-13-45", trackedMarkerLabel: undefined })],
      staff.id,
    ),
  ).rejects.toThrow();

  const facts = await sql`SELECT id FROM facts WHERE document_id = ${doc.id}`;
  expect(facts).toHaveLength(0);
  const audit = await sql`SELECT id FROM audit_log WHERE entity_type = 'fact' AND after_value->>'document_id' = ${doc.id}`;
  expect(audit).toHaveLength(0);
  const [docRow] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${doc.id}`;
  expect(docRow.needs_manual_date).toBe(false);
});

test("the database rejects sign-off on a fact that has no as_of_date", async () => {
  const doc = await newDocument();
  const insertSignedOffUndated = async () => {
    await sql`
      INSERT INTO facts (patient_id, visit_id, document_id, field_type, as_of_date, verification_state, signed_off_by, needs_manual_date)
      VALUES (${patientId}, ${visitId}, ${doc.id}, 'marker_value', NULL, 'oncologist_signed_off', ${staff.id}, true)
    `;
  };
  await expect(insertSignedOffUndated()).rejects.toThrow(/no_signoff_while_undated/);
});

test("copies null source fields through as-is rather than inventing them", async () => {
  const result = await persistExtractedFacts(
    docContext(),
    [candidate({ trackedMarkerLabel: undefined, sourcePage: null, sourceLocation: null, sourceSnippet: null })],
    staff.id,
  );
  const [fact] = await sql`SELECT * FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.source_page).toBeNull();
  expect(fact.source_location).toBeNull();
  expect(fact.source_snippet).toBeNull();
});
