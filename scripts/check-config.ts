// Validates the environment the API and web app will run with, before they start (or on the server before a deploy):
//   bun scripts/check-config.ts           # local dev (reads .env from the current directory, as Bun does)
//   bun scripts/check-config.ts --prod    # also checks the production settings (DOMAIN, https origins, ...)
// Exits 1 when anything FAILS. Only variable names are printed, never values.
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { evaluateEnv, type Finding, type Mode } from "./checkConfig";

const mode: Mode = process.argv.includes("--prod") ? "prod" : "local";
const findings: Finding[] = evaluateEnv(process.env, mode);

// Reachability and migration state need the real database / disk.
if (process.env.DATABASE_URL) {
  const sql = new Bun.SQL(process.env.DATABASE_URL);
  try {
    await sql`SELECT 1`;
    findings.push({ level: "ok", message: "Database: reachable" });
    const [row] = await sql`
      SELECT to_regclass('visit_dictations') IS NOT NULL AS dictations,
             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'facts' AND column_name = 'check_state') AS spot_check,
             EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'visits' AND column_name = 'prep_status') AS prep`;
    const missing = Object.entries(row as Record<string, boolean>).filter(([, present]) => !present).map(([name]) => name);
    findings.push(
      missing.length
        ? { level: "fail", message: `Database: migrations missing for ${missing.join(", ")} (apply apps/api/src/db/migrations/*.sql in order)` }
        : { level: "ok", message: "Database: migrations through the latest are applied" },
    );
  } catch (err) {
    findings.push({ level: "fail", message: `Database: cannot connect (${err instanceof Error ? err.message : String(err)})` });
  } finally {
    await sql.close().catch(() => {});
  }
}

if ((process.env.OBJECT_STORAGE_DRIVER ?? "local") === "local") {
  const dir = process.env.OBJECT_STORAGE_LOCAL_PATH ?? "./apps/api/.data/documents";
  try {
    await mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.write-check-${process.pid}`);
    await Bun.write(probe, "ok");
    await unlink(probe);
    findings.push({ level: "ok", message: `Object storage: ${dir} is writable` });
  } catch {
    findings.push({ level: "fail", message: `Object storage: ${dir} is not writable` });
  }
}

if (mode === "local" && !existsSync(".env")) findings.push({ level: "warn", message: "No .env in the current directory (run from the repo root)" });

const icon = { ok: "PASS", warn: "WARN", fail: "FAIL" } as const;
for (const f of findings) console.log(`${icon[f.level]}  ${f.message}`);
const failed = findings.filter((f) => f.level === "fail").length;
const warned = findings.filter((f) => f.level === "warn").length;
console.log(`\n${mode} config: ${failed} failed, ${warned} warnings, ${findings.length - failed - warned} passed`);
process.exit(failed > 0 ? 1 : 0);
