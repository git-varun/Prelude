import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { login, logout, me } from "./auth";
import { requestWithCookie } from "../test-helpers";

const email = `auth-test-${crypto.randomUUID()}@opd.local`;
const password = "correct-password";
let userId: string;

beforeAll(async () => {
  const password_hash = await Bun.password.hash(password);
  const [user] = await sql`
    INSERT INTO users (name, email, password_hash, role)
    VALUES ('Auth Test', ${email}, ${password_hash}, 'staff')
    RETURNING id
  `;
  userId = user.id as string;
});

afterAll(async () => {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
});

function loginRequest(body: unknown): Request {
  return new Request("http://localhost/auth/login", { method: "POST", body: JSON.stringify(body) });
}

test("login rejects an unknown email with 401", async () => {
  const res = await login(loginRequest({ email: "nobody@opd.local", password: "whatever" }));
  expect(res.status).toBe(401);
});

test("login succeeds with correct credentials and sets a session cookie", async () => {
  const res = await login(loginRequest({ email, password }));
  expect(res.status).toBe(200);
  expect(res.headers.get("set-cookie")).toContain("opd_session=");
  const body = (await res.json()) as any;
  expect(body.email).toBe(email);
});

test("me returns 401 with no session cookie", async () => {
  const res = await me(new Request("http://localhost/auth/me"));
  expect(res.status).toBe(401);
});

test("me returns the authed user for a valid session", async () => {
  const loginRes = await login(loginRequest({ email, password }));
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;
  const res = await me(requestWithCookie("http://localhost/auth/me", cookie));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.email).toBe(email);
});

test("logout clears the session so it can no longer authenticate", async () => {
  const loginRes = await login(loginRequest({ email, password }));
  const cookie = loginRes.headers.get("set-cookie")!.split(";")[0]!;

  const logoutRes = await logout(requestWithCookie("http://localhost/auth/logout", cookie));
  expect(logoutRes.status).toBe(204);

  const meRes = await me(requestWithCookie("http://localhost/auth/me", cookie));
  expect(meRes.status).toBe(401);
});

test("login rate-limits repeated failed attempts for the same email", async () => {
  const rateLimitEmail = `rate-limit-${crypto.randomUUID()}@opd.local`;
  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const res = await login(loginRequest({ email: rateLimitEmail, password: "wrong" }));
    lastStatus = res.status;
  }
  expect(lastStatus).toBe(429);
});
