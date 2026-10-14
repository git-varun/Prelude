import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { signOffFact } from "./facts";
import { getPatientPlan, addPlanItem, setPlanItemMatch } from "./plan";
import { createPlanItemFromFact } from "../services/carePlan";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "plan-route-staff");
  oncologist = await createTestUser("oncologist", "plan-route-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newDocument(o: { modality?: string; reportedOn?: string; identity?: string; type?: string } = {}) {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status,
      imaging_modality, reported_on, identity_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', ${o.type ?? "radiology"}::document_type, 'own_hospital', ${staff.id}, 'done',
      ${o.modality ?? null}, ${o.reportedOn ?? null}, ${o.identity ?? null}::identity_status)
    RETURNING id`;
  return doc.id as string;
}

async function newFact(documentId: string, fieldType: string, value: string, asOf = "2026-01-01") {
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, check_state)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${fieldType}::field_type, ${value}, ${asOf}, 'value_found', 'unverified', 'correct')
    RETURNING id`;
  return row.id as string;
}

function req(url: string, id: string, body?: unknown) {
  const r = new Request(url, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) as Request & { params: { id: string } };
  r.params = { id };
  return r;
}
const plan = async (): Promise<any> => (await getPatientPlan(req("http://localhost/p", patientId))).json();
const signOff = (id: string) => signOffFact(req("http://localhost/s", id), asAuthedUser(oncologist));
const add = (body: unknown, user = staff) => addPlanItem(req("http://localhost/p", patientId, body), asAuthedUser(user));
const match = (itemId: string, documentId: string | null) =>
  setPlanItemMatch(req("http://localhost/m", itemId, { document_id: documentId }), asAuthedUser(staff));
const itemByText = (p: any, text: string) => p.items.find((i: any) => i.text === text);

test("sign-off creates plan items for the three types only, verbatim, idempotently; unsigned facts create none", async () => {
  const d = await newDocument({ type: "prescription" });
  const t = await newFact(d, "tests_advised", "CBC within 2 weeks", "2030-02-01");
  const p = await newFact(d, "procedures_planned", "Port insertion", "2030-02-01");
  const r = await newFact(d, "next_review_date", "after 4 weeks", "2030-02-01");
  const other = await newFact(d, "diagnosis", "IDC", "2030-02-01");
  const unsigned = await newFact(d, "tests_advised", "Unsigned test", "2030-02-01");

  expect((await plan()).items.length).toBe(0);
  for (const id of [t, p, r, other]) expect((await signOff(id)).status).toBe(200);

  const before = await plan();
  expect(before.items.map((i: any) => i.text).sort()).toEqual(["CBC within 2 weeks", "Port insertion", "after 4 weeks"]);
  const test1 = itemByText(before, "CBC within 2 weeks");
  expect(test1).toMatchObject({ type: "test", advised_at: "2030-02-01", approx_date: "2030-02-15", source_fact_id: t, source_document_id: d });
  expect(itemByText(before, "Port insertion").type).toBe("procedure");
  expect(before.next_review.text).toBe("after 4 weeks");
  expect(itemByText(before, "Unsigned test")).toBeUndefined();

  // Idempotent: a second sign-off conflicts and a direct re-run creates no duplicate; unsigned facts stay out.
  expect((await signOff(t)).status).toBe(409);
  await createPlanItemFromFact(sql, t, oncologist.id);
  await createPlanItemFromFact(sql, unsigned, oncologist.id);
  expect((await plan()).items.length).toBe(3);
});

test("hand-added item: staff and oncologist, validated", async () => {
  expect((await add({ type: "test", text: "  PET-CT  ", advised_at: "2030-03-01" })).status).toBe(201);
  expect((await add({ type: "review", text: "Clinic", advised_at: "2030-03-02" }, oncologist)).status).toBe(201);
  const item = itemByText(await plan(), "PET-CT");
  expect(item).toMatchObject({ type: "test", source_fact_id: null, source_document_id: null });
  for (const bad of [
    { type: "x", text: "a", advised_at: "2030-03-01" }, { type: "test", text: " ", advised_at: "2030-03-01" },
    { type: "test", text: "a", advised_at: "2030-02-30" }, { type: "test", text: "a" },
  ]) {
    expect((await add(bad)).status).toBe(400);
  }
  expect((await getPatientPlan(req("http://localhost/p", "00000000-0000-0000-0000-000000000000"))).status).toBe(404);
});

test("status: planned, past_advised, report_suggested, report_seen; unmatch returns to suggested", async () => {
  await add({ type: "test", text: "Bone scan in 2 weeks", advised_at: "2030-05-01" });
  await add({ type: "procedure", text: "Biopsy in 2 weeks", advised_at: "2020-01-01" });
  await add({ type: "test", text: "CT abdomen in 2 weeks", advised_at: "2020-01-01" });
  let p = await plan();
  expect(itemByText(p, "Bone scan in 2 weeks")).toMatchObject({ status: "planned", approx_date: "2030-05-15", past_advised: false });
  expect(itemByText(p, "Biopsy in 2 weeks")).toMatchObject({ status: "past_advised", past_advised: true });
  expect(itemByText(p, "CT abdomen in 2 weeks").status).toBe("past_advised");

  const ct = await newDocument({ modality: "ct", reportedOn: "2020-02-01" });
  p = await plan();
  const ctItem = itemByText(p, "CT abdomen in 2 weeks");
  expect(ctItem).toMatchObject({ status: "report_suggested", past_advised: false, suggested_document: { id: ct }, matched_document: null });
  expect(ctItem.suggested_document.label).toContain("CT");
  // A suggestion is never a match: nothing was stored.
  const [stored] = await sql`SELECT matched_document_id FROM care_plan_items WHERE id = ${ctItem.id}`;
  expect(stored.matched_document_id).toBeNull();

  expect((await match(ctItem.id, ct)).status).toBe(200);
  p = await plan();
  expect(itemByText(p, "CT abdomen in 2 weeks")).toMatchObject({ status: "report_seen", matched_document: { id: ct }, suggested_document: null });
  const [confirmed] = await sql`SELECT match_confirmed_by FROM care_plan_items WHERE id = ${ctItem.id}`;
  expect(confirmed.match_confirmed_by).toBe(staff.id);

  expect((await match(ctItem.id, null)).status).toBe(200);
  expect(itemByText(await plan(), "CT abdomen in 2 weeks").status).toBe("report_suggested");
});

test("a report dated on or before the advice is not suggested; the document date falls back to its facts", async () => {
  await add({ type: "test", text: "MRI brain", advised_at: "2031-01-10" });
  await newDocument({ modality: "mri", reportedOn: "2031-01-10" });
  expect(itemByText(await plan(), "MRI brain").status).toBe("planned");
  const undated = await newDocument({ modality: "mri" });
  await newFact(undated, "radiology_impression", "Stable", "2031-02-01");
  expect(itemByText(await plan(), "MRI brain")).toMatchObject({ status: "report_suggested", suggested_document: { id: undated } });
});

test("an 'other' document is never suggested for a plan item and cannot be matched (400)", async () => {
  const item = await add({ type: "test", text: "MRI spine", advised_at: "2034-01-01" });
  const itemId = ((await item.json()) as any).id as string;
  const other = await newDocument({ type: "other", modality: "mri", reportedOn: "2034-02-01" });
  const p = itemByText(await plan(), "MRI spine");
  expect(p).toMatchObject({ status: "planned", suggested_document: null });
  expect((await match(itemId, other)).status).toBe(400);
  const [stored] = await sql`SELECT matched_document_id FROM care_plan_items WHERE id = ${itemId}`;
  expect(stored.matched_document_id).toBeNull();
});

test("lab report suggested by marker name from its live facts", async () => {
  await add({ type: "test", text: "CEA repeat", advised_at: "2032-01-01" });
  const lab = await newDocument({ type: "blood", reportedOn: "2032-01-20" });
  const [tm] = await sql`INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  await sql`INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, as_of_date, coverage_status, verification_state)
            VALUES (${patientId}, ${visitId}, ${lab}, ${tm.id}, 'marker_value', '4.2', '2032-01-20', 'value_found', 'unverified')`;
  expect(itemByText(await plan(), "CEA repeat")).toMatchObject({ status: "report_suggested", suggested_document: { id: lab } });
});

test("held or rejected documents are never suggested, cannot be matched, and an existing match to one is dropped", async () => {
  await add({ type: "test", text: "Ultrasound abdomen", advised_at: "2033-01-01" });
  const held = await newDocument({ modality: "ultrasound", reportedOn: "2033-02-01", identity: "mismatch" });
  const rejected = await newDocument({ modality: "ultrasound", reportedOn: "2033-02-02", identity: "rejected" });
  const item = itemByText(await plan(), "Ultrasound abdomen");
  expect(item.status).toBe("planned");
  expect((await match(item.id, held)).status).toBe(409);
  expect((await match(item.id, rejected)).status).toBe(409);

  const ok = await newDocument({ modality: "ultrasound", reportedOn: "2033-02-03" });
  expect((await match(item.id, ok)).status).toBe(200);
  expect(itemByText(await plan(), "Ultrasound abdomen").status).toBe("report_seen");
  await sql`UPDATE documents SET identity_status = 'mismatch' WHERE id = ${ok}`;
  expect(itemByText(await plan(), "Ultrasound abdomen")).toMatchObject({ status: "planned", matched_document: null });
});

test("match validation: unknown item, malformed id, other patient's document", async () => {
  expect((await match("00000000-0000-0000-0000-000000000000", null)).status).toBe(404);
  const item = itemByText(await plan(), "Biopsy in 2 weeks");
  expect((await setPlanItemMatch(req("http://localhost/m", item.id, { document_id: "nope" }), asAuthedUser(staff))).status).toBe(400);
  const other = await createTestPatient(staff.id);
  const [v] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${other.id}, '2026-01-01') RETURNING id`;
  const [d] = await sql`INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${other.id}, ${v.id}, 'x', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  expect((await match(item.id, d.id)).status).toBe(400);
  await deleteTestPatients(other.id);
});

test("fact-sourced items show only while the source fact is live and signed off; hand-added items stay", async () => {
  const d = await newDocument({ type: "prescription" });
  const reopened = await newFact(d, "tests_advised", "Reopen me in 2 weeks", "2034-01-01");
  const d2 = await newDocument({ type: "prescription" });
  const heldLater = await newFact(d2, "tests_advised", "Held later in 2 weeks", "2034-01-01");
  for (const id of [reopened, heldLater]) expect((await signOff(id)).status).toBe(200);
  await add({ type: "test", text: "Hand added in 2 weeks", advised_at: "2034-01-01" });
  let p = await plan();
  expect(itemByText(p, "Reopen me in 2 weeks")).toBeDefined();
  expect(itemByText(p, "Held later in 2 weeks")).toBeDefined();

  await sql`UPDATE facts SET verification_state = 'unverified' WHERE id = ${reopened}`;
  await sql`UPDATE documents SET identity_status = 'mismatch' WHERE id = ${d2}`;
  p = await plan();
  expect(itemByText(p, "Reopen me in 2 weeks")).toBeUndefined();
  expect(itemByText(p, "Held later in 2 weeks")).toBeUndefined();
  expect(itemByText(p, "Hand added in 2 weeks")).toBeDefined();
});

test("no stated or parseable time is planned, never past_advised; a stated date decides", async () => {
  await add({ type: "test", text: "CBC", advised_at: "2020-01-01" });
  await add({ type: "review", text: "Review on 15/11/2026", advised_at: "2026-01-01" });
  await add({ type: "review", text: "Review on 01/01/2020", advised_at: "2019-01-01" });
  const p = await plan();
  expect(itemByText(p, "CBC")).toMatchObject({ status: "planned", approx_date: null, stated_date: null });
  const stated = itemByText(p, "Review on 15/11/2026");
  expect(stated).toMatchObject({ stated_date: "2026-11-15", approx_date: null });
  // Today is fixed by the system clock; the stated date decides.
  const today = new Date().toISOString().slice(0, 10);
  expect(stated.status).toBe("2026-11-15" < today ? "past_advised" : "planned");
  expect(itemByText(p, "Review on 01/01/2020")).toMatchObject({ status: "past_advised", stated_date: "2020-01-01" });
});

test("suggestions: raw unmapped lab labels are ignored, aliases of canonical markers and tracked names match", async () => {
  await add({ type: "test", text: "Zzq panel", advised_at: "2035-01-01" });
  await add({ type: "test", text: "CA 125 repeat", advised_at: "2035-01-01" });
  const lab = await newDocument({ type: "blood", reportedOn: "2035-01-20" });
  const insert = (label: string) => sql`
    INSERT INTO facts (patient_id, visit_id, document_id, raw_marker_label, field_type, value, as_of_date, coverage_status, verification_state)
    VALUES (${patientId}, ${visitId}, ${lab}, ${label}, 'marker_value', '4.2', '2035-01-20', 'value_found', 'unverified')`;
  await insert("Zzq");
  let p = await plan();
  expect(itemByText(p, "Zzq panel").status).toBe("planned");
  expect(itemByText(p, "CA 125 repeat").status).toBe("planned");
  await insert("CA-125");
  p = await plan();
  expect(itemByText(p, "Zzq panel").status).toBe("planned");
  expect(itemByText(p, "CA 125 repeat")).toMatchObject({ status: "report_suggested", suggested_document: { id: lab } });
});

test("re-sign with changed text clears the confirmed match; unchanged text keeps it", async () => {
  const d = await newDocument({ type: "prescription" });
  const ct = await newDocument({ modality: "ct", reportedOn: "2036-02-01" });
  const f = await newFact(d, "tests_advised", "CT neck in 2 weeks", "2036-01-01");
  expect((await signOff(f)).status).toBe(200);
  const item = itemByText(await plan(), "CT neck in 2 weeks");
  expect((await match(item.id, ct)).status).toBe(200);
  await createPlanItemFromFact(sql, f, oncologist.id);
  expect(itemByText(await plan(), "CT neck in 2 weeks").status).toBe("report_seen");

  await sql`UPDATE facts SET value = 'MRI neck in 2 weeks' WHERE id = ${f}`;
  await createPlanItemFromFact(sql, f, oncologist.id);
  const [row] = await sql`SELECT text, matched_document_id, match_confirmed_by, match_confirmed_at FROM care_plan_items WHERE id = ${item.id}`;
  expect(row).toMatchObject({ text: "MRI neck in 2 weeks", matched_document_id: null, match_confirmed_by: null, match_confirmed_at: null });
});
