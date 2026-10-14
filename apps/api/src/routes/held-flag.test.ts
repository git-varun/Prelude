import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientSnapshot, getMarkerTrend, getPatientTimeline, getPatientSummary, getPatientDocumentIdentity, listPatients } from "./patients";
import { getPatientPlan } from "./plan";
import { flagDocumentIdentity, getIdentityPreview, setDocumentIdentityStatus } from "./documents";
import { signOffFact, checkFactRoute } from "./facts";
import { detectConflicts } from "../services/rules";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

// M3-08: staff flag a held document ('awaiting_oncologist'); it stays held everywhere until the oncologist decides.
let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitId: string;
let markerId: string;
let liveDoc: string;
let heldDoc: string;
let liveFactId: string;
let heldFactId: string;
let heldTxFactId: string;

const p = (path: string, id: string, init?: RequestInit) => Object.assign(new Request(`http://localhost${path}`, init), { params: { id } });
const post = (path: string, id: string, body: unknown) => p(path, id, { method: "POST", body: JSON.stringify(body) });
const flag = (id: string, body: unknown, user = staff) => flagDocumentIdentity(post(`/documents/${id}/identity-flag`, id, body), asAuthedUser(user));
const decide = (id: string, action: string) => setDocumentIdentityStatus(post(`/documents/${id}/identity`, id, { action }), asAuthedUser(oncologist));
const preview = (id: string) => getIdentityPreview(p(`/documents/${id}/identity-preview`, id));
const text = async (res: Response) => JSON.stringify(await res.json());

async function newDoc(identity: string | null, key: string) {
  const [d] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status, lab_name, patient_name_on_report)
    VALUES (${patientId}, ${visitId}, ${`local://t/${key}.pdf`}, 'blood', 'own_hospital', ${staff.id}, 'done', ${identity}::identity_status, 'Lab X', 'Someone Else')
    RETURNING id`;
  return d.id as string;
}

beforeAll(async () => {
  staff = await createTestUser("staff", "held-flag-staff");
  oncologist = await createTestUser("oncologist", "held-flag-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-03-01') RETURNING id`;
  [{ id: markerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by, is_pinned, pinned_by, pinned_at)
    VALUES (${patientId}, 'CEA', false, ${staff.id}, true, ${oncologist.id}, now()) RETURNING id`;
  liveDoc = await newDoc(null, "live");
  heldDoc = await newDoc("mismatch", "held");
  const fact = (doc: string, value: string, signed: boolean) => sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, as_of_date, coverage_status, verification_state, signed_off_by, signed_off_at)
    VALUES (${patientId}, ${visitId}, ${doc}, ${markerId}, 'marker_value', ${value}, 'ng/mL', '2026-03-01', 'value_found',
            ${signed ? "oncologist_signed_off" : "unverified"}, ${signed ? oncologist.id : null}, ${signed ? sql`now()` : null})
    RETURNING id`;
  [{ id: liveFactId }] = await fact(liveDoc, "4.2", true);
  [{ id: heldFactId }] = await fact(heldDoc, "9.9", true);
  [{ id: heldTxFactId }] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, signed_off_by, signed_off_at)
    VALUES (${patientId}, ${visitId}, ${heldDoc}, 'tests_advised', 'HELD-PLAN-TEST', '2026-03-01', 'value_found', 'oncologist_signed_off', ${oncologist.id}, now())
    RETURNING id`;
  await sql`INSERT INTO care_plan_items (patient_id, type, text, advised_at, source_fact_id, created_by) VALUES (${patientId}, 'test', 'HELD-PLAN-TEST', '2026-03-01', ${heldTxFactId}, ${staff.id})`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

test("flag validates the assessment, 404s an unknown document and 409s a document that is not held", async () => {
  expect((await flag(heldDoc, { assessment: "maybe" })).status).toBe(400);
  expect((await flag(heldDoc, {})).status).toBe(400);
  expect((await flag(heldDoc, { assessment: "likely_same", note: 5 })).status).toBe(400);
  expect((await flag(crypto.randomUUID(), { assessment: "likely_same" })).status).toBe(404);
  expect((await flag("not-a-uuid", { assessment: "likely_same" })).status).toBe(404);
  expect((await flag(liveDoc, { assessment: "likely_same" })).status).toBe(409);
  const [row] = await sql`SELECT identity_status FROM documents WHERE id = ${heldDoc}`;
  expect(row.identity_status).toBe("mismatch");
});

test("flag records status, assessment, note, who and when, with an audit row", async () => {
  const res = await flag(heldDoc, { assessment: "likely_same", note: "  Spelt differently on the lab system  " });
  expect(res.status).toBe(200);
  const [row] = await sql`SELECT * FROM documents WHERE id = ${heldDoc}`;
  expect(row.identity_status).toBe("awaiting_oncologist");
  expect(row.staff_identity_assessment).toBe("likely_same");
  expect(row.staff_identity_note).toBe("Spelt differently on the lab system");
  expect(row.staff_identity_by).toBe(staff.id);
  expect(row.staff_identity_at).toBeTruthy();
  const audit = await sql`SELECT before_value, after_value FROM audit_log WHERE entity_type = 'document' AND entity_id = ${heldDoc} AND action = 'flag_identity'`;
  expect(audit).toHaveLength(1);
  const asObj = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v) as any;
  expect(asObj(audit[0].before_value).identity_status).toBe("mismatch");
  expect(asObj(audit[0].after_value).identity_status).toBe("awaiting_oncologist");
});

test("a flagged document stays excluded from the snapshot, watchlist, summary, timeline, trend and plan", async () => {
  const snapshot = await text(await getPatientSnapshot(p(`/patients/${patientId}/snapshot`, patientId)));
  expect(snapshot).toContain("4.2");
  expect(snapshot).not.toContain("9.9");
  expect(JSON.parse(snapshot).watchlist).toBeTruthy();
  expect(await text(await getPatientSummary(p(`/patients/${patientId}/summary`, patientId)))).not.toContain("HELD-PLAN-TEST");
  const timeline = await text(await getPatientTimeline(p(`/patients/${patientId}/timeline`, patientId)));
  expect(timeline).not.toContain("9.9");
  expect(timeline).not.toContain("HELD-PLAN-TEST");
  const trend = (await (await getMarkerTrend(Object.assign(p(`/patients/${patientId}/markers/${markerId}/trend`, patientId), { params: { id: patientId, trackedMarkerId: markerId } }))).json()) as any;
  expect(trend.points.map((pt: any) => pt.value)).toEqual(["4.2"]);
  expect(await text(await getPatientPlan(p(`/patients/${patientId}/plan`, patientId)))).not.toContain("HELD-PLAN-TEST");
});

test("a flagged document opens no conflicts, cannot be checked or signed off, and still counts as held", async () => {
  expect(await detectConflicts(sql, { id: heldFactId, patient_id: patientId, field_type: "marker_value", tracked_marker_id: markerId, as_of_date: "2026-03-01", value: "9.9", needs_manual_date: false } as any)).toEqual([]);
  expect(await sql`SELECT id FROM conflicts WHERE fact_id_a = ${heldFactId} OR fact_id_b = ${heldFactId}`).toHaveLength(0);
  expect((await checkFactRoute(post(`/facts/${heldFactId}/check`, heldFactId, { result: "correct" }), asAuthedUser(staff))).status).toBe(409);
  expect((await signOffFact(post(`/facts/${heldFactId}/sign-off`, heldFactId, {}), asAuthedUser(oncologist))).status).toBe(409);

  const list = (await (await listPatients(new Request("http://localhost/patients?limit=500"))).json()) as any[];
  expect(list.find((x) => x.id === patientId).held_document_count).toBe(1);
  const listed = (await (await getPatientDocumentIdentity(p(`/patients/${patientId}/documents/identity`, patientId))).json()) as any;
  const row = listed.documents.find((d: any) => d.id === heldDoc);
  expect(row.identity_status).toBe("awaiting_oncologist");
  expect(row.staff_identity_assessment).toBe("likely_same");
  expect(row.staff_identity_by_name).toBe("held-flag-staff");
});

test("preview lists what confirming adds and the conflicts it would open, and writes nothing", async () => {
  const before = {
    doc: (await sql`SELECT * FROM documents WHERE id = ${heldDoc}`)[0],
    facts: await sql`SELECT id, coverage_status FROM facts WHERE patient_id = ${patientId} ORDER BY id`,
    conflicts: (await sql`SELECT count(*)::int AS n FROM conflicts WHERE fact_id_a IN (${liveFactId}, ${heldFactId}) OR fact_id_b IN (${liveFactId}, ${heldFactId})`)[0].n,
    audit: (await sql`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = ${heldDoc}`)[0].n,
  };
  const res = await preview(heldDoc);
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.fact_counts).toEqual({ marker_value: 1, tests_advised: 1 });
  expect(body.fact_total).toBe(2);
  expect(body.markers).toEqual([{ marker_name: "CEA", as_of_date: "2026-03-01" }]);
  expect(body.new_conflicts).toHaveLength(1);
  expect(body.new_conflicts[0]).toMatchObject({ marker_name: "CEA", this_value: "9.9", other_value: "4.2", as_of_date: "2026-03-01" });
  expect(body.staff_assessment).toMatchObject({ assessment: "likely_same", note: "Spelt differently on the lab system" });

  const doc = (await sql`SELECT * FROM documents WHERE id = ${heldDoc}`)[0];
  expect(doc).toEqual(before.doc);
  expect(await sql`SELECT id, coverage_status FROM facts WHERE patient_id = ${patientId} ORDER BY id`).toEqual(before.facts);
  expect((await sql`SELECT count(*)::int AS n FROM conflicts WHERE fact_id_a IN (${liveFactId}, ${heldFactId}) OR fact_id_b IN (${liveFactId}, ${heldFactId})`)[0].n).toBe(before.conflicts);
  expect((await sql`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = ${heldDoc}`)[0].n).toBe(before.audit);
});

test("preview 404s an unknown document and 409s one that is not held", async () => {
  expect((await preview(crypto.randomUUID())).status).toBe(404);
  expect((await preview(liveDoc)).status).toBe(409);
});

test("the oncologist confirms a flagged document: facts go live and conflicts open; audit row written", async () => {
  expect((await decide(heldDoc, "confirm")).status).toBe(200);
  const [row] = await sql`SELECT identity_status, staff_identity_assessment FROM documents WHERE id = ${heldDoc}`;
  expect(row.identity_status).toBe("confirmed");
  expect(row.staff_identity_assessment).toBe("likely_same");
  expect(await sql`SELECT id FROM conflicts WHERE fact_id_a = ${heldFactId} OR fact_id_b = ${heldFactId}`).not.toHaveLength(0);
  expect(await sql`SELECT 1 FROM audit_log WHERE entity_id = ${heldDoc} AND action = 'confirm_identity' AND actor_id = ${oncologist.id}`).toHaveLength(1);
  const listed = (await (await getPatientDocumentIdentity(p(`/patients/${patientId}/documents/identity`, patientId))).json()) as any;
  expect(listed.documents.find((d: any) => d.id === heldDoc).confirmed_by_name).toBe("held-flag-onc");
  expect((await flag(heldDoc, { assessment: "cannot_tell" })).status).toBe(409);
});

test("the oncologist rejects a flagged document; it stays excluded", async () => {
  const doc = await newDoc("mismatch", "to-reject");
  expect((await flag(doc, { assessment: "likely_different" })).status).toBe(200);
  expect((await decide(doc, "reject")).status).toBe(200);
  const [row] = await sql`SELECT identity_status FROM documents WHERE id = ${doc}`;
  expect(row.identity_status).toBe("rejected");
  expect(await sql`SELECT 1 FROM audit_log WHERE entity_id = ${doc} AND action = 'reject_identity'`).toHaveLength(1);
  expect((await flag(doc, { assessment: "likely_same" })).status).toBe(409);
});
