import { afterEach, expect, test } from "bun:test";
import { clearedCookieHeader, sessionCookieHeader } from "./auth";

const saved = process.env.NODE_ENV;
afterEach(() => {
  if (saved === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = saved;
});

test("in production the session cookie is Secure (it is only ever served over HTTPS)", () => {
  process.env.NODE_ENV = "production";
  expect(sessionCookieHeader("t", new Date(0))).toContain("; Secure");
  expect(clearedCookieHeader()).toContain("; Secure");
});

test("outside production the cookie has no Secure flag, so http://localhost login keeps working", () => {
  process.env.NODE_ENV = "development";
  expect(sessionCookieHeader("t", new Date(0))).not.toContain("Secure");
  expect(clearedCookieHeader()).not.toContain("Secure");
  delete process.env.NODE_ENV;
  expect(sessionCookieHeader("t", new Date(0))).not.toContain("Secure");
});

test("the cookie stays HttpOnly and SameSite=Lax either way", () => {
  process.env.NODE_ENV = "production";
  expect(sessionCookieHeader("t", new Date(0))).toContain("HttpOnly; SameSite=Lax");
});
