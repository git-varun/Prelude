import { test, expect, beforeAll, afterAll } from "bun:test";
import { AS_WRITTEN_FIELD_TYPES, MULTI_VALUED_FIELD_TYPES, SPOT_CHECK_ERRORS_BY_FIELD_TYPE } from "@prelude/shared";
import type { OcrResult } from "@prelude/shared";
import { sql } from "../../db/client";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../../test-helpers";
import { detectConflicts } from "../rules";
import { persistExtractedFacts } from "../facts";
import { FIELD_TYPES_BY_DOCUMENT_TYPE, promptFor, toExtractedFactCandidate, type RawCandidate } from "./anthropicExtraction";

// M3-01 (AM-04): tier 1 "as written" field types.

function raw(overrides: Partial<RawCandidate> = {}): RawCandidate {
  return {
    trackedMarkerLabel: null, value: "x", unit: null, referenceRange: null, asOfDate: "2026-10-01", coverageStatus: "value_found",
    sourcePage: 1, sourceLocation: null, sourceSnippet: null, facility: null, confidence: 0.9, ...overrides,
  };
}
const ocr = (text: string): OcrResult => ({ fullText: text, pages: [], providerName: "test", providerRaw: null });

test("each document type that can state a tier 1 field is asked for it", () => {
  expect(FIELD_TYPES_BY_DOCUMENT_TYPE.pathology).toEqual(["diagnosis", "histology_ihc", "stage", "surgery_procedure"]);
  expect(FIELD_TYPES_BY_DOCUMENT_TYPE.discharge).toEqual(
    expect.arrayContaining(["diagnosis", "stage", "surgery_procedure", "treatment_regimen", "next_review_date", "tests_advised", "procedures_planned"]),
  );
  expect(FIELD_TYPES_BY_DOCUMENT_TYPE.prescription).toEqual(
    expect.arrayContaining(["treatment_regimen", "next_review_date", "tests_advised", "procedures_planned"]),
  );
  expect(FIELD_TYPES_BY_DOCUMENT_TYPE.radiology).toContain("lesion_size");
});

test("tier 1 prompts demand verbatim text and forbid computing", () => {
  for (const t of AS_WRITTEN_FIELD_TYPES) {
    const prompt = promptFor(t, "discharge", "text");
    expect(prompt).toContain("character-for-character");
    expect(prompt).toContain("Nothing may be computed or inferred");
  }
});

test("every field type has spot-check error options, each with the two exclusion choices", () => {
  for (const options of Object.values(SPOT_CHECK_ERRORS_BY_FIELD_TYPE)) {
    expect(options).toContain("not_in_document");
    expect(options).toContain("wrong_patient");
  }
  expect(SPOT_CHECK_ERRORS_BY_FIELD_TYPE.surgery_procedure).toContain("facility");
  expect(SPOT_CHECK_ERRORS_BY_FIELD_TYPE.stage).not.toContain("unit");
});

test("an as-written value found in the document (whitespace and case aside) keeps its confidence", () => {
  const r = toExtractedFactCandidate("next_review_date", raw({ value: "review after 2 weeks", confidence: 0.9 }), ocr("Plan: Review  after\n2 weeks"));
  expect(r.value).toBe("review after 2 weeks");
  expect(r.coverageStatus).toBe("value_found");
  expect(r.confidence).toBe(0.9);
});

test("an as-written value that is not in the document is flagged uncertain below the review threshold, not dropped", () => {
  const r = toExtractedFactCandidate("stage", raw({ value: "Stage IIIB", confidence: 0.95 }), ocr("no staging here"));
  expect(r.value).toBe("Stage IIIB");
  expect(r.coverageStatus).toBe("extraction_uncertain");
  expect(r.confidence).toBeLessThan(0.7);
});

test("facility is kept for surgery_procedure only", () => {
  const text = "Left mastectomy at Apollo Hospital";
  const r = raw({ value: "Left mastectomy", facility: "Apollo Hospital" });
  expect(toExtractedFactCandidate("surgery_procedure", r, ocr(text)).facility).toBe("Apollo Hospital");
  expect(toExtractedFactCandidate("tests_advised", r, ocr(text)).facility).toBeNull();
});

let staff: TestUser;
let patientId: string;
let visitId: string;
let documentId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "tier1-test-staff");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-10-01') RETURNING id`;
  [{ id: documentId }] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://test/tier1.pdf', 'discharge', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id);
});

async function newFact(fieldType: string, value: string) {
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${fieldType}, ${value}, '2026-10-01', 'value_found', 'unverified') RETURNING *`;
  return row;
}

async function conflictCount(): Promise<number> {
  const [{ n }] = await sql`
    SELECT count(*)::int AS n FROM conflicts WHERE fact_id_a IN (SELECT id FROM facts WHERE patient_id = ${patientId})`;
  return n;
}

test("multi-valued tier 1 types never conflict: two procedures or tests on one date are both true", async () => {
  for (const fieldType of MULTI_VALUED_FIELD_TYPES) {
    const a = await newFact(fieldType, "first");
    await newFact(fieldType, "second");
    await sql.begin(async (tx) => {
      expect(await detectConflicts(tx, a)).toEqual([]);
    });
  }
  expect(await conflictCount()).toBe(0);
});

test("single-valued tier 1 types still conflict when two sources disagree on one date", async () => {
  const a = await newFact("diagnosis", "Carcinoma breast");
  await newFact("diagnosis", "Carcinoma ovary");
  await sql.begin(async (tx) => {
    expect((await detectConflicts(tx, a)).length).toBe(1);
  });
});

test("persists a surgery fact verbatim with its facility, unverified", async () => {
  const result = await persistExtractedFacts(
    { id: documentId, patient_id: patientId, visit_id: visitId },
    [{
      fieldType: "surgery_procedure", value: "Left mastectomy", unit: null, referenceRange: null, asOfDate: "2026-09-01",
      coverageStatus: "value_found", sourcePage: 1, sourceLocation: null, sourceSnippet: "Left mastectomy at Apollo Hospital",
      confidence: 0.9, facility: "Apollo Hospital",
    }],
    staff.id,
  );
  const [fact] = await sql`SELECT * FROM facts WHERE id = ${result.createdFactIds[0]}`;
  expect(fact.field_type).toBe("surgery_procedure");
  expect(fact.value).toBe("Left mastectomy");
  expect(fact.facility).toBe("Apollo Hospital");
  expect(fact.verification_state).toBe("unverified");
});
