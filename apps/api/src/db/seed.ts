import { sql } from "./client";

async function upsertUser(name: string, email: string, password: string, role: "staff" | "oncologist") {
  const password_hash = await Bun.password.hash(password);
  const rows = await sql`
    INSERT INTO users (name, email, password_hash, role)
    VALUES (${name}, ${email}, ${password_hash}, ${role})
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
    RETURNING id, name, email, role
  `;
  console.log("seeded user:", rows[0]);
}

await upsertUser("Dev Staff", "staff@opd.local", "staff-password", "staff");
await upsertUser("Dev Oncologist", "oncologist@opd.local", "onc-password", "oncologist");

console.log("Seed complete.");
process.exit(0);
