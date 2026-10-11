import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientSnapshot, getMarkerTrend, getPatientTimeline, listPatients } from "./patients";
import { listVisits } from "./visits";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

// Every reader that shows a patient's facts must exclude a document held for an identity mismatch (or rejected),
// and must keep showing a confirmed one. One live, one mismatch, one rejected and one confirmed document each carry
// one fact of every kind the readers select.
let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let markerId: string;

const VALUES = { live: "LIVE", mismatch: "HELD-MISMATCH", rejected: "HELD-REJECTED", confirmed: "CONFIRMED" } as const;

beforeAll(async () => {
  staff = await createTestUser("staff", "held-docs-staff");
  oncologist = await createTestUser("oncologist", "held-docs-onc");
  patientId = (await createTestPatient(staff.id)).id;
  const [visit] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-03-01') RETURNING id`;
  [{ id: markerId }] = await sql`INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  const statuses: [keyof typeof VALUES, string | null][] = [["live", null], ["mismatch", "mismatch"], ["rejected", "rejected"], ["confirmed", "confirmed"]];
  for (const [key, identity] of statuses) {
    const [doc] = await sql`
      INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status)
      VALUES (${patientId}, ${visit.id}, ${`local://t/${key}.pdf`}, 'blood', 'own_hospital', ${staff.id}, 'done', ${identity}::identity_status) RETURNING id`;
    const v = VALUES[key];
    // unverified facts (snapshot, visit counts, needs-attention)
    await sql`
      INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state)
      VALUES (${patientId}, ${visit.id}, ${doc.id}, 'treatment_regimen', ${"TX-" + v}, '2026-03-01', 'value_found', 'unverified'),
             (${patientId}, ${visit.id}, ${doc.id}, 'radiology_impression', ${"RAD-" + v}, '2026-03-01', 'value_found', 'unverified')`;
    // signed-off facts (timeline and trend only read signed-off facts)
    await sql`
      INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, as_of_date, coverage_status, verification_state, signed_off_by, signed_off_at)
      VALUES (${patientId}, ${visit.id}, ${doc.id}, ${markerId}, 'marker_value', ${"1" + String(Object.keys(VALUES).indexOf(key))}, 'ng/mL', ${"2026-03-0" + (2 + Object.keys(VALUES).indexOf(key))}, 'value_found', 'oncologist_signed_off', ${oncologist.id}, now()),
             (${patientId}, ${visit.id}, ${doc.id}, NULL, 'treatment_regimen', ${"SO-TX-" + v}, NULL, '2026-03-01', 'value_found', 'oncologist_signed_off', ${oncologist.id}, now())`;
  }
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

function withId<T extends Record<string, string>>(path: string, params: T): Request & { params: T } {
  const r = new Request(`http://localhost${path}`) as Request & { params: T };
  r.params = params;
  return r;
}

const text = async (res: Response) => JSON.stringify(await res.json());

test("snapshot shows neither held nor rejected facts", async () => {
  const body = await text(await getPatientSnapshot(withId(`/patients/${patientId}/snapshot`, { id: patientId })));
  expect(body).not.toContain("HELD-MISMATCH");
  expect(body).not.toContain("HELD-REJECTED");
  expect(body).toMatch(/TX-(LIVE|CONFIRMED)|RAD-(LIVE|CONFIRMED)/);
});

test("visit fact_count and signed_off_count count only live (live + confirmed) facts", async () => {
  const visits = (await (await listVisits(withId(`/patients/${patientId}/visits`, { id: patientId }))).json()) as any[];
  // per document: 2 unverified + 2 signed-off = 4 facts; only the live and confirmed documents count -> 8 facts, 4 signed off
  expect(visits[0].fact_count).toBe(8);
  expect(visits[0].signed_off_count).toBe(4);
});

test("timeline excludes held and rejected signed-off facts", async () => {
  const body = await text(await getPatientTimeline(withId(`/patients/${patientId}/timeline`, { id: patientId })));
  expect(body).not.toContain("SO-TX-HELD-MISMATCH");
  expect(body).not.toContain("SO-TX-HELD-REJECTED");
  expect(body).toContain("SO-TX-LIVE");
  expect(body).toContain("SO-TX-CONFIRMED");
});

test("marker trend has one point per live or confirmed document only", async () => {
  const res = await getMarkerTrend(withId(`/patients/${patientId}/markers/${markerId}/trend`, { id: patientId, trackedMarkerId: markerId }));
  const body = (await res.json()) as any;
  expect(body.points).toHaveLength(2);
  expect(body.points.map((p: any) => p.value).sort()).toEqual(["10", "13"]);
});

test("needs-attention counts only live facts: the held documents' unverified facts do not inflate it", async () => {
  const res = await listPatients(new Request(`http://localhost/patients?search=${encodeURIComponent("")}&limit=200`));
  const rows = (await res.json()) as any;
  const list = Array.isArray(rows) ? rows : rows.patients ?? rows.items ?? [];
  const mine = list.find((p: any) => p.id === patientId);
  // 4 unverified facts on the live + confirmed documents (2 each); the held ones add nothing
  expect(mine).toBeTruthy();
  expect(mine.needs_attention_count).toBe(4);
});
