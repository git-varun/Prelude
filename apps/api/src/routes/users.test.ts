import { test, expect, beforeAll, afterAll } from "bun:test";
import { createUser } from "./users";
import { createTestUser, deleteTestUsers, asAuthedUser, type TestUser } from "../test-helpers";

let oncologist: TestUser;
const createdEmails: string[] = [];
const createdIds: string[] = [];

beforeAll(async () => {
  oncologist = await createTestUser("oncologist", "users-test-onc");
});

afterAll(async () => {
  await deleteTestUsers(oncologist.id, ...createdIds);
});

function userRequest(body: unknown): Request {
  return new Request("http://localhost/users", { method: "POST", body: JSON.stringify(body) });
}

test("createUser creates a new staff account", async () => {
  const email = `new-staff-${crypto.randomUUID()}@opd.local`;
  createdEmails.push(email);
  const res = await createUser(
    userRequest({ name: "New Staff", email, password: "a-strong-password", role: "staff" }),
    asAuthedUser(oncologist),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as any;
  createdIds.push(body.id);
  expect(body.email).toBe(email);
  expect(body.password_hash).toBeUndefined();
});

test("createUser rejects a duplicate email with 409", async () => {
  const email = `dup-${crypto.randomUUID()}@opd.local`;
  const first = await createUser(
    userRequest({ name: "First", email, password: "a-strong-password", role: "staff" }),
    asAuthedUser(oncologist),
  );
  expect(first.status).toBe(201);
  createdIds.push(((await first.json()) as any).id);

  const second = await createUser(
    userRequest({ name: "Second", email, password: "a-strong-password", role: "staff" }),
    asAuthedUser(oncologist),
  );
  expect(second.status).toBe(409);
});

test("createUser rejects a short password", async () => {
  const res = await createUser(
    userRequest({ name: "Weak", email: "weak@opd.local", password: "short", role: "staff" }),
    asAuthedUser(oncologist),
  );
  expect(res.status).toBe(400);
});

test("createUser rejects an invalid role", async () => {
  const res = await createUser(
    userRequest({ name: "Bad Role", email: "badrole@opd.local", password: "a-strong-password", role: "admin" }),
    asAuthedUser(oncologist),
  );
  expect(res.status).toBe(400);
});
