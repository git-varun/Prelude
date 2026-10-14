import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getVisitPrep, setVisitPrep } from "./prep";
import { uploadDocument } from "./documents";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

// Keep tests hermetic: no real OCR or extraction vendor.
delete process.env.OCR_PROVIDER;
delete process.env.EXTRACTION_PROVIDER;

// M3-09: the prep checklist and "Mark ready".
let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitId: string;

const withId = (url: string, id: string, body?: unknown) =>
  Object.assign(new Request(url, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }), { params: { id } });
const get = async (): Promise<any> => (await getVisitPrep(withId("http://localhost/prep", visitId))).json();
const setReady = (ready: unknown, user = staff) => setVisitPrep(withId("http://localhost/prep", visitId, { ready }), asAuthedUser(user));
const item = (state: any, key: string) => state.items.find((i: any) => i.key === key);

async function newDoc(o: { type?: string; identity?: string | null } = {}) {
  const [d] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', ${o.type ?? "blood"}::document_type, 'own_hospital', ${staff.id}, 'done', ${o.identity ?? null}::identity_status)
    RETURNING id`;
  return d.id as string;
}
async function newFact(doc: string, o: { check?: string; manualDate?: boolean } = {}) {
  const [f] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, needs_manual_date, coverage_status, verification_state, check_state)
    VALUES (${patientId}, ${visitId}, ${doc}, 'diagnosis', 'Invasive ductal carcinoma', ${o.manualDate ? null : "2026-03-01"}, ${!!o.manualDate}, 'value_found', 'unverified', ${o.check ?? "correct"}::check_state)
    RETURNING id`;
  return f.id as string;
}
async function reset() {
  await sql`DELETE FROM conflicts WHERE fact_id_a IN (SELECT id FROM facts WHERE patient_id = ${patientId})`;
  await sql`DELETE FROM facts WHERE patient_id = ${patientId}`;
  await sql`DELETE FROM documents WHERE patient_id = ${patientId}`;
  await sql`UPDATE visits SET prep_status = 'preparing', prep_set_by = NULL, prep_set_at = NULL WHERE id = ${visitId}`;
  await sql`DELETE FROM audit_log WHERE entity_type = 'visit' AND entity_id = ${visitId}`;
}

beforeAll(async () => {
  staff = await createTestUser("staff", "prep-staff");
  oncologist = await createTestUser("oncologist", "prep-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-03-01') RETURNING id`;
});

afterAll(async () => {
  await reset();
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

test("a new visit is preparing and its checklist starts with nothing uploaded", async () => {
  await reset();
  const s = await get();
  expect(s.prep_status).toBe("preparing");
  expect(s.prep_set_by).toBeNull();
  expect(item(s, "uploaded").ok).toBe(false);
  expect(s.can_mark_ready).toBe(false);
  expect((await setVisitPrep(withId("http://localhost/prep", "not-a-uuid", { ready: true }), asAuthedUser(staff))).status).toBe(404);
  expect((await setReady("yes")).status).toBe(400);
});

test("each checklist item blocks on its own, with the failing reasons in the 409", async () => {
  await reset();
  // Only an 'other' document: still nothing uploaded.
  await newDoc({ type: "other" });
  expect(item(await get(), "uploaded").ok).toBe(false);

  const doc = await newDoc();
  expect(item(await get(), "uploaded").ok).toBe(true);

  const unchecked = await newFact(doc, { check: "unchecked" });
  let s = await get();
  expect(item(s, "facts_checked")).toMatchObject({ ok: false, count: 1 });
  let res = await setReady(true);
  expect(res.status).toBe(409);
  let body: any = await res.json();
  expect(body.failing.map((f: any) => f.key)).toEqual(["facts_checked"]);
  expect(body.message).toContain("1 fact is not checked yet");
  await sql`UPDATE facts SET check_state = 'correct' WHERE id = ${unchecked}`;

  await newFact(doc, { manualDate: true });
  s = await get();
  expect(item(s, "dates_entered")).toMatchObject({ ok: false, count: 1 });
  expect((await setReady(true)).status).toBe(409);
  await sql`UPDATE facts SET needs_manual_date = false, as_of_date = '2026-03-01' WHERE patient_id = ${patientId} AND needs_manual_date`;

  const held = await newDoc({ identity: "awaiting_oncologist" });
  s = await get();
  expect(item(s, "held_reviewed")).toMatchObject({ ok: false, count: 1 });
  body = await (await setReady(true)).json();
  expect(body.failing.map((f: any) => f.key)).toEqual(["held_reviewed"]);
  await sql`UPDATE documents SET identity_status = 'confirmed' WHERE id = ${held}`;

  s = await get();
  expect(s.items.every((i: any) => i.ok)).toBe(true);
  expect(s.prep_status).toBe("preparing");
});

test("an open conflict does not block ready", async () => {
  await reset();
  const doc = await newDoc();
  const a = await newFact(doc);
  const b = await newFact(doc);
  await sql`INSERT INTO conflicts (fact_id_a, fact_id_b, status) VALUES (${a}, ${b}, 'open')`;
  expect((await get()).can_mark_ready).toBe(true);
  expect((await setReady(true)).status).toBe(200);
});

test("ready and back to preparing: who and when are kept, each change has an audit row, repeating one writes none", async () => {
  await reset();
  await newFact(await newDoc());
  const res = await setReady(true, staff);
  expect(res.status).toBe(200);
  const s: any = await res.json();
  expect(s).toMatchObject({ prep_status: "ready", prep_set_by: staff.id, can_mark_ready: true, changed_since_ready: [] });
  expect(s.prep_set_at).toBeTruthy();
  expect((await setReady(true, staff)).status).toBe(200);

  const back: any = await (await setReady(false, oncologist)).json();
  expect(back).toMatchObject({ prep_status: "preparing", prep_set_by: oncologist.id });

  const rows = await sql`SELECT actor_id, action, before_value, after_value FROM audit_log WHERE entity_type = 'visit' AND entity_id = ${visitId} ORDER BY created_at`;
  expect(rows.map((r: any) => [r.actor_id, JSON.parse(r.before_value).prep_status, JSON.parse(r.after_value).prep_status])).toEqual([
    [staff.id, "preparing", "ready"],
    [oncologist.id, "ready", "preparing"],
  ]);
  expect(rows.every((r: any) => r.action === "set_prep_status")).toBe(true);
});

test("changing facts afterwards does not flip ready, but the checklist shows what changed", async () => {
  await reset();
  const doc = await newDoc();
  await newFact(doc);
  expect((await setReady(true)).status).toBe(200);
  await newFact(doc, { check: "unchecked" });
  const s = await get();
  expect(s.prep_status).toBe("ready");
  expect(s.can_mark_ready).toBe(false);
  expect(s.changed_since_ready).toEqual(["facts_checked"]);
  // Going back to preparing is always allowed.
  expect((await setReady(false)).status).toBe(200);
  expect((await setReady(true)).status).toBe(409);
});

test("a new report on a ready visit returns it to preparing, said so in the audit; an 'other' document does not", async () => {
  await reset();
  await newFact(await newDoc());
  expect((await setReady(true)).status).toBe(200);
  const upload = async (type: string) => {
    const form = new FormData();
    form.set("visit_id", visitId);
    form.set("document_type", type);
    form.set("source_origin", "own_hospital");
    form.set("file", new File(["data"], "a.pdf", { type: "application/pdf" }));
    const req = Object.assign(new Request(`http://localhost/patients/${patientId}/documents`, { method: "POST", body: form }), { params: { id: patientId } });
    return uploadDocument(req, asAuthedUser(staff));
  };
  expect((await upload("other")).status).toBe(201);
  expect((await get()).prep_status).toBe("ready");

  expect((await upload("blood")).status).toBe(201);
  const s = await get();
  expect(s.prep_status).toBe("preparing");
  expect(s.prep_set_by).toBe(staff.id);
  const rows = await sql`SELECT after_value FROM audit_log WHERE entity_type = 'visit' AND entity_id = ${visitId} ORDER BY created_at DESC LIMIT 1`;
  expect(JSON.parse(rows[0].after_value)).toMatchObject({ prep_status: "preparing", reason: "document_uploaded" });
});
