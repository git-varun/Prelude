import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";
import type { UserRole } from "@prelude/shared";

const ROLES: UserRole[] = ["staff", "oncologist"];

interface CreateUserBody {
  name?: string;
  email?: string;
  password?: string;
  role?: UserRole;
}

// m1-backlog Q1: minimal oncologist-only account provisioning, so real
// staff/oncologist accounts before pilot don't depend on running
// db/seed.ts or a raw SQL insert. Not in the frozen API contract table
// (docs/01 §11) — same precedent as GET /patients (m1-backlog, resolved gaps).
export async function createUser(req: Request, _actor: AuthedUser): Promise<Response> {
  let body: CreateUserBody;
  try {
    body = (await req.json()) as CreateUserBody;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }

  const { name, email, password, role } = body;
  if (!name || typeof name !== "string") {
    return jsonError(400, "bad_request", "name is required.");
  }
  if (!email || typeof email !== "string") {
    return jsonError(400, "bad_request", "email is required.");
  }
  if (!password || typeof password !== "string" || password.length < 8) {
    return jsonError(400, "bad_request", "password is required and must be at least 8 characters.");
  }
  if (!role || !ROLES.includes(role)) {
    return jsonError(400, "bad_request", `role must be one of: ${ROLES.join(", ")}.`);
  }

  const password_hash = await Bun.password.hash(password);

  try {
    const [user] = await sql`
      INSERT INTO users (name, email, password_hash, role)
      VALUES (${name}, ${email}, ${password_hash}, ${role})
      RETURNING id, name, email, role, created_at
    `;
    return Response.json(user, { status: 201 });
  } catch (err) {
    if (err instanceof Error && "errno" in err && (err as { errno?: string }).errno === "23505") {
      return jsonError(409, "conflict", "A user with this email already exists.");
    }
    throw err;
  }
}
