import { sql } from "../db/client";
import { createSession, destroySession, sessionCookieHeader, clearedCookieHeader, getAuthedUser, jsonError } from "../middleware/auth";

interface LoginBody {
  email?: string;
  password?: string;
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

  const rows = await sql`
    SELECT id, name, email, role, password_hash FROM users WHERE email = ${email}
  `;
  const row = rows[0] as { id: string; name: string; email: string; role: string; password_hash: string } | undefined;
  if (!row) {
    return jsonError(401, "invalid_credentials", "Invalid email or password.");
  }

  const valid = await Bun.password.verify(password, row.password_hash);
  if (!valid) {
    return jsonError(401, "invalid_credentials", "Invalid email or password.");
  }

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
