import { test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { sql } from "../db/client";
import * as providerFactory from "../services/providerFactory";
import { resolveLocalPath } from "../services/storage";
import { isDictationEnabledFor, allowedDictationMime, validDuration } from "../services/dictation";
import { recordDictation } from "./dictation";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, requestWithCookie, type TestUser } from "../test-helpers";

// Free ports come from binding port 0 and reading what the OS chose.
function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  void s.stop(true);
  return port;
}
const PORT = freePort();
const BASE = `http://localhost:${PORT}`;
const MISSING_ID = "00000000-0000-0000-0000-000000000000";

let server: ReturnType<typeof Bun.spawn>;
let staff: TestUser;
let onc: TestUser;
let otherOnc: TestUser;
let patientId: string;
let visitId: string;
let flaglessServer: ReturnType<typeof Bun.spawn>;
const FLAGLESS_PORT = freePort();

async function waitFor(base: string) {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`API server at ${base} did not come up`);
}

const audio = (size = 2048) => new Uint8Array(size).fill(7);
const post = (cookie: string | null, o: { type?: string; seconds?: string; body?: BodyInit; base?: string; visit?: string } = {}) =>
  fetch(`${o.base ?? BASE}/visits/${o.visit ?? visitId}/dictation?duration_seconds=${o.seconds ?? "42"}`, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": o.type ?? "audio/webm;codecs=opus" },
    body: o.body ?? audio(),
  });

beforeAll(async () => {
  staff = await createTestUser("staff", "dict-staff");
  onc = await createTestUser("oncologist", "dict-onc");
  otherOnc = await createTestUser("oncologist", "dict-onc2");
  patientId = (await createTestPatient(staff.id)).id;
  const [v] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-02') RETURNING id`;
  visitId = v.id;
  const cwd = resolve(import.meta.dir, "../../../..");
  server = Bun.spawn(["bun", "apps/api/src/index.ts"], { cwd, env: { ...process.env, PORT: String(PORT), DICTATION_PILOT_USER_ID: onc.id }, stdout: "ignore", stderr: "ignore" });
  const env2 = { ...process.env, PORT: String(FLAGLESS_PORT) } as Record<string, string | undefined>;
  delete env2.DICTATION_PILOT_USER_ID;
  flaglessServer = Bun.spawn(["bun", "apps/api/src/index.ts"], { cwd, env: env2, stdout: "ignore", stderr: "ignore" });
  await waitFor(BASE);
  await waitFor(`http://localhost:${FLAGLESS_PORT}`);
}, 30_000);

afterAll(async () => {
  server?.kill();
  flaglessServer?.kill();
  await Promise.all([server?.exited, flaglessServer?.exited]);
  const rows = await sql`SELECT file_ref FROM visit_dictations WHERE patient_id = ${patientId}`;
  for (const r of rows) await Bun.file(resolveLocalPath(r.file_ref)).delete().catch(() => {});
  // The access log outlives recordings (ON DELETE RESTRICT), so test cleanup removes its rows explicitly.
  await sql`DELETE FROM dictation_access_log WHERE dictation_id IN (SELECT id FROM visit_dictations WHERE patient_id = ${patientId})`;
  await sql`DELETE FROM visit_dictations WHERE patient_id = ${patientId}`;
  await sql`DELETE FROM audit_log WHERE entity_type = 'visit' AND entity_id = ${visitId}`;
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, onc.id, otherOnc.id);
});

// ---- pure ----

test("isDictationEnabledFor: only an oncologist whose id is listed", () => {
  const o = { id: "u1", role: "oncologist" };
  expect(isDictationEnabledFor(o, undefined)).toBe(false);
  expect(isDictationEnabledFor(o, "")).toBe(false);
  expect(isDictationEnabledFor(o, "u2")).toBe(false);
  expect(isDictationEnabledFor({ id: "u1", role: "staff" }, "u1")).toBe(false);
  expect(isDictationEnabledFor(null, "u1")).toBe(false);
  expect(isDictationEnabledFor(o, "u1")).toBe(true);
  expect(isDictationEnabledFor(o, "u2, u1")).toBe(true);
  expect(isDictationEnabledFor({ id: "ABC-1", role: "oncologist" }, "abc-1")).toBe(true);
  expect(isDictationEnabledFor({ id: "abc-1", role: "oncologist" }, " ABC-1 ")).toBe(true);
});

test("mime allowlist ignores parameters; duration must be a whole number 1..1800", () => {
  expect(allowedDictationMime("audio/webm;codecs=opus")).toBe("audio/webm");
  expect(allowedDictationMime("audio/mpeg")).toBe("audio/mpeg");
  expect(allowedDictationMime("video/webm")).toBeNull();
  expect(allowedDictationMime(null)).toBeNull();
  for (const n of [0, 1801, 1.5, NaN, -1]) expect(validDuration(n)).toBe(false);
  for (const n of [1, 1800]) expect(validDuration(n)).toBe(true);
});

// ---- through the router ----

test("auth/me and login: `features` exists only for the flagged oncologist; everyone else gets no such key", async () => {
  const me = async (cookie: string, base = BASE) => (await (await fetch(`${base}/auth/me`, { headers: { cookie } })).json()) as any;
  expect((await me(onc.cookie)).features).toEqual({ dictation: true });
  for (const cookie of [otherOnc.cookie, staff.cookie]) {
    const body = await me(cookie);
    expect("features" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain("dictat");
  }
  expect("features" in (await me(onc.cookie, `http://localhost:${FLAGLESS_PORT}`))).toBe(false);
  const login = async (u: TestUser) => {
    const [{ email }] = await sql`SELECT email FROM users WHERE id = ${u.id}`;
    return (await (await fetch(`${BASE}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "test-password" }) })).json()) as any;
  };
  expect((await login(onc)).features).toEqual({ dictation: true });
  expect("features" in (await login(staff))).toBe(false);
});

test("routes: no session 401; staff and other oncologists 404 (never 403); flag off 404 even for the oncologist", async () => {
  const paths: [string, string][] = [["POST", `/visits/${visitId}/dictation?duration_seconds=5`], ["GET", `/visits/${visitId}/dictations`], ["GET", `/dictations/${MISSING_ID}/audio`]];
  for (const [method, path] of paths) {
    const init = (cookie?: string) => ({ method, headers: { ...(cookie ? { cookie } : {}), "content-type": "audio/webm" }, body: method === "POST" ? audio() : undefined });
    expect((await fetch(`${BASE}${path}`, init())).status).toBe(401);
    expect((await fetch(`${BASE}${path}`, init(staff.cookie))).status).toBe(404);
    expect((await fetch(`${BASE}${path}`, init(otherOnc.cookie))).status).toBe(404);
    expect((await fetch(`http://localhost:${FLAGLESS_PORT}${path}`, init(onc.cookie))).status).toBe(404);
  }
  const [{ count }] = await sql`SELECT count(*)::int FROM visit_dictations WHERE visit_id = ${visitId}`;
  expect(count).toBe(0);
});

test("record validation: bad mime, too large, duration 0 and 1801, empty, unknown visit", async () => {
  expect((await post(onc.cookie, { type: "text/plain" })).status).toBe(400);
  expect((await post(onc.cookie, { type: "video/webm" })).status).toBe(400);
  expect((await post(onc.cookie, { seconds: "0" })).status).toBe(400);
  expect((await post(onc.cookie, { seconds: "1801" })).status).toBe(400);
  expect((await post(onc.cookie, { seconds: "abc" })).status).toBe(400);
  expect((await post(onc.cookie, { body: new Uint8Array(0) })).status).toBe(400);
  expect((await post(onc.cookie, { body: new Uint8Array(25 * 1024 * 1024 + 1) })).status).toBe(413);
  expect((await post(onc.cookie, { visit: MISSING_ID })).status).toBe(404);
  expect((await post(onc.cookie, { visit: "not-a-uuid" })).status).toBe(404);
  const [{ count }] = await sql`SELECT count(*)::int FROM visit_dictations WHERE visit_id = ${visitId}`;
  expect(count).toBe(0);
});

let firstId: string;

test("record: stores the file, an audit row and a 'record' access-log row; response has no file_ref", async () => {
  const res = await post(onc.cookie, { seconds: "75" });
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  firstId = body.id;
  expect(body.duration_seconds).toBe(75);
  expect(JSON.stringify(body)).not.toContain("file_ref");
  const [row] = await sql`SELECT * FROM visit_dictations WHERE id = ${firstId}`;
  expect(row.file_ref.startsWith("local://dictations/")).toBe(true);
  expect(row.mime).toBe("audio/webm");
  expect(row.size_bytes).toBe(2048);
  expect(row.recorded_by).toBe(onc.id);
  expect(existsSync(resolveLocalPath(row.file_ref))).toBe(true);
  const audit = await sql`SELECT after_value FROM audit_log WHERE action = 'record_dictation' AND entity_id = ${visitId}`;
  expect(audit.length).toBe(1);
  const after = typeof audit[0].after_value === "string" ? JSON.parse(audit[0].after_value) : audit[0].after_value;
  expect(after.dictation_id).toBe(firstId);
  const log = await sql`SELECT user_id, action FROM dictation_access_log WHERE dictation_id = ${firstId}`;
  expect(log.map((l: any) => [l.user_id, l.action])).toEqual([[onc.id, "record"]]);
});

test("list: newest first with recorded-by name and duration, and no file_ref", async () => {
  await Bun.sleep(5);
  expect((await post(onc.cookie, { seconds: "9", type: "audio/ogg" })).status).toBe(201);
  const res = await fetch(`${BASE}/visits/${visitId}/dictations`, { headers: { cookie: onc.cookie } });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("file_ref");
  const list = JSON.parse(text) as any[];
  expect(list.map((d) => d.duration_seconds)).toEqual([9, 75]);
  expect(list[0].recorded_by_name).toBe("dict-onc");
  expect(Object.keys(list[0]).sort()).toEqual(["created_at", "duration_seconds", "id", "recorded_by_name"]);
  expect((await fetch(`${BASE}/visits/${MISSING_ID}/dictations`, { headers: { cookie: onc.cookie } })).status).toBe(404);
});

test("audio: streams with content type and no-store, logs one 'play' per request (repeats included), supports Range", async () => {
  const get = (headers: Record<string, string> = {}) => fetch(`${BASE}/dictations/${firstId}/audio`, { headers: { cookie: onc.cookie, ...headers } });
  const plays = async () => (await sql`SELECT user_id FROM dictation_access_log WHERE dictation_id = ${firstId} AND action = 'play'`).length;
  expect(await plays()).toBe(0);
  const res = await get();
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/webm");
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect((await res.arrayBuffer()).byteLength).toBe(2048);
  expect(await plays()).toBe(1);
  expect((await (await get()).arrayBuffer()).byteLength).toBe(2048);
  expect(await plays()).toBe(2);
  const part = await get({ range: "bytes=10-19" });
  expect(part.status).toBe(206);
  expect(part.headers.get("content-range")).toBe("bytes 10-19/2048");
  expect((await part.arrayBuffer()).byteLength).toBe(10);
  expect(await plays()).toBe(3);
  const [l] = await sql`SELECT user_id, accessed_at FROM dictation_access_log WHERE dictation_id = ${firstId} AND action = 'play' LIMIT 1`;
  expect(l.user_id).toBe(onc.id);
  expect(l.accessed_at).toBeInstanceOf(Date);
});

test("audio: unknown id 404 and a recording whose file is missing 404 with NO play row (nothing was played)", async () => {
  expect((await fetch(`${BASE}/dictations/${MISSING_ID}/audio`, { headers: { cookie: onc.cookie } })).status).toBe(404);
  expect((await fetch(`${BASE}/dictations/nope/audio`, { headers: { cookie: onc.cookie } })).status).toBe(404);
  const [{ id }] = await sql`
    INSERT INTO visit_dictations (visit_id, patient_id, recorded_by, file_ref, mime, duration_seconds, size_bytes)
    VALUES (${visitId}, ${patientId}, ${onc.id}, 'local://dictations/missing/none.webm', 'audio/webm', 5, 1) RETURNING id`;
  expect((await fetch(`${BASE}/dictations/${id}/audio`, { headers: { cookie: onc.cookie } })).status).toBe(404);
  expect((await sql`SELECT 1 FROM dictation_access_log WHERE dictation_id = ${id}`).length).toBe(0);
  await sql`DELETE FROM visit_dictations WHERE id = ${id}`;
});

test("visits list: dictated_note_seconds only for the flagged oncologist; staff and other users get no such field", async () => {
  const get = async (cookie: string, base = BASE) => (await (await fetch(`${base}/patients/${patientId}/visits`, { headers: { cookie } })).json()) as any[];
  const asOnc = await get(onc.cookie);
  expect(asOnc[0].dictated_note_seconds).toBe(9);
  for (const cookie of [staff.cookie, otherOnc.cookie]) {
    const rows = await get(cookie);
    expect(rows.length).toBe(1);
    expect("dictated_note_seconds" in rows[0]).toBe(false);
    expect(JSON.stringify(rows)).not.toContain("dictat");
  }
  // Flag off: not even the oncologist gets the field.
  expect("dictated_note_seconds" in (await get(onc.cookie, `http://localhost:${FLAGLESS_PORT}`))[0]!).toBe(false);
  // Other patient-level payloads carry nothing about dictation for staff.
  for (const p of [`/patients/${patientId}`, `/patients/${patientId}/snapshot`, `/patients/${patientId}/timeline`]) {
    const text = await (await fetch(`${BASE}${p}`, { headers: { cookie: staff.cookie } })).text();
    expect(text.toLowerCase()).not.toContain("dictat");
  }
});

test("post-blob size check: a chunked body without Content-Length over the cap is 413 and stores nothing", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(3);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent > 25) return c.close();
      sent++;
      c.enqueue(chunk);
    },
  });
  const res = await fetch(`${BASE}/visits/${visitId}/dictation?duration_seconds=5`, {
    method: "POST",
    headers: { cookie: onc.cookie, "content-type": "audio/webm" },
    body,
    duplex: "half",
  } as RequestInit);
  expect(res.status).toBe(413);
  const [{ count }] = await sql`SELECT count(*)::int FROM visit_dictations WHERE visit_id = ${visitId} AND size_bytes > 25 * 1024 * 1024`;
  expect(count).toBe(0);
});

const dictationDir = () => resolveLocalPath(`local://dictations/${visitId}`);
const filesInDir = () => (existsSync(dictationDir()) ? readdirSync(dictationDir()).length : 0);

test("a failed access-log insert prevents streaming, and a DB failure after the file is stored removes the file", async () => {
  await sql`
    CREATE OR REPLACE FUNCTION test_fail_dictation_log() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced log failure'; END; $$ LANGUAGE plpgsql`;
  await sql`CREATE TRIGGER test_fail_dictation_log BEFORE INSERT ON dictation_access_log FOR EACH ROW EXECUTE FUNCTION test_fail_dictation_log()`;
  try {
    const before = filesInDir();
    const dictationsBefore = (await sql`SELECT 1 FROM visit_dictations WHERE visit_id = ${visitId}`).length;
    // Recording: the transaction rolls back and the stored file is removed.
    const rec = await post(onc.cookie, { seconds: "4" });
    expect(rec.status).toBeGreaterThanOrEqual(500);
    expect(filesInDir()).toBe(before);
    expect((await sql`SELECT 1 FROM visit_dictations WHERE visit_id = ${visitId}`).length).toBe(dictationsBefore);
    // Playing: no bytes are streamed when the log row cannot be written.
    const play = await fetch(`${BASE}/dictations/${firstId}/audio`, { headers: { cookie: onc.cookie } });
    expect(play.status).toBeGreaterThanOrEqual(500);
    expect(play.headers.get("content-type") ?? "").not.toContain("audio/");
    expect((await play.arrayBuffer()).byteLength).toBeLessThan(2048);
  } finally {
    await sql`DROP TRIGGER IF EXISTS test_fail_dictation_log ON dictation_access_log`;
    await sql`DROP FUNCTION IF EXISTS test_fail_dictation_log()`;
  }
});

test("the access log outlives recordings: deleting a dictation or its visit with log rows fails", async () => {
  expect((await sql`SELECT 1 FROM dictation_access_log WHERE dictation_id = ${firstId}`).length).toBeGreaterThan(0);
  const fails = async (run: () => Promise<unknown>) => {
    try { await run(); } catch { return true; }
    return false;
  };
  expect(await fails(async () => { await sql`DELETE FROM visit_dictations WHERE id = ${firstId}`; })).toBe(true);
  expect(await fails(async () => { await sql`DELETE FROM visits WHERE id = ${visitId}`; })).toBe(true);
  expect((await sql`SELECT 1 FROM visit_dictations WHERE id = ${firstId}`).length).toBe(1);
});

// ---- no transcription ----

test("recording calls no OCR, extraction or LLM provider", async () => {
  const prev = process.env.DICTATION_PILOT_USER_ID;
  process.env.DICTATION_PILOT_USER_ID = onc.id;
  const spies = [
    spyOn(providerFactory, "getOcrProvider"),
    spyOn(providerFactory, "getExtractionProvider"),
    spyOn(providerFactory, "getLlmExtractionProvider"),
  ];
  try {
    const req = requestWithCookie(`http://localhost/visits/${visitId}/dictation?duration_seconds=3`, onc.cookie, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: audio(64),
    }) as Request & { params: { id: string } };
    req.params = { id: visitId };
    expect((await recordDictation(req, asAuthedUser(onc))).status).toBe(201);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    const [{ count }] = await sql`SELECT count(*)::int FROM facts WHERE visit_id = ${visitId}`;
    expect(count).toBe(0);
  } finally {
    spies.forEach((s) => s.mockRestore());
    if (prev === undefined) delete process.env.DICTATION_PILOT_USER_ID;
    else process.env.DICTATION_PILOT_USER_ID = prev;
  }
});

test("migration 020 is applied: both foreign keys are ON DELETE RESTRICT", async () => {
  const r = await sql`
    SELECT conrelid::regclass::text AS tbl, confdeltype FROM pg_constraint
    WHERE conname IN ('dictation_access_log_dictation_id_fkey', 'visit_dictations_visit_id_fkey')`;
  expect(r.length).toBe(2);
  for (const c of r) expect(c.confdeltype).toBe("r");
});

test("migration 019 is applied: both tables and the visit index exist", async () => {
  const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_name IN ('visit_dictations', 'dictation_access_log')`;
  expect(t.length).toBe(2);
  const i = await sql`SELECT 1 FROM pg_indexes WHERE tablename = 'visit_dictations' AND indexdef LIKE '%(visit_id)%'`;
  expect(i.length).toBe(1);
});
