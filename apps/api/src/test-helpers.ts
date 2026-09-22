import { sql } from "./db/client";
import { createSession, sessionCookieHeader, type AuthedUser } from "./middleware/auth";
import type { UserRole } from "@opd/shared";

export interface TestUser {
  id: string;
  role: UserRole;
  cookie: string;
}

/** Creates a DB-backed user + session, mirroring roles.test.ts's pattern. */
export async function createTestUser(role: UserRole, label: string): Promise<TestUser> {
  const passwordHash = await Bun.password.hash("test-password");
  const email = `${label}-${crypto.randomUUID()}@opd.local`;
  const [user] = await sql`
    INSERT INTO users (name, email, password_hash, role)
    VALUES (${label}, ${email}, ${passwordHash}, ${role})
    RETURNING id
  `;
  const session = await createSession(user.id);
  const cookie = sessionCookieHeader(session.token, session.expiresAt).split(";")[0]!;
  return { id: user.id as string, role, cookie };
}

export async function deleteTestUsers(...ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`DELETE FROM sessions WHERE user_id IN ${sql(ids)}`;
  await sql`DELETE FROM audit_log WHERE actor_id IN ${sql(ids)}`;
  await sql`DELETE FROM users WHERE id IN ${sql(ids)}`;
}

export function requestWithCookie(url: string, cookie: string, init: RequestInit = {}): Request {
  return new Request(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } });
}

export async function createTestPatient(createdBy: string): Promise<{ id: string }> {
  const [patient] = await sql`
    INSERT INTO patients (name, cancer_type, created_by)
    VALUES ('Test Patient', 'Breast', ${createdBy})
    RETURNING id
  `;
  return { id: patient.id as string };
}

export async function deleteTestPatients(...ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`DELETE FROM audit_log WHERE entity_type = 'fact' AND entity_id IN (SELECT id FROM facts WHERE patient_id IN ${sql(ids)})`;
  await sql`DELETE FROM audit_log WHERE entity_type = 'document' AND entity_id IN (SELECT id FROM documents WHERE patient_id IN ${sql(ids)})`;
  await sql`DELETE FROM facts WHERE patient_id IN ${sql(ids)}`;
  await sql`DELETE FROM documents WHERE patient_id IN ${sql(ids)}`;
  await sql`DELETE FROM tracked_markers WHERE patient_id IN ${sql(ids)}`;
  await sql`DELETE FROM visits WHERE patient_id IN ${sql(ids)}`;
  await sql`DELETE FROM patients WHERE id IN ${sql(ids)}`;
}

export function asAuthedUser(user: TestUser): AuthedUser {
  return { id: user.id, role: user.role } as AuthedUser;
}
