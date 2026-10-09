import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientTimeline } from "./patients";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitAId: string;
let visitBId: string;
let ceaMarkerId: string;
let psaMarkerId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "timeline-route-staff");
  oncologist = await createTestUser("oncologist", "timeline-route-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitAId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: visitBId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  [{ id: ceaMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  [{ id: psaMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'PSA', false, ${staff.id}) RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newDocument(visitId: string, documentType: "blood" | "radiology" = "blood"): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', ${documentType}, 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  return doc.id;
}

async function newFact(documentId: string, visitId: string, o: Record<string, unknown> = {}): Promise<string> {
  const f = {
    fieldType: "marker_value", value: "4.2", asOf: "2026-02-01" as string | null,
    coverage: "value_found", verification: "oncologist_signed_off",
    markerId: null as string | null, sourcePage: null as number | null, sourceLocation: null as string | null,
    sourceSnippet: null as string | null, signedOffBy: oncologist.id as string | null, ...o,
  };
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value,
      as_of_date, coverage_status, verification_state, source_page, source_location, source_snippet, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${f.markerId}, ${f.fieldType}, ${f.value},
      ${f.asOf}, ${f.coverage}, ${f.verification}, ${f.sourcePage}, ${f.sourceLocation}, ${f.sourceSnippet}, ${f.signedOffBy})
    RETURNING id`;
  return row.id;
}

function timelineReq(id: string) {
  const req = new Request(`http://localhost/patients/${id}/timeline`) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

test("404s for an unknown or malformed patient id", async () => {
  expect((await getPatientTimeline(timelineReq("00000000-0000-0000-0000-000000000000"))).status).toBe(404);
  expect((await getPatientTimeline(timelineReq("not-a-uuid"))).status).toBe(404);
});

test("200 with all-empty arrays for a patient with no signed-off facts yet", async () => {
  const freshPatient = await createTestPatient(staff.id);
  try {
    const res = await getPatientTimeline(timelineReq(freshPatient.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ markers: [], treatment: [], radiology: [] });
  } finally {
    await deleteTestPatients(freshPatient.id);
  }
});

test("spans the patient's full history, not just the current visit", async () => {
  const docA = await newDocument(visitAId);
  const docB = await newDocument(visitBId);
  const factA = await newFact(docA, visitAId, { markerId: ceaMarkerId, asOf: "2026-01-01", value: "3.0" });
  const factB = await newFact(docB, visitBId, { markerId: ceaMarkerId, asOf: "2026-02-01", value: "9.0" });

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  const cea = body.markers.find((m: any) => m.tracked_marker_id === ceaMarkerId);
  expect(cea.points.map((p: any) => p.fact_id).sort()).toEqual([factA, factB].sort());
});

test("unverified and staff-corrected facts are excluded; only oncologist_signed_off is included", async () => {
  const doc = await newDocument(visitBId);
  await newFact(doc, visitBId, { markerId: psaMarkerId, verification: "unverified", asOf: "2026-02-01" });
  await newFact(doc, visitBId, { markerId: psaMarkerId, verification: "staff_corrected", asOf: "2026-02-01" });
  const signedOff = await newFact(doc, visitBId, { markerId: psaMarkerId, verification: "oncologist_signed_off", asOf: "2026-02-02", value: "1.5" });

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  const psa = body.markers.find((m: any) => m.tracked_marker_id === psaMarkerId);
  expect(psa.points.map((p: any) => p.fact_id)).toEqual([signedOff]);
});

test("a fact that lost an authoritative-pick conflict resolution is excluded", async () => {
  const doc = await newDocument(visitBId);
  const winner = await newFact(doc, visitBId, { fieldType: "treatment_regimen", asOf: "2026-02-05", value: "FOLFOX" });
  const loser = await newFact(doc, visitBId, { fieldType: "treatment_regimen", asOf: "2026-02-05", value: "FOLFIRI" });
  await sql`
    INSERT INTO conflicts (fact_id_a, fact_id_b, status, authoritative_fact_id)
    VALUES (${winner}, ${loser}, 'resolved', ${winner})
  `;

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  const ids = body.treatment.map((t: any) => t.fact_id);
  expect(ids).toContain(winner);
  expect(ids).not.toContain(loser);
});

// An undated oncologist_signed_off fact can't actually reach the database: migration
// 003's no_signoff_while_undated CHECK constraint already forbids it (the as-of date
// is part of what the oncologist attests to on sign-off). The endpoint's own
// `AND f.as_of_date IS NOT NULL` filter in each loader is defensive-only -- this test
// proves the invariant it relies on is still enforced at the DB level, rather than
// (impossibly) constructing the row the filter would otherwise need to exclude.
test("the DB forbids an oncologist_signed_off fact with no as_of_date, which is what lets the timeline place every signed-off fact on its axis", async () => {
  const doc = await newDocument(visitBId);
  await expect(
    newFact(doc, visitBId, { fieldType: "radiology_impression", asOf: null, value: "no date given" }),
  ).rejects.toThrow(/no_signoff_while_undated/);
});

test("a tracked marker with zero signed-off points anywhere is omitted from markers entirely", async () => {
  const [{ id: lonelyMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'AFP', false, ${staff.id}) RETURNING id`;

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  expect(body.markers.find((m: any) => m.tracked_marker_id === lonelyMarkerId)).toBeUndefined();
});

test("treatment/radiology entries carry flat provenance fields with the correct fallback_level", async () => {
  const doc = await newDocument(visitBId, "radiology");
  const factId = await newFact(doc, visitBId, {
    fieldType: "radiology_impression", asOf: "2026-02-11", value: "no new lesions",
    sourcePage: 2, sourceSnippet: "no new lesions identified",
  });

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  const entry = body.radiology.find((r: any) => r.fact_id === factId);
  expect(entry).toMatchObject({
    fact_id: factId, value: "no new lesions", document_id: doc,
    source_page: 2, source_snippet: "no new lesions identified", fallback_level: "exact",
  });
});
