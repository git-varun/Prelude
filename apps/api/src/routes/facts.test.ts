import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getDocumentFacts, patchFact } from "./facts";
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

async function factRow(id: string) {
  const [row] = await sql`SELECT *, to_char(as_of_date, 'YYYY-MM-DD') AS as_of_str FROM facts WHERE id = ${id}`;
  return row;
}

async function correctAuditCount(id: string): Promise<number> {
  const rows = await sql`SELECT id FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${id} AND action = 'correct'`;
  return rows.length;
}

test("PATCH value on an extraction_uncertain fact stores it, flips coverage to value_found, marks staff_corrected, audits", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { coverage: "extraction_uncertain", value: "4.?", rawLabel: "Lbl" });
  const res = await patchFact(patchReq(id, { value: "4.2" }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.value).toBe("4.2");
  expect(row.coverage_status).toBe("value_found");
  expect(row.verification_state).toBe("staff_corrected");
  expect(row.corrected_by).toBe(staff.id);
  expect(row.as_of_str).toBe("2026-02-01");
  expect(row.raw_marker_label).toBe("Lbl");
  expect(row.needs_manual_date).toBe(false);

  const [audit] = await sql`SELECT * FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${id} AND action = 'correct'`;
  expect(audit.actor_id).toBe(staff.id);
  expect(JSON.parse(audit.before_value).value).toBe("4.?");
  expect(JSON.parse(audit.after_value).value).toBe("4.2");
});

test("PATCH value does not change coverage_status when it was not extraction_uncertain", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { coverage: "not_applicable" });
  await patchFact(patchReq(id, { value: "x" }), asAuthedUser(staff));
  expect((await factRow(id)).coverage_status).toBe("not_applicable");
});

test("PATCH tracked_marker_id maps the marker, clears raw_marker_label, leaves coverage_status alone", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { rawLabel: "Carcino Embryonic", coverage: "extraction_uncertain" });
  const res = await patchFact(patchReq(id, { tracked_marker_id: ceaMarkerId }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.tracked_marker_id).toBe(ceaMarkerId);
  expect(row.raw_marker_label).toBeNull();
  expect(row.coverage_status).toBe("extraction_uncertain");
  expect(row.verification_state).toBe("staff_corrected");
  expect(((await res.json()) as any).tracked_marker_name).toBe("CEA");
  expect(row.value).toBe("4.2");
  expect(row.as_of_str).toBe("2026-02-01");
  expect(row.needs_manual_date).toBe(false);
  expect(await correctAuditCount(id)).toBe(1);
});

test("PATCH rejects a tracked_marker_id that belongs to another patient", async () => {
  const docId = await newDocument();
  const id = await newFact(docId);
  const res = await patchFact(patchReq(id, { tracked_marker_id: otherPatientMarkerId }), asAuthedUser(staff));
  expect(res.status).toBe(400);
  expect((await factRow(id)).tracked_marker_id).toBeNull();
  expect((await factRow(id)).verification_state).toBe("unverified");
  expect(await correctAuditCount(id)).toBe(0);
});

test("PATCH as_of_date clears the fact's needs_manual_date and recomputes the document flag", async () => {
  const docId = await newDocument();
  const a = await newFact(docId, { asOf: null, needsDate: true, rawLabel: "Lbl" });
  const b = await newFact(docId, { asOf: null, needsDate: true });
  await sql`UPDATE documents SET needs_manual_date = true WHERE id = ${docId}`;

  const dres = await patchFact(patchReq(a, { as_of_date: "2026-03-05" }), asAuthedUser(staff));
  expect(((await dres.json()) as any).as_of_date).toBe("2026-03-05");
  const ra = await factRow(a);
  expect(ra.value).toBe("4.2");
  expect(ra.tracked_marker_id).toBeNull();
  expect(ra.raw_marker_label).toBe("Lbl");
  expect(await correctAuditCount(a)).toBe(1);
  let [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${docId}`;
  expect(doc.needs_manual_date).toBe(true); // b is still undated
  expect((await factRow(a)).needs_manual_date).toBe(false);

  await patchFact(patchReq(b, { as_of_date: "2026-03-06" }), asAuthedUser(staff));
  [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${docId}`;
  expect(doc.needs_manual_date).toBe(false);
});

test("PATCH returns 409 for an oncologist_signed_off fact and changes nothing", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { verification: "oncologist_signed_off" });
  const res = await patchFact(patchReq(id, { value: "9.9" }), asAuthedUser(oncologist));
  expect(res.status).toBe(409);
  expect((await factRow(id)).value).toBe("4.2");
  expect((await factRow(id)).verification_state).toBe("oncologist_signed_off");
  expect(await correctAuditCount(id)).toBe(0);
});

test("PATCH is allowed from reopened_by_oncologist and lands in staff_corrected, not signed off", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { verification: "reopened_by_oncologist" });
  const res = await patchFact(patchReq(id, { value: "5.0" }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  expect((await factRow(id)).verification_state).toBe("staff_corrected");
});

test("PATCH validates the body", async () => {
  const docId = await newDocument();
  const id = await newFact(docId);
  for (const body of [{}, { value: "" }, { value: "   " }, { value: 5 }, { as_of_date: "2026-13-45" }, { as_of_date: "03/05/2026" }, { as_of_date: "0000-01-01" }, { tracked_marker_id: "nope" }]) {
    expect((await patchFact(patchReq(id, body), asAuthedUser(staff))).status).toBe(400);
  }
  const bad = new Request("http://localhost/facts/x", { method: "PATCH", body: "{not json" }) as Request & { params: { id: string } };
  bad.params = { id };
  expect((await patchFact(bad, asAuthedUser(staff))).status).toBe(400);
});

test("PATCH 404s for an unknown or malformed fact id", async () => {
  expect((await patchFact(patchReq("00000000-0000-0000-0000-000000000000", { value: "1" }), asAuthedUser(staff))).status).toBe(404);
  expect((await patchFact(patchReq("nope", { value: "1" }), asAuthedUser(staff))).status).toBe(404);
});

test("PATCH value-only on an undated fact leaves as_of_date null and needs_manual_date true", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { asOf: null, needsDate: true });
  const res = await patchFact(patchReq(id, { value: "7" }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.as_of_date).toBeNull();
  expect(row.needs_manual_date).toBe(true);
});

test("concurrent date PATCHes on sibling facts leave the document flag false", async () => {
  const docId = await newDocument();
  const a = await newFact(docId, { asOf: null, needsDate: true });
  const b = await newFact(docId, { asOf: null, needsDate: true });
  await sql`UPDATE documents SET needs_manual_date = true WHERE id = ${docId}`;
  const [ra, rb] = await Promise.all([
    patchFact(patchReq(a, { as_of_date: "2026-03-05" }), asAuthedUser(staff)),
    patchFact(patchReq(b, { as_of_date: "2026-03-06" }), asAuthedUser(staff)),
  ]);
  expect([ra.status, rb.status]).toEqual([200, 200]);
  const [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${docId}`;
  expect(doc.needs_manual_date).toBe(false);
  expect((await factRow(a)).needs_manual_date).toBe(false);
  expect((await factRow(b)).needs_manual_date).toBe(false);
});
