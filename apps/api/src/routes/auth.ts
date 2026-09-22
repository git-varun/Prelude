import { sql } from "../db/client";
import { createSession, destroySession, sessionCookieHeader, clearedCookieHeader, getAuthedUser, jsonError } from "../middleware/auth";

interface LoginBody {
  email?: string;
  password?: string;
}

// m1-backlog B6: in-memory brute-force guard keyed on the attempted email
// (not IP — `login` has no access to the request's source IP at this call
// site, and keying on email is what actually stops account brute-forcing).
// Single-instance only; fine at MVP scale, revisit if this ever runs behind
// a multi-instance deployment.
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; windowStart: number }>();

function isRateLimited(email: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(email);
  if (!entry || now - entry.windowStart > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttempts.set(email, { count: 0, windowStart: now });
    return false;
  }
  return entry.count >= LOGIN_ATTEMPT_LIMIT;
}

function recordFailedAttempt(email: string): void {
  const entry = loginAttempts.get(email);
  if (entry) entry.count += 1;
}

function clearAttempts(email: string): void {
  loginAttempts.delete(email);
}

export async function login(req: Request): Promise<Response> {
  let body: LoginBody;
  try {
    body = (await req.json()) as LoginBody;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }

  const { email, password } = body;
  if (!email || !password) {
    return jsonError(400, "bad_request", "email and password are required.");
  }

  if (isRateLimited(email)) {
    return jsonError(429, "too_many_requests", "Too many failed login attempts. Try again later.");
  }

  const rows = await sql`
    SELECT id, name, email, role, password_hash FROM users WHERE email = ${email}
  `;
  const row = rows[0] as { id: string; name: string; email: string; role: string; password_hash: string } | undefined;
  if (!row) {
    recordFailedAttempt(email);
    return jsonError(401, "invalid_credentials", "Invalid email or password.");
  }

  const valid = await Bun.password.verify(password, row.password_hash);
  if (!valid) {
    recordFailedAttempt(email);
    return jsonError(401, "invalid_credentials", "Invalid email or password.");
  }

  clearAttempts(email);
  const { token, expiresAt } = await createSession(row.id);
  return Response.json(
    { id: row.id, name: row.name, email: row.email, role: row.role },
    { status: 200, headers: { "Set-Cookie": sessionCookieHeader(token, expiresAt) } },
  );
}

export async function logout(req: Request): Promise<Response> {
  const header = req.headers.get("cookie");
  const token = header
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith("opd_session="))
    ?.split("=")[1];
  if (token) {
    await destroySession(token);
  }
  return new Response(null, { status: 204, headers: { "Set-Cookie": clearedCookieHeader() } });
}

export async function me(req: Request): Promise<Response> {
  const user = await getAuthedUser(req);
  if (!user) {
    return jsonError(401, "unauthenticated", "Sign in required.");
  }
  return Response.json(user);
}
