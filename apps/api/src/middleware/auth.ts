import { sql } from "../db/client";
import type { User } from "@opd/shared";

const SESSION_COOKIE = "opd_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export interface AuthedUser extends User {}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await sql`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES (${token}, ${userId}, ${expiresAt})
  `;
  // Piggyback expired-row cleanup on the login path (m1-backlog B2) rather
  // than a separate cron — at MVP login volume this keeps the table bounded
  // without any new infrastructure.
  await sql`DELETE FROM sessions WHERE expires_at <= now()`;
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE token = ${token}`;
}

export function sessionCookieHeader(token: string, expiresAt: Date): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
}

export function clearedCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export async function getAuthedUser(req: Request): Promise<AuthedUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const rows = await sql`
    SELECT u.id, u.name, u.email, u.role, u.created_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ${token} AND s.expires_at > now()
  `;
  if (rows.length === 0) return null;
  return rows[0] as AuthedUser;
}

export function jsonError(status: number, error: string, message: string): Response {
  return Response.json({ error, message }, { status });
}
