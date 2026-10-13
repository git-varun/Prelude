import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientSnapshot, getMarkerTrend, getPatientTimeline, listPatients } from "../routes/patients";
import { listVisits } from "../routes/visits";
import { getDocumentFacts, signOffFact } from "../routes/facts";
import { getConflict } from "../routes/conflicts";
import { detectConflicts } from "./rules";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitId: string;
let markerId: string;
let docId: string;
let a: string;
let b: string;
let conflictId: string;
const created: string[] = [];

function withId<T extends Record<string, string>>(path: string, params: T): Request & { params: T } {
  const r = new Request(`http://localhost${path}`, { method: path.includes("sign-off") ? "POST" : "GET" }) as Request & { params: T };
  r.params = params;
  return r;
}

async function fact(value: string, o: { verification?: string; documentId?: string } = {}): Promise<string> {
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, as_of_date,
      coverage_status, verification_state, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${o.documentId ?? docId}, ${markerId}, 'marker_value', ${value}, '2026-02-01',
      'value_found', ${o.verification ?? "unverified"}, ${o.verification === "oncologist_signed_off" ? oncologist.id : null})
    RETURNING id`;
  return row.id;
}

async function exclude(id: string) {
  await sql`UPDATE facts SET check_state = 'incorrect', error_type = 'not_in_document', excluded_at = now() WHERE id = ${id}`;
}

beforeEach(async () => {
  staff ??= await createTestUser("staff", "excluded-staff");
  oncologist ??= await createTestUser("oncologist", "excluded-onc");
  patientId = (await createTestPatient(staff.id)).id;
  created.push(patientId);
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  [{ id: markerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  [{ id: docId }] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  a = await fact("4");
  b = await fact("9");
  [{ id: conflictId }] = await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open') RETURNING id`;
  await sql`UPDATE facts SET coverage_status = 'conflicting_sources' WHERE id IN (${a}, ${b})`;
});

afterEach(async () => {
  await deleteTestPatients(patientId);
});

afterAll(async () => {
  await deleteTestUsers(staff.id, oncologist.id);
});

test("snapshot omits the excluded fact and shows no conflict on the other", async () => {
  await exclude(b);
  const body = (await (await getPatientSnapshot(withId(`/patients/${patientId}/snapshot`, { id: patientId }))).json()) as any;
  const cea = body.tumor_markers.find((m: any) => m.fact_id === a || m.field?.fact_id === a);
  expect(JSON.stringify(body)).not.toContain(b);
  expect(JSON.stringify(body)).not.toContain('"9"');
  expect(cea).toBeDefined();
  expect(JSON.stringify(cea.conflicts ?? [])).toBe("[]");
});

test("timeline and trend omit the excluded fact", async () => {
  await sql`UPDATE facts SET verification_state = 'oncologist_signed_off', signed_off_by = ${oncologist.id}, signed_off_at = now() WHERE id IN (${a}, ${b})`;
  await exclude(b);
  const trend = (await (await getMarkerTrend(withId(`/p/${patientId}/markers/${markerId}/trend`, { id: patientId, trackedMarkerId: markerId }))).json()) as any;
  expect(trend.points.map((p: any) => p.fact_id)).toEqual([a]);
  const timeline = JSON.stringify(await (await getPatientTimeline(withId(`/patients/${patientId}/timeline`, { id: patientId }))).json());
  expect(timeline).toContain(a);
  expect(timeline).not.toContain(b);
});

test("listVisits fact_count counts only the live fact", async () => {
  await exclude(b);
  const visits = (await (await listVisits(withId(`/patients/${patientId}/visits`, { id: patientId }))).json()) as any[];
  expect(visits[0].fact_count).toBe(1);
});

test("needs_attention_count ignores the excluded fact and does not count the other as conflicted", async () => {
  await sql`UPDATE facts SET verification_state = 'staff_corrected' WHERE id = ${a}`; // reviewed, so only a conflict could flag it
  await exclude(b);
  const res = await listPatients(new Request(`http://localhost/patients?search=${encodeURIComponent((await sql`SELECT name FROM patients WHERE id = ${patientId}`)[0].name)}`));
  const row = ((await res.json()) as any[]).find((p) => p.id === patientId);
  expect(row.needs_attention_count).toBe(0);
});

test("document facts: the other side no longer reports a blocking conflict", async () => {
  await exclude(b);
  const rows = ((await (await getDocumentFacts(withId(`/documents/${docId}/facts`, { id: docId }))).json()) as any).facts as any[];
  const ra = rows.find((r) => r.id === a);
  expect(ra.has_blocking_conflict).toBe(false);
  expect(ra.blocking_conflict_id).toBeNull();
});

test("sign-off of the other side is no longer blocked by the conflict", async () => {
  await exclude(b);
  const res = await signOffFact(withId(`/facts/${a}/sign-off`, { id: a }), asAuthedUser(oncologist));
  expect(res.status).toBe(200);
});

test("GET /conflicts/:id still works and marks the excluded side", async () => {
  await exclude(b);
  const res = await getConflict(withId(`/conflicts/${conflictId}`, { id: conflictId }), asAuthedUser(oncologist));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.fact_a.excluded).toBe(false);
  expect(body.fact_b.excluded).toBe(true);
});

test("detectConflicts opens a conflict against the live fact only, never the excluded one", async () => {
  await exclude(b);
  const c = await fact("12");
  const [row] = await sql`SELECT * FROM facts WHERE id = ${c}`;
  const pairs = await detectConflicts(sql, row as any);
  expect(pairs.map((p) => p.factIdB)).toEqual([a]);
});

test("an excluded fact never opens conflicts itself (e.g. on identity confirm re-detection)", async () => {
  const c = await fact("12");
  await exclude(c);
  const [row] = await sql`SELECT * FROM facts WHERE id = ${c}`;
  expect(await detectConflicts(sql, row as any)).toEqual([]);
});
