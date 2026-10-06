import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getDocumentFacts, patchFact, signOffFact, reopenFact } from "./facts";
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

test("GET facts carry fallback_level, computed the same way as the snapshot's provenance (exact / page / document)", async () => {
  const docId = await newDocument();
  const [exact] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, source_page, source_snippet)
    VALUES (${patientId}, ${visitId}, ${docId}, 'radiology_impression', 'Stable', '2026-02-01', 'value_found', 'unverified', 2, 'Stable disease') RETURNING id`;
  const [page] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, source_page, source_snippet)
    VALUES (${patientId}, ${visitId}, ${docId}, 'radiology_impression', 'No change', '2026-02-01', 'value_found', 'unverified', 3, NULL) RETURNING id`;
  const [doc] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, source_page, source_snippet)
    VALUES (${patientId}, ${visitId}, ${docId}, 'radiology_impression', 'Unremarkable', '2026-02-01', 'value_found', 'unverified', NULL, NULL) RETURNING id`;

  const body = (await (await getDocumentFacts(getReq(docId))).json()) as any;
  const levels = Object.fromEntries(body.facts.map((f: any) => [f.id, f.fallback_level]));
  expect(levels[exact.id]).toBe("exact");
  expect(levels[page.id]).toBe("page");
  expect(levels[doc.id]).toBe("document");
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

test("PATCH as_of_date makes a previously-undated fact eligible for conflict detection against a live same-date fact", async () => {
  const docId = await newDocument();
  const dated = await newFact(docId, { value: "9.0", asOf: "2026-07-01", markerId: ceaMarkerId });
  const undated = await newFact(docId, { value: "4.2", asOf: null, needsDate: true, markerId: ceaMarkerId });

  const res = await patchFact(patchReq(undated, { as_of_date: "2026-07-01" }), asAuthedUser(staff));
  expect(res.status).toBe(200);

  expect((await factRow(dated)).coverage_status).toBe("conflicting_sources");
  expect((await factRow(undated)).coverage_status).toBe("conflicting_sources");

  const [conflict] = await sql`
    SELECT id FROM conflicts
    WHERE (fact_id_a = ${dated} AND fact_id_b = ${undated}) OR (fact_id_a = ${undated} AND fact_id_b = ${dated})`;
  expect(conflict).toBeTruthy();
  await sql`DELETE FROM conflicts WHERE id = ${conflict.id}`;
});

test("bulk date-entry (sequential per-fact PATCHes, the web 'apply date to all' path) detects a conflict only once both facts are dated", async () => {
  // The web Extraction Review screen's "apply date to all" applies a date via
  // sequential PATCH /facts/:id calls (docs/m2-backlog.md) — there is no
  // separate bulk backend endpoint, so this exercises the same patchFact path.
  const docId = await newDocument();
  const a = await newFact(docId, { value: "4.2", asOf: null, needsDate: true, markerId: ceaMarkerId });
  const b = await newFact(docId, { value: "9.0", asOf: null, needsDate: true, markerId: ceaMarkerId });

  const r1 = await patchFact(patchReq(a, { as_of_date: "2026-08-01" }), asAuthedUser(staff));
  expect(r1.status).toBe(200);
  expect((await factRow(a)).coverage_status).toBe("value_found");
  let [conflict] = await sql`
    SELECT id FROM conflicts WHERE (fact_id_a = ${a} AND fact_id_b = ${b}) OR (fact_id_a = ${b} AND fact_id_b = ${a})`;
  expect(conflict).toBeUndefined();

  const r2 = await patchFact(patchReq(b, { as_of_date: "2026-08-01" }), asAuthedUser(staff));
  expect(r2.status).toBe(200);
  expect((await factRow(a)).coverage_status).toBe("conflicting_sources");
  expect((await factRow(b)).coverage_status).toBe("conflicting_sources");
  [conflict] = await sql`
    SELECT id FROM conflicts WHERE (fact_id_a = ${a} AND fact_id_b = ${b}) OR (fact_id_a = ${b} AND fact_id_b = ${a})`;
  expect(conflict).toBeTruthy();
  await sql`DELETE FROM conflicts WHERE id = ${conflict.id}`;
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

// --- extraction_uncertain correction transitions: the reviewer states which outcome they mean via `resolution` ---

async function uncertainFact(): Promise<string> {
  return newFact(await newDocument(), { coverage: "extraction_uncertain", value: "4.?", rawLabel: "Lbl" });
}

test("PATCH resolution=value_found with a verified value, unit and range → value_found, all stored, audited", async () => {
  const id = await uncertainFact();
  const res = await patchFact(
    patchReq(id, { resolution: "value_found", value: "4.2", unit: "ng/mL", reference_range: "0-5" }),
    asAuthedUser(staff),
  );
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.coverage_status).toBe("value_found");
  expect(row.value).toBe("4.2");
  expect(row.unit).toBe("ng/mL");
  expect(row.reference_range).toBe("0-5");
  expect(row.verification_state).toBe("staff_corrected");
  expect(row.corrected_by).toBe(staff.id);
  const [audit] = await sql`SELECT * FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${id} AND action = 'correct'`;
  expect(audit.actor_id).toBe(staff.id);
  expect(JSON.parse(audit.before_value).unit).toBeNull();
  expect(JSON.parse(audit.after_value).unit).toBe("ng/mL");
  expect(JSON.parse(audit.after_value).reference_range).toBe("0-5");
});

test("PATCH resolution=no_usable_value → not_assessed, value cleared", async () => {
  const id = await uncertainFact();
  const res = await patchFact(patchReq(id, { resolution: "no_usable_value" }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.coverage_status).toBe("not_assessed");
  expect(row.value).toBeNull();
  expect(row.verification_state).toBe("staff_corrected");
  expect(await correctAuditCount(id)).toBe(1);
});

test("PATCH resolution=source_states_not_performed → not_applicable, value cleared", async () => {
  const id = await uncertainFact();
  const res = await patchFact(patchReq(id, { resolution: "source_states_not_performed" }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.coverage_status).toBe("not_applicable");
  expect(row.value).toBeNull();
  expect(row.verification_state).toBe("staff_corrected");
});

test("PATCH resolution is never inferred from value: value_found without a value, or a 'no value' resolution with a value, is 400", async () => {
  const id = await uncertainFact();
  for (const body of [
    { resolution: "value_found" },
    { resolution: "no_usable_value", value: "4.2" },
    { resolution: "source_states_not_performed", value: "4.2" },
  ]) {
    expect((await patchFact(patchReq(id, body), asAuthedUser(staff))).status).toBe(400);
  }
  const row = await factRow(id);
  expect(row.coverage_status).toBe("extraction_uncertain");
  expect(row.verification_state).toBe("unverified");
  expect(await correctAuditCount(id)).toBe(0);
});

test("PATCH can never set conflicting_sources or not_found_in_document_set", async () => {
  const id = await uncertainFact();
  for (const body of [
    { resolution: "conflicting_sources" },
    { resolution: "not_found_in_document_set" },
    { coverage_status: "conflicting_sources", value: "1" },
    { coverage_status: "not_found_in_document_set", value: "1" },
    { coverage_status: "value_found", value: "1" },
  ]) {
    expect((await patchFact(patchReq(id, body), asAuthedUser(staff))).status).toBe(400);
  }
  expect((await factRow(id)).coverage_status).toBe("extraction_uncertain");
  expect(await correctAuditCount(id)).toBe(0);
});

test("PATCH with a resolution on a fact that is not extraction_uncertain is 409 and changes nothing", async () => {
  const id = await newFact(await newDocument(), { coverage: "value_found" });
  const res = await patchFact(patchReq(id, { resolution: "no_usable_value" }), asAuthedUser(staff));
  expect(res.status).toBe(409);
  const row = await factRow(id);
  expect(row.coverage_status).toBe("value_found");
  expect(row.value).toBe("4.2");
  expect(await correctAuditCount(id)).toBe(0);
});

test("PATCH unit and reference_range alone update those fields without touching coverage", async () => {
  const id = await newFact(await newDocument());
  const res = await patchFact(patchReq(id, { unit: "mg/dL", reference_range: "1-2" }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.unit).toBe("mg/dL");
  expect(row.reference_range).toBe("1-2");
  expect(row.coverage_status).toBe("value_found");
  expect(row.verification_state).toBe("staff_corrected");
  expect(await correctAuditCount(id)).toBe(1);
});

test("PATCH with a resolution on an oncologist_signed_off fact is 409 even for an oncologist", async () => {
  const id = await newFact(await newDocument(), { coverage: "extraction_uncertain", verification: "oncologist_signed_off" });
  const res = await patchFact(patchReq(id, { resolution: "no_usable_value" }), asAuthedUser(oncologist));
  expect(res.status).toBe(409);
  expect((await factRow(id)).coverage_status).toBe("extraction_uncertain");
});

// --- POST /facts/:id/sign-off ---

function signOffReq(id: string) {
  const req = new Request(`http://localhost/facts/${id}/sign-off`, { method: "POST" }) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

for (const state of ["unverified", "staff_corrected", "reopened_by_oncologist"]) {
  test(`sign-off from ${state} → oncologist_signed_off with signed_off_by/at set, and audited`, async () => {
    const id = await newFact(await newDocument(), { verification: state, markerId: ceaMarkerId });
    const res = await signOffFact(signOffReq(id), asAuthedUser(oncologist));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).verification_state).toBe("oncologist_signed_off");
    const row = await factRow(id);
    expect(row.verification_state).toBe("oncologist_signed_off");
    expect(row.signed_off_by).toBe(oncologist.id);
    expect(row.signed_off_at).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - row.signed_off_at.getTime())).toBeLessThan(60_000);

    const rows = await sql`SELECT * FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${id} AND action = 'sign_off'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor_id).toBe(oncologist.id);
    expect(JSON.parse(rows[0].before_value).verification_state).toBe(state);
    expect(JSON.parse(rows[0].after_value).verification_state).toBe("oncologist_signed_off");
    expect(JSON.parse(rows[0].after_value).signed_off_by).toBe(oncologist.id);
  });
}

async function signOffAuditCount(id: string): Promise<number> {
  return (await sql`SELECT id FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${id} AND action = 'sign_off'`).length;
}

test("sign-off of an already oncologist_signed_off fact is 409, changes nothing, writes no audit row", async () => {
  const id = await newFact(await newDocument(), { verification: "oncologist_signed_off" });
  const before = await factRow(id);
  const res = await signOffFact(signOffReq(id), asAuthedUser(oncologist));
  expect(res.status).toBe(409);
  const after = await factRow(id);
  expect(after.signed_off_at).toEqual(before.signed_off_at);
  expect(await signOffAuditCount(id)).toBe(0);
});

test("sign-off of an undated fact is a clean 409 (not a raw DB constraint error)", async () => {
  const id = await newFact(await newDocument(), { asOf: null, needsDate: true });
  const res = await signOffFact(signOffReq(id), asAuthedUser(oncologist));
  expect(res.status).toBe(409);
  expect((await factRow(id)).verification_state).toBe("unverified");
  expect(await signOffAuditCount(id)).toBe(0);
});

test("sign-off of an unmapped marker_value fact (tracked_marker_id null) is a clean 409, unchanged in the DB, no audit row", async () => {
  const id = await newFact(await newDocument(), { rawLabel: "Mystery", markerId: null });
  const before = await factRow(id);
  const res = await signOffFact(signOffReq(id), asAuthedUser(oncologist));
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).message).toBe("A marker must be mapped to a tracked marker before sign-off.");
  const after = await factRow(id);
  expect(after.verification_state).toBe("unverified");
  expect(after.signed_off_by).toEqual(before.signed_off_by);
  expect(after.signed_off_at).toEqual(before.signed_off_at);
  expect(await signOffAuditCount(id)).toBe(0);
});

test("sign-off of a mapped marker_value fact is unaffected by the unmapped-marker guard", async () => {
  const id = await newFact(await newDocument(), { markerId: ceaMarkerId });
  const res = await signOffFact(signOffReq(id), asAuthedUser(oncologist));
  expect(res.status).toBe(200);
});

test("sign-off is blocked with 409 by an open or annotated conflict on either side, allowed once resolved", async () => {
  const docId = await newDocument();
  const a = await newFact(docId, { markerId: ceaMarkerId });
  const b = await newFact(docId, { markerId: ceaMarkerId });
  const [c] = await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open') RETURNING id`;
  try {
    for (const status of ["open", "annotated"]) {
      await sql`UPDATE conflicts SET status = ${status} WHERE id = ${c.id}`;
      // fact_id_a side and fact_id_b side both block
      for (const id of [a, b]) {
        expect((await signOffFact(signOffReq(id), asAuthedUser(oncologist))).status).toBe(409);
        expect((await factRow(id)).verification_state).toBe("unverified");
        expect(await signOffAuditCount(id)).toBe(0);
      }
    }
    await sql`UPDATE conflicts SET status = 'resolved' WHERE id = ${c.id}`;
    expect((await signOffFact(signOffReq(a), asAuthedUser(oncologist))).status).toBe(200);
  } finally {
    await sql`DELETE FROM conflicts WHERE id = ${c.id}`;
  }
});

test("sign-off 404s for an unknown or malformed fact id", async () => {
  expect((await signOffFact(signOffReq("00000000-0000-0000-0000-000000000000"), asAuthedUser(oncologist))).status).toBe(404);
  expect((await signOffFact(signOffReq("nope"), asAuthedUser(oncologist))).status).toBe(404);
});

// --- POST /facts/:id/reopen ---

function reopenReq(id: string) {
  const req = new Request(`http://localhost/facts/${id}/reopen`, { method: "POST" }) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

async function reopenAuditCount(id: string): Promise<number> {
  return (await sql`SELECT id FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${id} AND action = 'reopen'`).length;
}

test("reopen of an oncologist_signed_off fact → reopened_by_oncologist with reopened_by/at set, and audited", async () => {
  const id = await newFact(await newDocument(), { verification: "oncologist_signed_off" });
  const res = await reopenFact(reopenReq(id), asAuthedUser(oncologist));
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).verification_state).toBe("reopened_by_oncologist");
  const row = await factRow(id);
  expect(row.verification_state).toBe("reopened_by_oncologist");
  expect(row.reopened_by).toBe(oncologist.id);
  expect(row.reopened_at).toBeInstanceOf(Date);
  expect(Math.abs(Date.now() - row.reopened_at.getTime())).toBeLessThan(60_000);

  const rows = await sql`SELECT * FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${id} AND action = 'reopen'`;
  expect(rows).toHaveLength(1);
  expect(rows[0].actor_id).toBe(oncologist.id);
  expect(JSON.parse(rows[0].before_value).verification_state).toBe("oncologist_signed_off");
  expect(JSON.parse(rows[0].after_value).verification_state).toBe("reopened_by_oncologist");
  expect(JSON.parse(rows[0].after_value).reopened_by).toBe(oncologist.id);
});

test("reopen leaves signed_off_by and signed_off_at unchanged", async () => {
  const id = await newFact(await newDocument(), { verification: "oncologist_signed_off" });
  await sql`UPDATE facts SET signed_off_at = '2026-01-15T10:00:00Z' WHERE id = ${id}`;
  const before = await factRow(id);
  expect((await reopenFact(reopenReq(id), asAuthedUser(oncologist))).status).toBe(200);
  const after = await factRow(id);
  expect(after.signed_off_by).toBe(oncologist.id);
  expect(after.signed_off_by).toBe(before.signed_off_by);
  expect(after.signed_off_at).toEqual(before.signed_off_at);
});

for (const state of ["unverified", "staff_corrected", "reopened_by_oncologist"]) {
  test(`reopen from ${state} is 409, changes nothing, writes no audit row`, async () => {
    const id = await newFact(await newDocument(), { verification: state });
    const res = await reopenFact(reopenReq(id), asAuthedUser(oncologist));
    expect(res.status).toBe(409);
    const row = await factRow(id);
    expect(row.verification_state).toBe(state);
    expect(row.reopened_by).toBeNull();
    expect(row.reopened_at).toBeNull();
    expect(await reopenAuditCount(id)).toBe(0);
  });
}

test("reopen 404s for an unknown or malformed fact id", async () => {
  expect((await reopenFact(reopenReq("00000000-0000-0000-0000-000000000000"), asAuthedUser(oncologist))).status).toBe(404);
  expect((await reopenFact(reopenReq("nope"), asAuthedUser(oncologist))).status).toBe(404);
});

test("reopen is not blocked by an open conflict (only sign-off is)", async () => {
  const docId = await newDocument();
  const a = await newFact(docId, { verification: "oncologist_signed_off" });
  const b = await newFact(docId);
  const [c] = await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open') RETURNING id`;
  try {
    expect((await reopenFact(reopenReq(a), asAuthedUser(oncologist))).status).toBe(200);
  } finally {
    await sql`DELETE FROM conflicts WHERE id = ${c.id}`;
  }
});

test("a reopened fact corrected via PATCH lands in staff_corrected and keeps the prior sign-off record", async () => {
  const id = await newFact(await newDocument(), { verification: "oncologist_signed_off" });
  await reopenFact(reopenReq(id), asAuthedUser(oncologist));
  expect((await patchFact(patchReq(id, { value: "6.1" }), asAuthedUser(staff))).status).toBe(200);
  const row = await factRow(id);
  expect(row.verification_state).toBe("staff_corrected");
  expect(row.signed_off_by).toBe(oncologist.id);
  expect(row.reopened_by).toBe(oncologist.id);
});

// --- has_blocking_conflict on GET /documents/:id/facts ---

async function blockingFlags(docId: string): Promise<Record<string, boolean>> {
  const body = (await (await getDocumentFacts(getReq(docId))).json()) as any;
  return Object.fromEntries(body.facts.map((f: any) => [f.id, f.has_blocking_conflict]));
}

test("has_blocking_conflict is false for a fact with no conflicts", async () => {
  const docId = await newDocument();
  const id = await newFact(docId);
  expect(await blockingFlags(docId)).toEqual({ [id]: false });
});

test("has_blocking_conflict flips true for both facts of an open or annotated conflict, and false once resolved", async () => {
  const docId = await newDocument();
  const a = await newFact(docId);
  const b = await newFact(docId);
  const c = await newFact(docId); // uninvolved
  const [row] = await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open') RETURNING id`;
  try {
    for (const status of ["open", "annotated"]) {
      await sql`UPDATE conflicts SET status = ${status} WHERE id = ${row.id}`;
      expect(await blockingFlags(docId)).toEqual({ [a]: true, [b]: true, [c]: false });
    }
    await sql`UPDATE conflicts SET status = 'resolved' WHERE id = ${row.id}`;
    expect(await blockingFlags(docId)).toEqual({ [a]: false, [b]: false, [c]: false });
  } finally {
    await sql`DELETE FROM conflicts WHERE id = ${row.id}`;
  }
});

test("blocking_conflict_id carries the conflict id for a blocked fact, so the UI can link to it; null once resolved", async () => {
  const docId = await newDocument();
  const a = await newFact(docId);
  const b = await newFact(docId);
  const [row] = await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open') RETURNING id`;
  try {
    const body = (await (await getDocumentFacts(getReq(docId))).json()) as any;
    const factA = body.facts.find((f: any) => f.id === a);
    expect(factA.blocking_conflict_id).toBe(row.id);

    await sql`UPDATE conflicts SET status = 'resolved' WHERE id = ${row.id}`;
    const bodyAfter = (await (await getDocumentFacts(getReq(docId))).json()) as any;
    expect(bodyAfter.facts.find((f: any) => f.id === a).blocking_conflict_id).toBeNull();
  } finally {
    await sql`DELETE FROM conflicts WHERE id = ${row.id}`;
  }
});

test("sign-off and reopen responses carry has_blocking_conflict too", async () => {
  const id = await newFact(await newDocument(), { markerId: ceaMarkerId });
  const res = await signOffFact(signOffReq(id), asAuthedUser(oncologist));
  expect(((await res.json()) as any).has_blocking_conflict).toBe(false);
});
