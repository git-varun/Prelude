import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { persistExtractedFacts } from "./facts";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";
import type { ExtractedFactCandidate, ExtractionResult } from "@prelude/shared";

type HeaderMetadata = NonNullable<ExtractionResult["header"]>;

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

test("two candidates in the same upload that share an as_of_date but disagree on value are flagged conflicting_sources", async () => {
  const doc = await newDocument();
  // Both candidates map to the patient's existing 'CEA' tracked marker (seeded by
  // the first test in this file) — an unmapped marker (tracked_marker_id null) is
  // deliberately excluded from conflict detection, since two unmapped candidates
  // sharing a null marker id aren't known to be the *same* marker.
  const result = await persistExtractedFacts(
    doc,
    [
      candidate({ asOfDate: "2026-04-01", value: "4.2" }),
      candidate({ asOfDate: "2026-04-01", value: "9.0" }),
    ],
    staff.id,
  );
  expect(result.createdFactIds).toHaveLength(2);

  const facts = await sql`SELECT id, coverage_status FROM facts WHERE id IN ${sql(result.createdFactIds)}`;
  expect(facts.every((f: any) => f.coverage_status === "conflicting_sources")).toBe(true);

  const [conflict] = await sql`
    SELECT id FROM conflicts
    WHERE (fact_id_a = ${result.createdFactIds[0]} AND fact_id_b = ${result.createdFactIds[1]})
       OR (fact_id_a = ${result.createdFactIds[1]} AND fact_id_b = ${result.createdFactIds[0]})`;
  expect(conflict).toBeTruthy();

  await sql`DELETE FROM conflicts WHERE id = ${conflict.id}`;
});

test("a document uploaded against an existing patient does not flag a conflict against a document from a different visit sharing a date, when values match", async () => {
  const doc = await newDocument();
  const result = await persistExtractedFacts(
    doc,
    [candidate({ trackedMarkerLabel: undefined, asOfDate: "2026-04-02", value: "4.2" })],
    staff.id,
  );
  const [fact] = await sql`SELECT coverage_status FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.coverage_status).toBe("value_found");
});

test("two unmapped-marker candidates sharing an as_of_date but disagreeing on value are not flagged conflicting_sources", async () => {
  const doc = await newDocument();
  const result = await persistExtractedFacts(
    doc,
    [
      candidate({ trackedMarkerLabel: "Hemoglobin", asOfDate: "2026-04-03", value: "12" }),
      candidate({ trackedMarkerLabel: "WBC Count", asOfDate: "2026-04-03", value: "7000" }),
    ],
    staff.id,
  );
  expect(result.createdFactIds).toHaveLength(2);

  const facts = await sql`SELECT coverage_status FROM facts WHERE id IN ${sql(result.createdFactIds)}`;
  expect(facts.every((f: any) => f.coverage_status === "extraction_uncertain")).toBe(true);

  const [conflict] = await sql`
    SELECT id FROM conflicts
    WHERE (fact_id_a = ${result.createdFactIds[0]} AND fact_id_b = ${result.createdFactIds[1]})
       OR (fact_id_a = ${result.createdFactIds[1]} AND fact_id_b = ${result.createdFactIds[0]})`;
  expect(conflict).toBeUndefined();
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

test("matches a raw label against a tracked marker's canonical name via a synonym alias", async () => {
  await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
    VALUES (${patientId}, 'CA 19-9', false, ${staff.id})
  `;

  const result = await persistExtractedFacts(
    docContext(),
    [candidate({ trackedMarkerLabel: "CA19-9", asOfDate: "2026-05-01" })],
    staff.id,
  );

  const [fact] = await sql`SELECT * FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.tracked_marker_id).not.toBeNull();
  expect(fact.raw_marker_label).toBeNull();
});

test("matches when the tracked marker itself is named by an alias, not the canonical name", async () => {
  await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
    VALUES (${patientId}, 'PSA', false, ${staff.id})
  `;

  const result = await persistExtractedFacts(
    docContext(),
    [candidate({ trackedMarkerLabel: "PSA", asOfDate: "2026-05-03" })],
    staff.id,
  );

  const [fact] = await sql`SELECT * FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.tracked_marker_id).not.toBeNull();
  expect(fact.raw_marker_label).toBeNull();
});

test("matches a raw alias label against a tracked marker named by a different alias of the same canonical marker", async () => {
  await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
    VALUES (${patientId}, 'PSA', false, ${staff.id})
  `;

  const result = await persistExtractedFacts(
    docContext(),
    [candidate({ trackedMarkerLabel: "tPSA", asOfDate: "2026-05-04" })],
    staff.id,
  );

  const [fact] = await sql`SELECT * FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.tracked_marker_id).not.toBeNull();
  expect(fact.raw_marker_label).toBeNull();
});

test("never matches Free PSA to a tracked Total PSA marker (hard negative)", async () => {
  await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by)
    VALUES (${patientId}, 'Total PSA', false, ${staff.id})
  `;

  const result = await persistExtractedFacts(
    docContext(),
    [candidate({ trackedMarkerLabel: "Free PSA", asOfDate: "2026-05-02" })],
    staff.id,
  );

  const [fact] = await sql`SELECT * FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.tracked_marker_id).toBeNull();
  expect(fact.raw_marker_label).toBe("Free PSA");
  expect(fact.coverage_status).toBe("extraction_uncertain");
});

test("persists printed_flag and parse_checks from the candidate", async () => {
  const result = await persistExtractedFacts(docContext(), [
    candidate({ printedFlag: "H", parseChecks: { valueParses: true, printedFlagAgrees: false } }),
  ], staff.id);
  const [fact] = await sql`SELECT printed_flag, parse_checks FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.printed_flag).toBe("H");
  expect(JSON.parse(fact.parse_checks)).toEqual({ valueParses: true, printedFlagAgrees: false });
});

test("a candidate with no printedFlag/parseChecks persists both as null", async () => {
  const result = await persistExtractedFacts(docContext(), [candidate()], staff.id);
  const [fact] = await sql`SELECT printed_flag, parse_checks FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.printed_flag).toBeNull();
  expect(fact.parse_checks).toBeNull();
});

test("documentMetadata writes header fields and identity_status onto the document, atomically with the facts", async () => {
  const header: HeaderMetadata = {
    labName: "Synthetic Labs", collectedOn: "2026-04-08", receivedOn: null, reportedOn: "2026-04-09",
    patientName: "Mr. TEST PERSON", labPatientRef: "LAB/1",
  };
  await persistExtractedFacts(docContext(), [candidate()], staff.id, { status: "done", error: null }, { header, identityStatus: "matched" });
  const [doc] = await sql`SELECT lab_name, to_char(collected_on, 'YYYY-MM-DD') AS collected_on, patient_name_on_report, lab_patient_ref, identity_status FROM documents WHERE id = ${documentId}`;
  expect(doc).toMatchObject({
    lab_name: "Synthetic Labs", collected_on: "2026-04-08", patient_name_on_report: "Mr. TEST PERSON",
    lab_patient_ref: "LAB/1", identity_status: "matched",
  });
});

test("documentMetadata is also applied when there are zero candidates", async () => {
  const header: HeaderMetadata = {
    labName: null, collectedOn: null, receivedOn: null, reportedOn: null,
    patientName: "Unmatched Name", labPatientRef: null,
  };
  await persistExtractedFacts(docContext(), [], staff.id, { status: "done", error: null }, { header, identityStatus: "mismatch" });
  const [doc] = await sql`SELECT identity_status, patient_name_on_report FROM documents WHERE id = ${documentId}`;
  expect(doc).toMatchObject({ identity_status: "mismatch", patient_name_on_report: "Unmatched Name" });
});

test("a mismatch-held document's facts are persisted but never open a conflict", async () => {
  const doc = await newDocument();
  const header: HeaderMetadata = { labName: null, collectedOn: null, receivedOn: null, reportedOn: null, patientName: "Someone Else", labPatientRef: null };
  const result = await persistExtractedFacts(
    doc,
    [candidate({ asOfDate: "2026-05-01", value: "4.2" }), candidate({ asOfDate: "2026-05-01", value: "9.0" })],
    staff.id,
    { status: "done", error: null },
    { header, identityStatus: "mismatch" },
  );
  expect(result.createdFactIds).toHaveLength(2);
  const conflicts = await sql`SELECT id FROM conflicts WHERE fact_id_a IN ${sql(result.createdFactIds)} OR fact_id_b IN ${sql(result.createdFactIds)}`;
  expect(conflicts).toHaveLength(0);
  const facts = await sql`SELECT coverage_status FROM facts WHERE id IN ${sql(result.createdFactIds)}`;
  expect(facts.every((f: any) => f.coverage_status !== "conflicting_sources")).toBe(true);
});

test("detectConflicts ignores a fact whose own document is held, so dating it later cannot open a conflict against the real patient's fact", async () => {
  const { detectConflicts } = await import("./rules");
  const liveDoc = await newDocument();
  const heldDoc = await newDocument();
  await sql`UPDATE documents SET identity_status = 'mismatch' WHERE id = ${heldDoc.id}`;
  const [marker] = await sql`SELECT id FROM tracked_markers WHERE patient_id = ${patientId} AND marker_name = 'CEA' LIMIT 1`;
  const ins = (documentId: string, value: string) => sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, as_of_date, coverage_status, verification_state)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${marker.id}, 'marker_value', ${value}, 'ng/mL', '2026-06-15', 'value_found', 'unverified') RETURNING *`;
  await ins(liveDoc.id, "4.2");
  const [heldFact] = await ins(heldDoc.id, "99");
  expect(await detectConflicts(sql, heldFact, { dryRun: true })).toEqual([]);
  // control: once confirmed, the same pair does conflict
  await sql`UPDATE documents SET identity_status = 'confirmed' WHERE id = ${heldDoc.id}`;
  expect((await detectConflicts(sql, heldFact, { dryRun: true })).length).toBe(1);
});
