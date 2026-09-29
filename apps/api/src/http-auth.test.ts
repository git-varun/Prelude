import { test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { sql } from "./db/client";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "./test-helpers";

// Real HTTP against the real server (src/index.ts) so the route table's
// requireRole wiring is what's under test. Handler-level tests call handlers
// directly and would pass even if a route were registered without requireRole.
const PORT = 3600 + Math.floor(Math.random() * 300);
const BASE = `http://localhost:${PORT}`;
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

let server: ReturnType<typeof Bun.spawn>;
let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let documentId: string;

beforeAll(async () => {
  server = Bun.spawn(["bun", "apps/api/src/index.ts"], {
    cwd: resolve(import.meta.dir, "../../.."),
    env: { ...process.env, PORT: String(PORT) },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {}
    await Bun.sleep(100);
  }

  staff = await createTestUser("staff", "http-auth-staff");
  oncologist = await createTestUser("oncologist", "http-auth-onc");
  patientId = (await createTestPatient(staff.id)).id;
  const [visit] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visit.id}, 'local://test/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done')
    RETURNING id
  `;
  documentId = doc.id;
}, 30_000);

afterAll(async () => {
  server?.kill();
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

const patchInit = (headers: Record<string, string> = {}) => ({
  method: "PATCH",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ value: "1" }),
});

test("GET /documents/:id/facts without a session -> 401", async () => {
  const res = await fetch(`${BASE}/documents/${documentId}/facts`);
  expect(res.status).toBe(401);
});

test("PATCH /facts/:id without a session -> 401", async () => {
  const res = await fetch(`${BASE}/facts/${MISSING_ID}`, patchInit());
  expect(res.status).toBe(401);
});

test("a garbage session cookie is treated as no session -> 401", async () => {
  const cookie = { cookie: "opd_session=not-a-real-token" };
  expect((await fetch(`${BASE}/documents/${documentId}/facts`, { headers: cookie })).status).toBe(401);
  expect((await fetch(`${BASE}/facts/${MISSING_ID}`, patchInit(cookie))).status).toBe(401);
});

test("a staff session passes the role check on the staff-allowed fact routes (control: 401 above is the middleware, not a dead route)", async () => {
  const ok = await fetch(`${BASE}/documents/${documentId}/facts`, { headers: { cookie: staff.cookie } });
  expect(ok.status).toBe(200);
  // Past auth: the handler runs and 404s on a fact that doesn't exist.
  const res = await fetch(`${BASE}/facts/${MISSING_ID}`, patchInit({ cookie: staff.cookie }));
  expect(res.status).toBe(404);
});

// Neither fact route is oncologist-only (both allow staff + oncologist), so
// the 403 path is exercised on the real oncologist-only route, POST /users.
test("POST /users (oncologist-only) without a session -> 401, with a staff session -> 403", async () => {
  const body = JSON.stringify({ name: "x", email: `x-${crypto.randomUUID()}@opd.local`, password: "pw-123456", role: "staff" });
  const init = (headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
  expect((await fetch(`${BASE}/users`, init())).status).toBe(401);
  expect((await fetch(`${BASE}/users`, init({ cookie: staff.cookie }))).status).toBe(403);
});

test("POST /facts/:id/sign-off: no session -> 401, staff -> 403 and the fact is untouched, oncologist passes the role check", async () => {
  const [visit] = await sql`SELECT id FROM visits WHERE patient_id = ${patientId} LIMIT 1`;
  const [marker] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  const [fact] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value, as_of_date, coverage_status, verification_state)
    VALUES (${patientId}, ${visit.id}, ${documentId}, ${marker.id}, 'marker_value', '4.2', '2026-02-01', 'value_found', 'unverified')
    RETURNING id`;
  const post = (headers: Record<string, string> = {}) => fetch(`${BASE}/facts/${fact.id}/sign-off`, { method: "POST", headers });

  expect((await post()).status).toBe(401);
  expect((await post({ cookie: staff.cookie })).status).toBe(403);
  const [after] = await sql`SELECT verification_state FROM facts WHERE id = ${fact.id}`;
  expect(after.verification_state).toBe("unverified");

  expect((await post({ cookie: oncologist.cookie })).status).toBe(200);
});

test("POST /facts/:id/reopen: no session -> 401, staff -> 403 and the fact is untouched, oncologist passes the role check", async () => {
  const [visit] = await sql`SELECT id FROM visits WHERE patient_id = ${patientId} LIMIT 1`;
  const [fact] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, coverage_status, verification_state, signed_off_by, signed_off_at)
    VALUES (${patientId}, ${visit.id}, ${documentId}, 'marker_value', '4.2', '2026-02-01', 'value_found', 'oncologist_signed_off', ${oncologist.id}, now())
    RETURNING id`;
  const post = (headers: Record<string, string> = {}) => fetch(`${BASE}/facts/${fact.id}/reopen`, { method: "POST", headers });

  expect((await post()).status).toBe(401);
  expect((await post({ cookie: staff.cookie })).status).toBe(403);
  const [after] = await sql`SELECT verification_state FROM facts WHERE id = ${fact.id}`;
  expect(after.verification_state).toBe("oncologist_signed_off");

  expect((await post({ cookie: oncologist.cookie })).status).toBe(200);
});
