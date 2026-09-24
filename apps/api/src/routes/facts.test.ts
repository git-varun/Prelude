import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getDocumentFacts } from "./facts";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let otherPatientId: string;
let visitId: string;
let ceaMarkerId: string;
let otherPatientMarkerId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "facts-route-staff");
  oncologist = await createTestUser("oncologist", "facts-route-onc");
  patientId = (await createTestPatient(staff.id)).id;
  otherPatientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: ceaMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  [{ id: otherPatientMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${otherPatientId}, 'PSA', false, ${staff.id}) RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId, otherPatientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newDocument(): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  return doc.id;
}

async function newFact(documentId: string, o: Record<string, unknown> = {}): Promise<string> {
  const f = {
    value: "4.2", asOf: "2026-02-01", needsDate: false, coverage: "value_found", verification: "unverified",
    rawLabel: null as string | null, markerId: null as string | null, ...o,
  };
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, raw_marker_label, field_type, value,
      as_of_date, needs_manual_date, coverage_status, verification_state, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${f.markerId}, ${f.rawLabel}, 'marker_value', ${f.value},
      ${f.asOf}, ${f.needsDate}, ${f.coverage}, ${f.verification},
      ${f.verification === "oncologist_signed_off" ? oncologist.id : null})
    RETURNING id`;
  return row.id;
}

function getReq(id: string) {
  const req = new Request(`http://localhost/documents/${id}/facts`) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

function patchReq(id: string, body: unknown) {
  const req = new Request(`http://localhost/facts/${id}`, { method: "PATCH", body: JSON.stringify(body) }) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

test("GET returns the document, its facts (dates as YYYY-MM-DD, marker name joined) and the patient's markers", async () => {
  const docId = await newDocument();
  await newFact(docId, { markerId: ceaMarkerId });
  await newFact(docId, { asOf: null, needsDate: true, rawLabel: "Mystery", coverage: "extraction_uncertain" });

  const res = await getDocumentFacts(getReq(docId));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.document.id).toBe(docId);
  expect(body.facts).toHaveLength(2);
  const mapped = body.facts.find((f: any) => f.tracked_marker_id === ceaMarkerId);
  expect(mapped.tracked_marker_name).toBe("CEA");
  expect(mapped.as_of_date).toBe("2026-02-01");
  const undated = body.facts.find((f: any) => f.needs_manual_date);
  expect(undated.as_of_date).toBeNull();
  expect(undated.raw_marker_label).toBe("Mystery");
  expect(body.tracked_markers.map((m: any) => m.marker_name)).toEqual(["CEA"]);
});

test("GET returns 404 for an unknown or malformed document id", async () => {
  expect((await getDocumentFacts(getReq("00000000-0000-0000-0000-000000000000"))).status).toBe(404);
  expect((await getDocumentFacts(getReq("not-a-uuid"))).status).toBe(404);
});
