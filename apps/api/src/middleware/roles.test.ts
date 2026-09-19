import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { requireRole } from "./roles";
import { createSession, sessionCookieHeader } from "./auth";

let staffId: string;
let oncId: string;
let staffToken: string;
let oncToken: string;

beforeAll(async () => {
  const passwordHash = await Bun.password.hash("test-password");
  const [staff] = await sql`
    INSERT INTO users (name, email, password_hash, role)
    VALUES ('Role Test Staff', 'role-test-staff@opd.local', ${passwordHash}, 'staff')
    RETURNING id
  `;
  const [onc] = await sql`
    INSERT INTO users (name, email, password_hash, role)
    VALUES ('Role Test Onc', 'role-test-onc@opd.local', ${passwordHash}, 'oncologist')
    RETURNING id
  `;
  staffId = staff.id;
  oncId = onc.id;

  const staffSession = await createSession(staffId);
  const oncSession = await createSession(oncId);
  staffToken = sessionCookieHeader(staffSession.token, staffSession.expiresAt);
  oncToken = sessionCookieHeader(oncSession.token, oncSession.expiresAt);
});

afterAll(async () => {
  await sql`DELETE FROM sessions WHERE user_id IN (${staffId}, ${oncId})`;
  await sql`DELETE FROM users WHERE id IN (${staffId}, ${oncId})`;
});

function requestWithCookie(cookieHeader: string): Request {
  const cookie = cookieHeader.split(";")[0]!; // "opd_session=<token>"
  return new Request("http://localhost/test", { headers: { cookie } });
}

test("requireRole rejects unauthenticated requests with 401", async () => {
  const handler = requireRole(["oncologist"], () => Response.json({ ok: true }));
  const res = await handler(new Request("http://localhost/test"));
  expect(res.status).toBe(401);
});

test("requireRole rejects wrong-role requests with 403", async () => {
  const handler = requireRole(["oncologist"], () => Response.json({ ok: true }));
  const res = await handler(requestWithCookie(staffToken));
  expect(res.status).toBe(403);
});

test("requireRole allows matching-role requests through", async () => {
  const handler = requireRole(["oncologist"], (_req, user) => Response.json({ role: user.role }));
  const res = await handler(requestWithCookie(oncToken));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ role: "oncologist" });
});

test("requireRole allows either role when both are listed", async () => {
  const handler = requireRole(["staff", "oncologist"], (_req, user) => Response.json({ role: user.role }));
  const res = await handler(requestWithCookie(staffToken));
  expect(res.status).toBe(200);
});
