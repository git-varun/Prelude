import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { pinMarker, suggestPin, dismissPinSuggestion } from "./pins";
import { getPatientSnapshot } from "./patients";
import { requireRole } from "../middleware/roles";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, requestWithCookie, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let otherPatientId: string;
let visit1: string;
let visit2: string;
let doc1: string;
let doc2: string;
const markers: Record<string, string> = {};

beforeAll(async () => {
  staff = await createTestUser("staff", "pins-staff");
  oncologist = await createTestUser("oncologist", "pins-onc");
  patientId = (await createTestPatient(staff.id)).id;
  otherPatientId = (await createTestPatient(staff.id)).id;
  [{ id: visit1 }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: visit2 }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  for (const name of ["CEA", "CA 19-9", "AFP", "Hb"]) {
    const [m] = await sql`INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, ${name}, false, ${staff.id}) RETURNING id`;
    markers[name] = m.id;
  }
  [{ id: markers.other }] = await sql`INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${otherPatientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  doc1 = await newDocument(visit1);
  doc2 = await newDocument(visit2);
});

afterAll(async () => {
  await sql`DELETE FROM audit_log WHERE entity_type = 'tracked_marker' AND entity_id IN (SELECT id FROM tracked_markers WHERE patient_id IN (${patientId}, ${otherPatientId}))`;
  await deleteTestPatients(patientId, otherPatientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newDocument(visitId: string, identity: string | null = null): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status, identity_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done', ${identity}::identity_status) RETURNING id`;
  return doc.id;
}

async function newFact(documentId: string, visitId: string, markerId: string, value: string, asOf: string) {
  await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, unit, reference_range, as_of_date, coverage_status, verification_state)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${markerId}, 'marker_value', ${value}, 'ng/mL', '0-5', ${asOf}, 'value_found', 'unverified')`;
}

type R = Request & { params: { id: string } };
function call(handler: (r: R, u: any) => Promise<Response>, roles: ("staff" | "oncologist")[], id: string, user: TestUser, body: unknown = {}) {
  const req = requestWithCookie("http://localhost/x", user.cookie, { method: "POST", body: JSON.stringify(body) }) as R;
  req.params = { id };
  return requireRole(roles, handler as any)(req);
}
const pin = (id: string, pinned: boolean, user = oncologist) => call(pinMarker, ["oncologist"], id, user, { pinned });
const suggest = (id: string, note?: string, user = staff) => call(suggestPin, ["staff", "oncologist"], id, user, note === undefined ? {} : { note });
const dismiss = (id: string, user = oncologist) => call(dismissPinSuggestion, ["oncologist"], id, user);
const row = async (id: string): Promise<any> => (await sql`SELECT * FROM tracked_markers WHERE id = ${id}`)[0];
const snapshot = async (): Promise<any> => {
  const req = new Request("http://localhost/s") as R;
  req.params = { id: patientId };
  return (await getPatientSnapshot(req)).json();
};
const audits = async (id: string) => (await sql`SELECT action FROM audit_log WHERE entity_type = 'tracked_marker' AND entity_id = ${id} ORDER BY created_at, id`).map((r: any) => r.action);

test("oncologist pins and unpins; each action writes an audit row", async () => {
  const id = markers["CEA"]!;
  expect((await pin(id, true)).status).toBe(200);
  let m = await row(id);
  expect(m.is_pinned).toBe(true);
  expect(m.pinned_by).toBe(oncologist.id);
  expect(m.pinned_at).not.toBeNull();
  expect((await pin(id, false)).status).toBe(200);
  m = await row(id);
  expect([m.is_pinned, m.pinned_by, m.pinned_at]).toEqual([false, null, null]);
  expect(await audits(id)).toEqual(["pin_marker", "unpin_marker"]);
  expect((await pin(id, "yes" as any)).status).toBe(400);
});

test("staff cannot pin (403) and the marker is unchanged", async () => {
  const id = markers["AFP"]!;
  expect((await pin(id, true, staff)).status).toBe(403);
  expect((await row(id)).is_pinned).toBe(false);
  expect(await audits(id)).toEqual([]);
});

test("staff suggest sets only suggestion fields, never the pin; a missing note is allowed", async () => {
  const id = markers["CA 19-9"]!;
  expect((await suggest(id, "  rising on last report  ")).status).toBe(200);
  const m = await row(id);
  expect([m.is_pinned, m.pinned_by, m.pinned_at]).toEqual([false, null, null]);
  expect(m.suggested_by).toBe(staff.id);
  expect(m.suggested_at).not.toBeNull();
  expect(m.suggested_note).toBe("rising on last report");
  expect((await suggest(id)).status).toBe(200);
  expect((await row(id)).suggested_note).toBeNull();
  expect((await audits(id)).every((a: string) => a === "suggest_pin")).toBe(true);
});

test("pinning clears the suggestion; a pinned marker cannot be suggested; dismiss clears without pinning", async () => {
  const id = markers["Hb"]!;
  await suggest(id, "watch this");
  expect((await dismiss(id)).status).toBe(200);
  let m = await row(id);
  expect([m.is_pinned, m.suggested_by, m.suggested_note]).toEqual([false, null, null]);
  expect((await dismiss(id)).status).toBe(409);
  expect((await call(dismissPinSuggestion, ["oncologist"], id, staff)).status).toBe(403);

  await suggest(id, "again");
  expect((await pin(id, true)).status).toBe(200);
  m = await row(id);
  expect([m.is_pinned, m.suggested_by, m.suggested_at, m.suggested_note]).toEqual([true, null, null, null]);
  expect((await suggest(id)).status).toBe(409);
  expect(await audits(id)).toEqual(["suggest_pin", "dismiss_pin_suggestion", "suggest_pin", "pin_marker"]);
  await pin(id, false);
});

test("unknown or malformed marker ids 404", async () => {
  expect((await pin("nope", true)).status).toBe(404);
  expect((await pin("00000000-0000-4000-8000-000000000000", true)).status).toBe(404);
  expect((await suggest("00000000-0000-4000-8000-000000000000")).status).toBe(404);
});

test("pins are per patient: another patient's snapshot never shows them", async () => {
  await pin(markers["CEA"]!, true);
  const body = await snapshot();
  expect(body.watchlist.map((w: any) => w.tracked_marker_id)).toEqual([markers["CEA"]]);
  expect(body.pin_options.map((o: any) => o.tracked_marker_id)).not.toContain(markers.other);
  expect((await row(markers.other!)).is_pinned).toBe(false);
  await pin(markers["CEA"]!, false);
});

test("snapshot watchlist: fixed order, latest + delta + sparkline, missing pin with last_seen, held facts excluded, suggestions", async () => {
  const cea = markers["CEA"]!, afp = markers["AFP"]!, ca = markers["CA 19-9"]!;
  const held = await newDocument(visit2, "mismatch");
  await newFact(doc1, visit1, cea, "3.0", "2026-01-01");
  await sql`UPDATE facts SET verification_state = 'oncologist_signed_off', signed_off_by = ${oncologist.id} WHERE tracked_marker_id = ${cea}`;
  await newFact(doc2, visit2, cea, "4.2", "2026-02-01");
  await newFact(held, visit2, cea, "99", "2026-02-02");
  // AFP: only in the older visit, so it is missing in this visit but has a last_seen.
  await newFact(doc1, visit1, afp, "1.5", "2026-01-05");
  await newFact(held, visit2, ca, "50", "2026-02-01");

  // Pin AFP first, then CEA, then CA 19-9 (which only has a held-document value).
  await pin(afp, true);
  await Bun.sleep(5);
  await pin(cea, true);
  await Bun.sleep(5);
  await pin(ca, true);
  await suggest(markers["Hb"]!, "anaemia query");

  const body = await snapshot();
  expect(body.watchlist.map((w: any) => w.marker_name)).toEqual(["AFP", "CEA", "CA 19-9"]);

  const [wAfp, wCea, wCa] = body.watchlist;
  expect(wAfp.missing).toBe(true);
  expect(wAfp.latest).toBeNull();
  expect(wAfp.last_seen).toMatchObject({ value: "1.5", unit: "ng/mL", as_of_date: "2026-01-05" });
  expect(wAfp.pinned_by_name).toBe("pins-onc");

  expect(wCea.missing).toBe(false);
  expect(wCea.latest).toMatchObject({ value: "4.2", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-02-01", delta_status: "changed", was: { value: "3.0" } });
  expect(wCea.latest.document_id).toBe(doc2);
  expect(wCea.sparkline.map((p: any) => p.value)).toEqual(["3.0", "4.2"]);

  // Held-document values never reach latest, sparkline or last_seen.
  expect(wCa.missing).toBe(true);
  expect(wCa.sparkline).toEqual([]);
  expect(wCa.last_seen).toBeNull();

  expect(body.suggested_pins).toEqual([
    { tracked_marker_id: markers["Hb"], marker_name: "Hb", suggested_by_name: "pins-staff", note: "anaemia query" },
  ]);
  expect(body.pin_options.find((o: any) => o.marker_name === "Hb")).toMatchObject({ is_pinned: false, suggested: true });
  expect(body.pin_options.find((o: any) => o.marker_name === "CEA")).toMatchObject({ is_pinned: true });
});
