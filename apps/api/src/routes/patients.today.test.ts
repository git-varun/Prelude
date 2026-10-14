import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { listPatients } from "./patients";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

// M3-09: the Today list inputs on GET /patients (prep status, sign-off count, change summary, sparkline, plan group).
let staff: TestUser;
let oncologist: TestUser;
let rich: string; // a patient with a prior visit, a current visit, a pin, a conflict, a plan item and a visit elsewhere
let empty: string; // a patient with no visit at all
let soon: string; // a patient with a plan item that is not yet past its date
const NAME = `TodayList-${crypto.randomUUID().slice(0, 8)}`;

async function listAll(): Promise<any[]> {
  const res = await listPatients(new Request(`http://localhost/patients?search=${NAME}`));
  return res.json();
}
const find = (rows: any[], id: string) => rows.find((r) => r.id === id);

beforeAll(async () => {
  staff = await createTestUser("staff", "today-staff");
  oncologist = await createTestUser("oncologist", "today-onc");
  rich = (await createTestPatient(staff.id)).id;
  empty = (await createTestPatient(staff.id)).id;
  soon = (await createTestPatient(staff.id)).id;
  await sql`UPDATE patients SET name = ${`${NAME} rich`}, sex = 'female' WHERE id = ${rich}`;
  await sql`UPDATE patients SET name = ${`${NAME} empty`} WHERE id = ${empty}`;
  await sql`UPDATE patients SET name = ${`${NAME} soon`} WHERE id = ${soon}`;

  const [{ id: oldVisit }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${rich}, '2026-04-01') RETURNING id`;
  const [{ id: curVisit }] = await sql`INSERT INTO visits (patient_id, visit_date, prep_status, prep_set_by, prep_set_at) VALUES (${rich}, '2026-05-01', 'ready', ${staff.id}, now()) RETURNING id`;
  const doc = async (visit: string, type: string, modality: string | null, identity: string | null = null) => (await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, imaging_modality, source_origin, uploaded_by, ocr_status, extraction_status, identity_status)
    VALUES (${rich}, ${visit}, 'local://t/x.pdf', ${type}::document_type, ${modality}, 'own_hospital', ${staff.id}, 'done', 'done', ${identity}::identity_status)
    RETURNING id`)[0].id as string;
  const oldDoc = await doc(oldVisit, "blood", null);
  const blood = await doc(curVisit, "blood", null);
  const ct = await doc(curVisit, "radiology", "ct");
  const held = await doc(curVisit, "radiology", "mri", "mismatch");
  await doc(curVisit, "other", null);

  const marker = async (name: string, pinned: boolean) => (await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by, is_pinned, pinned_by, pinned_at)
    VALUES (${rich}, ${name}, false, ${staff.id}, ${pinned}, ${pinned ? oncologist.id : null}, ${pinned ? sql`now()` : null}) RETURNING id`)[0].id as string;
  const ca = await marker("CA 15-3", true);
  const cea = await marker("CEA", false);
  const fact = async (visit: string, d: string, o: { marker?: string; field?: string; value: string; unit?: string; date?: string | null; check?: string; signed?: boolean }) => (await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, reference_range, as_of_date, coverage_status, verification_state, check_state, signed_off_by, signed_off_at)
    VALUES (${rich}, ${visit}, ${d}, ${o.marker ?? null}, ${o.field ?? "marker_value"}::field_type, ${o.value}, ${o.unit ?? "U/mL"}, '0-30', ${o.date === undefined ? "2026-05-01" : o.date}, 'value_found',
            ${o.signed ? "oncologist_signed_off" : "unverified"}::verification_state, ${o.check ?? "correct"}::check_state, ${o.signed ? oncologist.id : null}, ${o.signed ? sql`now()` : null})
    RETURNING id`)[0].id as string;
  await fact(oldVisit, oldDoc, { marker: ca, value: "188", date: "2026-04-01", signed: true });
  await fact(curVisit, blood, { marker: ca, value: "412" }); // changed, checked, eligible
  const a = await fact(curVisit, blood, { marker: cea, value: "8.4", unit: "ng/mL" });
  const b = await fact(curVisit, ct, { marker: cea, value: "6.1", unit: "ng/mL" });
  await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open')`; // not eligible, sources disagree
  await fact(curVisit, blood, { field: "treatment_regimen", value: "FEC x 6", unit: "", check: "unchecked" }); // not eligible: unchecked
  await fact(curVisit, blood, { field: "radiology_impression", value: "No change", unit: "", date: null }); // not eligible: undated
  await fact(curVisit, blood, { field: "diagnosis", value: "Invasive ductal carcinoma", unit: "" });
  await fact(curVisit, held, { marker: ca, value: "999" }); // held document: never counted

  await sql`INSERT INTO care_plan_items (patient_id, type, text, advised_at, created_by) VALUES (${rich}, 'test', 'Bone scan in 2 weeks', '2026-01-01', ${staff.id})`;
  await sql`INSERT INTO outside_encounters (patient_id, encounter_date, facility, confirmed_by) VALUES (${rich}, '2026-09-22', 'Apollo', ${staff.id})`;

  // soon: advised today, "in 3 days"; no visit.
  const today = new Date().toISOString().slice(0, 10);
  await sql`INSERT INTO care_plan_items (patient_id, type, text, advised_at, created_by) VALUES (${soon}, 'test', 'CT chest in 3 days', ${today}, ${staff.id})`;
});

afterAll(async () => {
  await sql`DELETE FROM care_plan_items WHERE patient_id IN (${rich}, ${soon})`;
  await deleteTestPatients(rich, empty, soon);
  await deleteTestUsers(staff.id, oncologist.id);
});

test("prep status, document count, sign-off count and the group inputs", async () => {
  const r = find(await listAll(), rich);
  expect(r.prep_status).toBe("ready");
  expect(r.current_visit_document_count).toBe(2); // the blood and CT reports: held and 'other' documents are not counted
  expect(r.changed_since_ready).toBe(true); // marked ready, but unchecked facts and a held report remain
  expect(r.sign_off_count).toBe(1); // only CA 15-3 412: CEA is in a conflict, the regimen is unchecked, the impression is undated
  expect(r.sex).toBe("female");
  expect(r.diagnosis_text).toBe("Invasive ductal carcinoma");
  expect(r.regimen_text).toBe("FEC x 6");
  expect(r.has_plan_items_expected).toBe(true);
});

test("change summary items come from the data only", async () => {
  const r = find(await listAll(), rich);
  expect(r.change_summary_items).toEqual([
    { kind: "marker_changed", name: "CA 15-3", from: "188", to: "412" },
    { kind: "new_report", type: "blood", modality: null },
    { kind: "new_report", type: "radiology", modality: "ct" },
    { kind: "sources_disagree", name: "CEA" },
    { kind: "plan_past", count: 1 },
    { kind: "elsewhere", facility: "Apollo", date: "2026-09-22" },
  ]);
});

test("the sparkline is the first pinned marker's live dated values, never a held document's", async () => {
  const r = find(await listAll(), rich);
  expect(r.first_pinned_sparkline.marker_name).toBe("CA 15-3");
  expect(r.first_pinned_sparkline.reference_range).toBe("0-30");
  expect(r.first_pinned_sparkline.points.map((p: any) => [p.as_of_date, p.value, p.verification_state])).toEqual([
    ["2026-04-01", "188", "oncologist_signed_off"],
    ["2026-05-01", "412", "unverified"],
  ]);
});

test("a patient with no visit has no prep status, nothing to sign off and no items; a not-yet-past plan item is still expected", async () => {
  const rows = await listAll();
  expect(find(rows, empty)).toMatchObject({
    prep_status: null, changed_since_ready: false, current_visit_document_count: 0, sign_off_count: 0, change_summary_items: [],
    first_pinned_sparkline: null, has_plan_items_expected: false, diagnosis_text: null, regimen_text: null,
  });
  expect(find(rows, soon)).toMatchObject({ has_plan_items_expected: true, change_summary_items: [] });
});

test("a signed-off or reopened winner changes the sign-off count; a plan item with a confirmed report is neither past nor expected", async () => {
  const [fact] = await sql`SELECT f.id FROM facts f WHERE f.patient_id = ${rich} AND f.value = '412'`;
  await sql`UPDATE facts SET verification_state = 'oncologist_signed_off', signed_off_by = ${oncologist.id}, signed_off_at = now() WHERE id = ${fact.id}`;
  expect(find(await listAll(), rich).sign_off_count).toBe(0);

  const [ctDoc] = await sql`SELECT id FROM documents WHERE patient_id = ${rich} AND imaging_modality = 'ct'`;
  await sql`UPDATE care_plan_items SET matched_document_id = ${ctDoc.id}, match_confirmed_at = now() WHERE patient_id = ${rich}`;
  const r = find(await listAll(), rich);
  expect(r.has_plan_items_expected).toBe(false);
  expect(r.change_summary_items.some((i: any) => i.kind === "plan_past")).toBe(false);
});

test("a ready visit whose checks all pass is not changed since ready", async () => {
  const calm = (await createTestPatient(staff.id)).id;
  try {
    await sql`UPDATE patients SET name = ${`${NAME} calm`} WHERE id = ${calm}`;
    const [{ id: v }] = await sql`INSERT INTO visits (patient_id, visit_date, prep_status, prep_set_by, prep_set_at) VALUES (${calm}, '2026-05-01', 'ready', ${staff.id}, now()) RETURNING id`;
    await sql`INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, extraction_status)
              VALUES (${calm}, ${v}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done', 'done')`;
    expect(find(await listAll(), calm)).toMatchObject({ prep_status: "ready", changed_since_ready: false });
    await sql`UPDATE documents SET extraction_status = 'pending' WHERE patient_id = ${calm}`;
    expect(find(await listAll(), calm).changed_since_ready).toBe(true);
  } finally {
    await deleteTestPatients(calm);
  }
});
