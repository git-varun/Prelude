import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { persistExtractedFacts } from "./facts";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";
import type { ExtractedFactCandidate } from "@opd/shared";

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
  expect(result.heldForManualDate).toBe(false);
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

test("holds the document for manual date entry when no candidate has an as_of_date", async () => {
  const result = await persistExtractedFacts(docContext(), [candidate({ asOfDate: null })], staff.id);
  expect(result.heldForManualDate).toBe(true);
  expect(result.createdFactIds).toHaveLength(0);

  const [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${documentId}`;
  expect(doc.needs_manual_date).toBe(true);

  await sql`UPDATE documents SET needs_manual_date = false WHERE id = ${documentId}`;
});

test("persists dated candidates and drops undated ones without setting needs_manual_date", async () => {
  const result = await persistExtractedFacts(
    docContext(),
    [candidate({ asOfDate: "2026-02-01", trackedMarkerLabel: undefined }), candidate({ asOfDate: null, trackedMarkerLabel: undefined })],
    staff.id,
  );
  expect(result.heldForManualDate).toBe(false);
  expect(result.createdFactIds).toHaveLength(1);

  const [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${documentId}`;
  expect(doc.needs_manual_date).toBe(false);
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
