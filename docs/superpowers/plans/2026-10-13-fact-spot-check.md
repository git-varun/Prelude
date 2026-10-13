# Fact Spot-Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff mark every extracted fact Correct or Incorrect against its source; an unchecked fact cannot be oncologist-signed-off, and the marks roll up into staff-checked agreement figures and exported eval answer keys.

**Architecture:** A separate `check_state` axis on `facts` (columns, not a new table, not a new `verification_state`). The correction logic of `PATCH /facts/:id` is extracted into a transaction-taking service so `POST /facts/:id/check` can correct and mark in one transaction. Excluded facts (`excluded_at`) drop out of every live read through `LIVE_FACT_FILTER` and out of every conflict-blocking query through one shared fragment.

**Tech Stack:** Bun, `Bun.sql` (Postgres 16), React 19 via Bun HTML imports, Playwright e2e, zod.

**Spec:** `docs/superpowers/specs/2026-10-13-fact-spot-check-design.md`

**Status:** final, reviewed 2026-10-13 (baseline verified: 401 API tests, 38 web unit tests, root `tsc` clean). Not yet executed.

## Test commands (used verbatim in every task)

`DATABASE_URL` lives in the repo-root `.env`; `bun test` run inside `apps/api` does **not** load it (42 spurious failures, "DATABASE_URL is not set"). Always run from `apps/api` with the env file:

- API suite: `cd apps/api && bun --env-file=../../.env test`
- One file: `cd apps/api && bun --env-file=../../.env test src/routes/facts.test.ts`
- Typecheck (from the repo root; the only tsconfig is the root one, clean at baseline): `bunx tsc --noEmit`
- Web: `bun test apps/web/src` (wording guard) and `bun run --cwd apps/web test:e2e`
- Local DB: container `prelude_postgres` (port 5434). Apply a migration by hand: `docker exec -i prelude_postgres psql -U prelude -d prelude_dev < apps/api/src/db/migrations/010_fact_spot_check.sql`

Baseline on 2026-10-13 with the env file: **401 pass, 0 fail**. Any task that ends red is not done.

## Spec corrections and decisions (read before Task 1)

The review of the spec found the points below. Each is resolved here as a stated default; flag any you disagree with before execution.

1. **Excluded facts keep their open conflicts (spec gap).** Conflicts are detected at upload, so a `not_in_document` / `wrong_patient` fact can already be one side of an `open` conflict. Filtering the fact out of reads does not touch the `conflicts` row, so the real fact on the other side would stay blocked from sign-off and keep counting in needs-attention. **Decision:** a conflict with an excluded fact on either side is ignored everywhere a conflict is read (blocking badge, sign-off block, needs-attention, snapshot other side, conflict screen, `detectConflicts` duplicate guard). The row is kept. One shared fragment, `CONFLICT_SIDES_LIVE`, is applied at each site (Task 3). Clearing an exclusion re-runs `detectConflicts` for that fact (Task 4), exactly as identity confirm does.
2. **PATCH on an excluded fact would silently un-exclude it** (the reset clears `error_type`, then the constraint forces `excluded_at` NULL). **Decision:** `PATCH /facts/:id` returns 409 for an excluded fact; the only way back is `POST /facts/:id/check` with a different mark.
3. **`schema.sql` is not updated (spec says it is).** `schema.sql` contains none of migrations 006-009 (no `identity_status`, no `imaging_modality`); the repo layers migrations on top of it in `docker-entrypoint-initdb.d`. Adding 010's `CREATE TYPE` to `schema.sql` would make migration 010 fail on a fresh database. **Decision:** migration file + both compose mounts only. Only the `audit_log.action` comment in `schema.sql` gains `'check_fact'`.
4. **Exported keys cannot measure recall.** A key built from checked facts contains only rows the extractor found; a row it missed never appears, so scoring against it inflates recall. **Decision:** exported keys carry `keyOrigin: "spot_check"`; the harness reports them under their own source `real_spot_check` and prints "recall not measurable (key contains only extracted rows)". They measure precision/value accuracy only. Excluded facts are left out; the printed label comes from the fact's `upload` audit row (`PATCH` nulls `raw_marker_label` on mapping).
5. **Held and rejected documents.** `POST /facts/:id/check` returns 409 for `identity_status IN ('mismatch','rejected')`, not only `mismatch`. `unchecked_fact_count` and the progress figures exclude facts of held/rejected documents and excluded facts, or the badge could never clear.
6. **Reset on every PATCH.** Per the spec any `PATCH` of a checked fact resets the mark (mapping a marker or saving a date after "Correct" un-checks it). **Decision:** keep the rule; the card shows "Changed since it was checked. Mark it again." so it is not silent.
7. **"Document list" badge.** There is no document-list endpoint. The only per-document listings are `Upload.tsx` ("Uploaded this session", built from upload responses) and the patient list. **Decision:** `unchecked_fact_count` goes on the patient list (`PatientList.tsx`); per-document figures come from `GET /documents/:id/check-summary` and the review screen. No new list endpoint.
8. **"Low confidence" ordering.** There is no stored confidence column (confidence only caps `coverage_status` to `extraction_uncertain`). The risk sort uses: `extraction_uncertain`, failed `parse_checks`, printed flag disagreement, out-of-range, unmapped marker, then page order.
9. **Test fixtures that break at the gate (Task 5):** `newFact` and sign-off cases in `routes/facts.test.ts`, `routes/conflicts.test.ts`, any patients test that signs off through the route, `db/seed.ts` (inserts signed-off rows directly, so it only needs `check_state`), and the e2e `fact()` stub in `apps/web/e2e/smoke.test.ts` (tests around lines 283-347).

## Global Constraints

- Default to Bun: `bun test`, `bun install`, `Bun.serve`, `bun:sqlite` rules from `CLAUDE.md`. No jest/vitest/vite/express.
- A wrong value is worse than a missing one: nothing is auto-corrected, silently dropped, or auto-marked Correct.
- `verification_state` matrix in Invariants §2 gains **no** new state; `check_state` is a separate axis.
- The UI label for the roll-up is **"staff-checked agreement"**, never "accuracy".
- UI copy must pass `apps/web/src/wordingGuard.test.ts` (no prohibited clinical-judgment terms).
- Real reports, answer keys and exports are PHI: `apps/api/eval/fixtures/` and `apps/api/eval/results/` stay gitignored; committed tests use synthetic data only.
- Every state-changing endpoint writes an `audit_log` row in the same transaction.
- Migration is applied by hand and mounted in **both** `infra/docker-compose.yml` and `infra/docker-compose.prod.yml` (the step missed once for 009).
- Lock order is always fact `FOR UPDATE`, then `documents ... FOR UPDATE`.
- Definition of done for web changes: `tsc --noEmit`, `bun test`, and `bun run --cwd apps/web test:e2e` all pass. First time on a machine: `bunx playwright install chromium`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Work on a feature branch (`feat/fact-spot-check`), not `main`.

## Review Focus

Inputs the spec implies but no happy-path test would exercise, most likely first. Each line is pinned by a test in the named task.

1. Excluding a fact that is one side of an open conflict: the other fact must become signable, leave needs-attention, and show no conflict badge. (Task 3, Task 5)
2. `PATCH` of an excluded fact must 409, not silently un-exclude. (Task 4)
3. Keyboard shortcuts `c` / `x` / arrows typed into the value input, marker select or date field must not mark or move cards. (Task 7)
4. Held (`mismatch`) and `rejected` document: check returns 409, and its facts are not counted as unchecked. (Task 4, Task 6)
5. Concurrent `POST /check` and `PATCH` on the same fact: exactly one order wins and the final state is consistent (never `check_state='correct'` with an older value). (Task 4)
6. A fully-unchecked document with zero facts, or a document whose only facts are excluded: progress reads sensibly and the "all checked" banner does not fire on zero facts. (Task 7)
7. Un-excluding a fact (changing `not_in_document` to `correct`) must re-run conflict detection and clear `excluded_at`. (Task 4)
8. Backfill: signed-off facts get `check_state='correct'` with `checked_by` NULL, and a re-run of the migration is not required to be idempotent but must not touch unsigned facts. (Task 2)
9. Export of a document whose facts include a mapped marker (`raw_marker_label` is NULL on the fact) and an excluded fact. (Task 8)

---

## File Structure

| File | Responsibility |
| --- | --- |
| `apps/api/src/services/corrections.ts` (new) | `parseCorrection`, `applyCorrection(tx, …)`: validation + row-lock + UPDATE + audit + conflict detection for a fact correction. No `sql.begin`. |
| `apps/api/src/services/factChecks.ts` (new) | `checkFact(tx, …)`: all check transitions, exclusion, un-exclusion; `resetCheck(tx, …)`; summary queries. |
| `apps/api/src/routes/facts.ts` (modify) | `patchFact` becomes a thin caller; new `checkFactRoute`; sign-off gate; `queryFacts` gains check fields. |
| `apps/api/src/routes/checks.ts` (new) | `getDocumentCheckSummary`, `getLabCheckSummary` (read-only roll-ups). |
| `apps/api/src/services/delta.ts` (modify) | `LIVE_FACT_FILTER` gains `excluded_at IS NULL`; new `CONFLICT_SIDES_LIVE` fragment. |
| `apps/api/src/db/migrations/010_fact_spot_check.sql` (new) | enums, columns, constraints, backfill. |
| `apps/api/eval/exportChecks.ts` (new), `eval/types.ts`, `eval/run.ts` (modify) | Key export; `spot_check` key origin. |
| `apps/web/src/components/FactCheck.tsx` (new) | Correct / Incorrect controls for one card. |
| `apps/web/src/lib/riskOrder.ts` (new) | Pure risk-ordering function (unit-testable without a browser). |
| `apps/web/src/components/FactCard.tsx`, `screens/ExtractionReview.tsx`, `screens/PatientList.tsx`, `api/client.ts` (modify) | Wire the UI. |

---

### Task 0: Baseline

**Files:** none.

- [ ] **Step 1: Branch**

```bash
git checkout -b feat/fact-spot-check
```

- [ ] **Step 2: Confirm the DB is up and 009 is applied**

Run: `docker exec prelude_postgres psql -U prelude -d prelude_dev -c "\d documents" | grep identity_status`
Expected: a line containing `identity_status`. If the container is down: `docker compose -f infra/docker-compose.yml up -d`, then apply 006-009 by hand per the Test commands section.

- [ ] **Step 3: Run the full API suite**

Run: `cd apps/api && bun --env-file=../../.env test`
Expected: `401 pass`, `0 fail`. If not, stop and fix the environment first; the refactor in Task 1 relies on this suite as its safety net.

- [ ] **Step 4: Run web checks**

Run: `bun test apps/web/src && bun run --cwd apps/web test:e2e`
Expected: all pass (record the counts in the task notes).

---

### Task 1: Extract the shared correction service (no behavior change)

**Files:**
- Create: `apps/api/src/services/corrections.ts`
- Create: `apps/api/src/services/corrections.test.ts`
- Modify: `apps/api/src/routes/facts.ts` (the `patchFact` body, lines ~65-190, and the `isRealDate` / `RESOLUTION_COVERAGE` helpers)
- Safety net (unchanged): `apps/api/src/routes/facts.test.ts`, `apps/api/src/routes/conflicts.test.ts`

**Interfaces:**
- Produces (used by Tasks 4):
  ```ts
  export interface Correction {
    value?: string; unit?: string; referenceRange?: string;
    trackedMarkerId?: string; asOfDate?: string; resolution?: Resolution;
  }
  export type Resolution = "value_found" | "no_usable_value" | "source_states_not_performed";
  export function parseCorrection(body: unknown): { ok: true; correction: Correction } | { ok: false; message: string };
  export type ApplyOutcome =
    | { outcome: "ok"; before: Record<string, any>; updated: Record<string, any> }
    | { outcome: "not_found" | "signed_off" | "not_uncertain" | "bad_marker" };
  export async function applyCorrection(tx: typeof sql, factId: string, c: Correction, userId: string): Promise<ApplyOutcome>;
  export const isUuid: (s: unknown) => s is string;
  ```
- Consumes: `detectConflicts(tx, fact)` from `services/rules`.
- `applyCorrection` runs **inside the caller's transaction** and takes the locks itself in order fact then document (re-locking a row the caller already locked is a no-op).

- [ ] **Step 1: Write the failing test for `parseCorrection`** (`corrections.test.ts`)

```ts
import { test, expect } from "bun:test";
import { parseCorrection } from "./corrections";

test("parseCorrection rejects an empty body", () => {
  expect(parseCorrection({})).toEqual({ ok: false, message: expect.stringContaining("at least one of") });
});
test("parseCorrection rejects coverage_status", () => {
  const r = parseCorrection({ coverage_status: "value_found", value: "1" });
  expect(r.ok).toBe(false);
});
test("parseCorrection maps snake_case body fields to the Correction shape", () => {
  const r = parseCorrection({ value: " 4.2 ", unit: "ng/mL", reference_range: "0-5", as_of_date: "2026-02-01" });
  expect(r).toEqual({ ok: true, correction: { value: "4.2", unit: "ng/mL", referenceRange: "0-5", asOfDate: "2026-02-01" } });
});
test("parseCorrection rejects an impossible calendar date and a blank value", () => {
  expect(parseCorrection({ as_of_date: "2026-02-30" }).ok).toBe(false);
  expect(parseCorrection({ value: "  " }).ok).toBe(false);
});
test("parseCorrection: value_found requires a value; other resolutions forbid one", () => {
  expect(parseCorrection({ resolution: "value_found" }).ok).toBe(false);
  expect(parseCorrection({ resolution: "no_usable_value", value: "1" }).ok).toBe(false);
  expect(parseCorrection({ resolution: "no_usable_value" }).ok).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun --env-file=../../.env test src/services/corrections.test.ts`
Expected: FAIL, "Cannot find module './corrections'".

- [ ] **Step 3: Create `services/corrections.ts`**

Move, without altering messages or logic, these pieces out of `routes/facts.ts`: `UUID`/`isUuid`, `ISO_DATE`/`isRealDate`, `RESOLUTION_COVERAGE`/`Resolution`/`isResolution`, the whole validation block of `patchFact` (becomes `parseCorrection`, returning the same error message strings), and the body of the `sql.begin` callback (becomes `applyCorrection`, minus the outer `sql.begin`). Skeleton:

```ts
import type { sql } from "../db/client";
import { detectConflicts } from "./rules";

type Tx = typeof sql;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
// ... isRealDate, RESOLUTION_COVERAGE, Resolution, isResolution moved verbatim ...

export function parseCorrection(body: unknown): { ok: true; correction: Correction } | { ok: false; message: string } {
  if (typeof body !== "object" || body === null) return { ok: false, message: "Expected a JSON object." };
  const b = body as Record<string, unknown>;
  // moved verbatim from patchFact: coverage_status guard, at-least-one-field guard, per-field validation,
  // resolution/value coupling. Each `return jsonError(400, "bad_request", msg)` becomes `return { ok: false, message: msg }`.
  // On success:
  const c: Correction = {};
  if (typeof b.value === "string") c.value = b.value.trim();
  if (typeof b.unit === "string") c.unit = b.unit.trim();
  if (typeof b.reference_range === "string") c.referenceRange = b.reference_range.trim();
  if (typeof b.tracked_marker_id === "string") c.trackedMarkerId = b.tracked_marker_id;
  if (typeof b.as_of_date === "string") c.asOfDate = b.as_of_date;
  if (isResolution(b.resolution)) c.resolution = b.resolution;
  return { ok: true, correction: c };
}

export async function applyCorrection(tx: Tx, factId: string, c: Correction, userId: string): Promise<ApplyOutcome> {
  const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
  if (!before) return { outcome: "not_found" };
  if (before.verification_state === "oncologist_signed_off") return { outcome: "signed_off" };
  // ... remainder of the old transaction body verbatim (not_uncertain, newCoverage, bad_marker,
  // documents FOR UPDATE, UPDATE facts ... RETURNING *, documents.needs_manual_date recompute,
  // audit_log 'correct' row, detectConflicts on undated->dated), using c.value / c.unit / c.referenceRange /
  // c.trackedMarkerId / c.asOfDate / c.resolution in place of the old locals.
  return { outcome: "ok", before, updated };
}
```

- [ ] **Step 4: Rewrite `patchFact` as a thin caller**

```ts
export async function patchFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");
  let body: unknown;
  try { body = await req.json(); } catch { return jsonError(400, "bad_request", "Malformed JSON body."); }
  const parsed = parseCorrection(body);
  if (!parsed.ok) return jsonError(400, "bad_request", parsed.message);

  const result = await sql.begin((tx) => applyCorrection(tx, factId, parsed.correction, user.id));
  if (result.outcome === "not_found") return jsonError(404, "not_found", "Fact not found.");
  if (result.outcome === "signed_off") return jsonError(409, "conflict", "This fact is oncologist signed-off; it must be reopened before it can be corrected.");
  if (result.outcome === "not_uncertain") return jsonError(409, "conflict", "resolution applies only to facts whose coverage_status is extraction_uncertain.");
  if (result.outcome === "bad_marker") return jsonError(400, "bad_request", "tracked_marker_id does not belong to this fact's patient.");
  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}
```

`routes/facts.ts` imports `isUuid` from the service; delete the local copy. `getDocumentFacts` keeps using it.

- [ ] **Step 5: Run the new tests and the safety net**

Run: `cd apps/api && bun --env-file=../../.env test src/services/corrections.test.ts src/routes/facts.test.ts src/routes/conflicts.test.ts`
Expected: all PASS with no edits to `facts.test.ts` / `conflicts.test.ts`.

- [ ] **Step 6: Full suite and typecheck**

Run: `cd apps/api && bun --env-file=../../.env test`, then from the repo root `bunx tsc --noEmit`
Expected: `401 + 5 pass`, 0 fail, tsc clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/corrections.ts apps/api/src/services/corrections.test.ts apps/api/src/routes/facts.ts
git commit -m "refactor: extract the fact correction into a transaction-taking service (no behavior change)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Migration 010 and compose mounts

**Files:**
- Create: `apps/api/src/db/migrations/010_fact_spot_check.sql`
- Create: `apps/api/src/db/migrations/010_fact_spot_check.test.ts`
- Modify: `infra/docker-compose.yml` (after line 26), `infra/docker-compose.prod.yml` (after line 39)
- Modify: `apps/api/src/db/schema.sql:112` (comment only)

**Interfaces:**
- Produces columns on `facts`: `check_state check_state NOT NULL DEFAULT 'unchecked'`, `checked_by uuid`, `checked_at timestamptz`, `error_type check_error_type`, `excluded_at timestamptz`.

- [ ] **Step 1: Write the failing DB test** (`010_fact_spot_check.test.ts`)

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../client";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../../test-helpers";

let staff: TestUser; let patientId: string; let docId: string; let visitId: string;
beforeAll(async () => {
  staff = await createTestUser("staff", "mig010");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: docId }] = await sql`INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
});
afterAll(async () => { await deleteTestPatients(patientId); await deleteTestUsers(staff.id); });

const insert = (extra: string) => sql.unsafe(`
  INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date, ${extra.split("|")[0]})
  VALUES ('${patientId}', '${visitId}', '${docId}', 'marker_value', '1', '2026-01-01', ${extra.split("|")[1]})`);

test("a new fact defaults to unchecked with no mark fields", async () => {
  const [f] = await sql`INSERT INTO facts (patient_id, visit_id, document_id, field_type, value, as_of_date)
    VALUES (${patientId}, ${visitId}, ${docId}, 'marker_value', '1', '2026-01-01') RETURNING *`;
  expect(f.check_state).toBe("unchecked");
  expect(f.error_type).toBeNull(); expect(f.excluded_at).toBeNull(); expect(f.checked_by).toBeNull();
});
test("incorrect requires an error_type; correct and unchecked forbid one", async () => {
  await expect(insert("check_state|'incorrect'")).rejects.toThrow();
  await expect(insert("check_state, error_type|'correct', 'value'")).rejects.toThrow();
  await expect(insert("check_state, error_type|'incorrect', 'value'")).resolves.toBeDefined();
});
test("excluded_at is set exactly when error_type is not_in_document or wrong_patient", async () => {
  await expect(insert("check_state, error_type|'incorrect', 'not_in_document'")).rejects.toThrow(); // no excluded_at
  await expect(insert("check_state, error_type, excluded_at|'incorrect', 'value', now()")).rejects.toThrow();
  await expect(insert("check_state, error_type, excluded_at|'incorrect', 'wrong_patient', now()")).resolves.toBeDefined();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && bun --env-file=../../.env test src/db/migrations/010_fact_spot_check.test.ts`
Expected: FAIL, column "check_state" does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- Fact spot-check (docs/superpowers/specs/2026-10-13-fact-spot-check-design.md): a per-fact "I checked this
-- against the source" mark, separate from verification_state. Applied by hand (psql -f) and mounted in both
-- compose files. NOT added to schema.sql (schema.sql predates 006-009; migrations layer on top of it).
CREATE TYPE check_state AS ENUM ('unchecked', 'correct', 'incorrect');
CREATE TYPE check_error_type AS ENUM ('value', 'unit', 'marker', 'date', 'range', 'not_in_document', 'wrong_patient');

ALTER TABLE facts
  ADD COLUMN check_state check_state NOT NULL DEFAULT 'unchecked',
  ADD COLUMN checked_by UUID REFERENCES users(id),
  ADD COLUMN checked_at TIMESTAMPTZ,
  ADD COLUMN error_type check_error_type,
  ADD COLUMN excluded_at TIMESTAMPTZ,
  ADD CONSTRAINT facts_error_type_matches_state CHECK (
    (check_state = 'incorrect' AND error_type IS NOT NULL) OR (check_state != 'incorrect' AND error_type IS NULL)
  ),
  ADD CONSTRAINT facts_excluded_matches_error_type CHECK (
    COALESCE(error_type IN ('not_in_document', 'wrong_patient'), false) = (excluded_at IS NOT NULL)
  );

-- Backfill: already-signed-off facts count as checked. checked_by stays NULL = "backfilled" (a user mark always sets it).
UPDATE facts SET check_state = 'correct', checked_at = signed_off_at WHERE verification_state = 'oncologist_signed_off';

-- Roll-ups and the unchecked badge scan by document.
CREATE INDEX facts_document_check_idx ON facts (document_id, check_state);
```

- [ ] **Step 4: Apply to the local DB and run the test**

Run: `docker exec -i prelude_postgres psql -U prelude -d prelude_dev < apps/api/src/db/migrations/010_fact_spot_check.sql`
Run: `cd apps/api && bun --env-file=../../.env test src/db/migrations/010_fact_spot_check.test.ts`
Expected: PASS.

- [ ] **Step 5: Backfill test**

Add to the same file: insert a signed-off fact **before** applying is impossible in the live DB, so assert the backfill SQL itself against a fixture: insert one `oncologist_signed_off` fact (needs `signed_off_by`) and one `unverified` fact, run the `UPDATE ... WHERE verification_state = 'oncologist_signed_off'` statement copied from the migration, and expect the first `check_state='correct'`, `checked_by` NULL, `checked_at = signed_off_at`, and the second still `unchecked`.

- [ ] **Step 6: Compose mounts and schema comment**

`infra/docker-compose.yml` and `infra/docker-compose.prod.yml`, directly after the 009 line:

```yaml
      - ../apps/api/src/db/migrations/010_fact_spot_check.sql:/docker-entrypoint-initdb.d/11-fact-spot-check.sql:ro
```

`schema.sql:112`: append `| 'check_fact'` to the action comment.

- [ ] **Step 7: Full suite, then commit**

Run: `cd apps/api && bun --env-file=../../.env test` Expected: all pass.

```bash
git add apps/api/src/db infra
git commit -m "db: migration 010 adds the per-fact spot-check columns, constraints and backfill

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Excluded facts leave every live read and every conflict read

**Files:**
- Modify: `apps/api/src/services/delta.ts:25-35`
- Modify the conflict queries: `routes/facts.ts` (`queryFacts` lines ~20-27, `signOffFact` ~213), `routes/patients.ts` (~159, ~342, ~380, ~416, ~466-469), `routes/conflicts.ts` (`factWithProvenance` ~8), `services/rules.ts` (~123)
- Test: `apps/api/src/services/excluded.test.ts` (new)

**Interfaces:**
- Produces: `LIVE_FACT_FILTER` now also requires `f.excluded_at IS NULL`.
- Produces: `export const CONFLICT_SIDES_LIVE = sql\`...\`` in `services/delta.ts`, a fragment meaning "neither fact of conflict `c` is excluded":
  ```ts
  export const CONFLICT_SIDES_LIVE = sql`
    NOT EXISTS (SELECT 1 FROM facts xf WHERE xf.id IN (c.fact_id_a, c.fact_id_b) AND xf.excluded_at IS NOT NULL)
  `;
  ```
  Every site that reads `conflicts c` to decide "blocking / open / shown" adds `AND ${CONFLICT_SIDES_LIVE}`.

- [ ] **Step 1: Write the failing tests** (`excluded.test.ts`)

Seed a patient with visit, document, tracked marker CEA, two dated facts `a` (value 4) and `b` (value 9) for CEA, and an `open` conflict between them (insert directly). Then set `b` excluded (`check_state='incorrect', error_type='not_in_document', excluded_at=now()`) and assert, one test per read:

1. snapshot (`getPatientSnapshot`) contains no field with `b`'s value and `a` has no conflict entries;
2. timeline and trend omit `b`;
3. `listVisits` `fact_count` counts only `a`;
4. `listPatients` `needs_attention_count` ignores `b` and does not count `a` as conflicted;
5. `queryFacts`/`GET /documents/:id/facts` for `a`: `has_blocking_conflict` is `false`;
6. `signOffFact` on `a` (oncologist, after marking `a` checked) succeeds rather than returning the conflict 409;
7. `GET /conflicts/:id` does not return a 500, and `factWithProvenance` marks the excluded side (see Step 4);
8. `detectConflicts` run for a new fact `c` with value 9 opens a conflict against `a` only (not against `b`).

Model the setup on `routes/patients.snapshot.test.ts` (`newFact` helper there) and call the route handlers directly as `facts.test.ts` does.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/api && bun --env-file=../../.env test src/services/excluded.test.ts`
Expected: FAIL (excluded fact still read, conflict still blocks).

- [ ] **Step 3: Edit `LIVE_FACT_FILTER` and add the fragment**

```ts
export const LIVE_FACT_FILTER = sql`
  f.excluded_at IS NULL
  AND NOT EXISTS ( ...existing resolved-conflict clause... )
  AND NOT EXISTS ( ...existing held-document clause... )
`;
```

Add `CONFLICT_SIDES_LIVE` below it (code above).

- [ ] **Step 4: Apply the fragment at each conflict site**

Search first so none is missed: `grep -n "FROM conflicts\|JOIN conflicts" apps/api/src/routes/*.ts apps/api/src/services/*.ts | grep -v test`. For each site that decides blocking/open/shown (not the `conflicts.ts` mutation routes that lock a conflict by id), add `AND ${CONFLICT_SIDES_LIVE}` to the `conflicts c` predicate:
- `routes/facts.ts` `queryFacts`: both the `has_blocking_conflict` EXISTS and the `blocking_conflict_id` subselect.
- `routes/facts.ts` `signOffFact`: the conflict lookup (alias the table `c`).
- `routes/patients.ts` needs-attention (~159), the three `has_blocking`/conflict EXISTS sites (~342, ~380, ~416), and `loadConflicts` (~466-469): add `AND ${CONFLICT_SIDES_LIVE}` inside both union halves, and keep the existing held-document WHERE.
- `services/rules.ts` (~123): the existing-conflict duplicate guard.
- `routes/conflicts.ts` `factWithProvenance`: leave the query unfiltered (the conflict screen may still be opened by id) but add the field `excluded: row.excluded_at !== null` to what it returns so the UI can label the side "Excluded". Do not hide the row.

- [ ] **Step 5: Run the new tests, then the full suite**

Run: `cd apps/api && bun --env-file=../../.env test`
Expected: all pass. Any existing snapshot/conflict test that fails here means a site was filtered incorrectly.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "safety: excluded facts leave every live read, and a conflict with an excluded side no longer blocks

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `POST /facts/:id/check`, PATCH reset, PATCH 409 on excluded

**Files:**
- Create: `apps/api/src/services/factChecks.ts`, `apps/api/src/services/factChecks.test.ts`
- Modify: `apps/api/src/routes/facts.ts` (add `checkFactRoute`; amend `patchFact`)
- Modify: `apps/api/src/index.ts` (route `/facts/:id/check`)
- Test: `apps/api/src/routes/facts.check.test.ts` (new; same setup as `facts.test.ts`)

**Interfaces:**
- Consumes: `applyCorrection`, `parseCorrection`, `Correction` (Task 1); `detectConflicts`.
- Produces:
  ```ts
  export type CheckErrorType = "value" | "unit" | "marker" | "date" | "range" | "not_in_document" | "wrong_patient";
  export type CheckInput =
    | { result: "correct" }
    | { result: "incorrect"; errorType: CheckErrorType; correction?: Correction };
  export function parseCheck(body: unknown): { ok: true; input: CheckInput } | { ok: false; message: string };
  export type CheckOutcome =
    | { outcome: "ok" }
    | { outcome: "not_found" | "signed_off" | "held" | "excluded_needs_check_change" | "needs_value" | "needs_date" | "bad_marker" | "not_uncertain" };
  export async function checkFact(tx: typeof sql, factId: string, input: CheckInput, userId: string): Promise<CheckOutcome>;
  export async function resetCheck(tx: typeof sql, factId: string, userId: string): Promise<boolean>; // true when a mark was cleared
  ```
- Endpoint: `POST /facts/:id/check` for `["staff","oncologist"]`. Body `{ "result": "correct" }` or `{ "result": "incorrect", "error_type": "...", "correction": {…PATCH fields} }`. Returns the fact as `queryFacts` does.

Rules `checkFact` enforces (all inside one transaction; lock fact then document):
1. 404 not found; 409 if `verification_state = 'oncologist_signed_off'`; 409 if the document's `identity_status IN ('mismatch','rejected')`.
2. `correct`: 409 `needs_value` when `value` is NULL or blank; 409 `needs_date` when `needs_manual_date`. Otherwise set `check_state='correct'`, `checked_by`, `checked_at=now()`, `error_type=NULL`, `excluded_at=NULL`.
3. `incorrect` with `value|unit|marker|date|range`: `correction` required, and it must contain the matching field (`value`→`value`, `unit`→`unit`, `marker`→`trackedMarkerId`, `date`→`asOfDate`, `range`→`referenceRange`), else 400. Run `applyCorrection`; map its non-ok outcomes straight through. Then set the mark fields. `excluded_at=NULL`.
4. `incorrect` with `not_in_document|wrong_patient`: a `correction` in the body is a 400. Set the mark fields plus `excluded_at=now()`.
5. If the previous state had `excluded_at` set and the new one does not, call `detectConflicts(tx, updatedFact)` (un-exclusion). (`detectConflicts` is a no-op for undated or unmapped facts.)
6. One `audit_log` row `action='check_fact'`, `entity_type='fact'`, `before_value`/`after_value` = the fact row before/after (when a correction ran, its own `correct` row is also written by `applyCorrection`).

`resetCheck`: `UPDATE facts SET check_state='unchecked', checked_by=NULL, checked_at=NULL, error_type=NULL WHERE id=$1 AND check_state != 'unchecked' RETURNING *`; when a row came back, write an `audit_log` row `check_fact` with before/after; return whether it reset. It must never be called on an excluded fact (PATCH 409s first).

`patchFact` amendment: inside one `sql.begin`, `SELECT ... FOR UPDATE` the fact; if `excluded_at IS NOT NULL` return `excluded` (route: 409 "This fact was marked as not belonging to this document; change its check mark before editing it."); else `applyCorrection`; on `ok` call `resetCheck`. The response fact carries the (now `unchecked`) fields.

- [ ] **Step 1: Write failing unit tests for `parseCheck`** (`factChecks.test.ts`)

```ts
import { test, expect } from "bun:test";
import { parseCheck } from "./factChecks";

test("parseCheck accepts correct with no other fields", () => {
  expect(parseCheck({ result: "correct" })).toEqual({ ok: true, input: { result: "correct" } });
});
test("parseCheck requires error_type for incorrect and rejects an unknown one", () => {
  expect(parseCheck({ result: "incorrect" }).ok).toBe(false);
  expect(parseCheck({ result: "incorrect", error_type: "typo" }).ok).toBe(false);
});
test("parseCheck requires the correction field matching the error type", () => {
  expect(parseCheck({ result: "incorrect", error_type: "value", correction: { unit: "mg" } }).ok).toBe(false);
  expect(parseCheck({ result: "incorrect", error_type: "value", correction: { value: "5" } }).ok).toBe(true);
  expect(parseCheck({ result: "incorrect", error_type: "date", correction: { as_of_date: "2026-03-01" } }).ok).toBe(true);
});
test("parseCheck forbids a correction for the two exclusion types", () => {
  expect(parseCheck({ result: "incorrect", error_type: "not_in_document", correction: { value: "1" } }).ok).toBe(false);
  expect(parseCheck({ result: "incorrect", error_type: "wrong_patient" }).ok).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**, then **implement `parseCheck`** (uses `parseCorrection` for the nested `correction`), re-run until PASS.

Run: `cd apps/api && bun --env-file=../../.env test src/services/factChecks.test.ts`

- [ ] **Step 3: Write failing route tests** (`facts.check.test.ts`)

Use the `facts.test.ts` scaffolding (staff/oncologist users, `newDocument`, `newFact`; add a `checkReq(id, body)` helper that builds `POST /facts/:id/check`). One test per line:

1. `correct` on a live valued dated fact → 200, row has `check_state='correct'`, `checked_by=staff.id`, `checked_at` set, one `check_fact` audit row with before/after.
2. `correct` on a fact with NULL value → 409; on a `needs_manual_date` fact → 409; on `oncologist_signed_off` → 409; document `identity_status='mismatch'` → 409; `'rejected'` → 409.
3. `incorrect`/`value` with `{ correction: { value: "5.0" } }` → value changes, `verification_state='staff_corrected'`, `check_state='incorrect'`, `error_type='value'`, and both a `correct` and a `check_fact` audit row exist; the mark is **not** reset by its own correction.
4. `incorrect`/`marker` mapping to another patient's marker → 400 and the mark is not written (transaction rolled back).
5. `incorrect`/`not_in_document` → `excluded_at` set; the fact is absent from `getPatientSnapshot` for that visit.
6. Change an excluded fact's mark to `correct` → `excluded_at` NULL, `error_type` NULL, and the fact is back in the snapshot.
7. **Un-exclusion re-runs conflict detection:** create fact `a` (CEA=4) and an excluded fact `b` (CEA=9, same marker, overlapping date); change `b` to `correct` → an `open` conflict between `a` and `b` exists.
8. **PATCH resets:** mark `correct`, then `PATCH {value:"4.3"}` → `check_state='unchecked'`, mark fields NULL, an audit row with the before/after.
9. **PATCH on an excluded fact → 409** and the row is unchanged (`excluded_at` still set).
10. A mark can be changed (`correct` → `incorrect` → `correct`) until sign-off; each change writes its own audit row.
11. **Concurrency:** fire `Promise.all([checkFactRoute(correct), patchFact({value:"9"})])` on 20 fresh facts (value "4.2"). Both lock the fact row first, so only two orders exist: check then PATCH (final `unchecked`, value "9") or PATCH then check (final `correct`, value "9"). Assert for every fact: no call threw, final `value === "9"`, and `check_state === "correct"` never coexists with `value === "4.2"`.
12. Role: unauthenticated/forbidden is handled by `requireRole` (no test needed beyond the route table entry in Step 6).

- [ ] **Step 4: Run to verify they fail**

Run: `cd apps/api && bun --env-file=../../.env test src/routes/facts.check.test.ts`
Expected: FAIL (route not defined).

- [ ] **Step 5: Implement `checkFact`, `resetCheck`, `checkFactRoute`; amend `patchFact`** per the rules above. `checkFactRoute` mirrors `patchFact`'s structure (uuid guard, JSON parse, `parseCheck`, `sql.begin`, outcome → status map: `not_found` 404, `signed_off|held|excluded…|needs_value|needs_date|not_uncertain` 409 with a specific message each, `bad_marker` 400).

- [ ] **Step 6: Route entry** in `index.ts`:

```ts
    "/facts/:id/check": cors({
      POST: requireRole(["staff", "oncologist"], checkFactRoute),
    }),
```

(and add `checkFactRoute` to the import from `./routes/facts`).

- [ ] **Step 7: Run the new tests, the full suite, and tsc**

Run: `cd apps/api && bun --env-file=../../.env test`, then from the repo root `bunx tsc --noEmit`
Expected: all pass. The existing `PATCH` tests still pass (an unchecked fact's reset is a no-op).

- [ ] **Step 8: Commit**

```bash
git add apps/api/src
git commit -m "feat: POST /facts/:id/check, PATCH resets a mark, PATCH of an excluded fact is a 409

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The sign-off gate and the fixtures it breaks

**Files:**
- Modify: `apps/api/src/routes/facts.ts` (`signOffFact`)
- Modify tests: `routes/facts.test.ts` (`newFact`), `routes/conflicts.test.ts` (sign-off calls ~192), any patients test that signs off through `signOffFact` (`grep -rn "signOffFact\|sign-off" apps/api/src --include='*.test.ts'`)
- Modify: `apps/api/src/db/seed.ts` (signed-off inserts at ~101-110)
- Test: `routes/facts.test.ts` (new cases)

**Interfaces:**
- Produces: `POST /facts/:id/sign-off` returns 409 `"This fact has not been checked against its source. Mark it Correct or Incorrect first."` unless `check_state IN ('correct','incorrect')` and `excluded_at IS NULL`. Excluded → 409 `"This fact was excluded from this document and cannot be signed off."`.
- Gate order in `signOffFact`: already-signed-off, undated, unmapped, conflict, **then** check (so a fact that is blocked for another reason reports that reason first, matching the UI precedence in Task 7).

- [ ] **Step 1: Write the failing tests** in `facts.test.ts`:

```ts
test("sign-off is a 409 while the fact is unchecked", async () => {
  const id = await newFact(await newDocument(), { markerId: ceaMarkerId });
  const res = await signOffFact(signReq(id), asAuthedUser(oncologist));
  expect(res.status).toBe(409);
  expect(((await res.json()) as any).message).toContain("not been checked");
});
test("sign-off succeeds once the fact is checked correct or incorrect", async () => {
  for (const state of ["correct", "incorrect"]) {
    const id = await newFact(await newDocument(), { markerId: ceaMarkerId, check: state });
    expect((await signOffFact(signReq(id), asAuthedUser(oncologist))).status).toBe(200);
  }
});
test("sign-off is a 409 for an excluded fact even though its check_state is incorrect", async () => {
  const id = await newFact(await newDocument(), { markerId: ceaMarkerId, check: "excluded" });
  expect((await signOffFact(signReq(id), asAuthedUser(oncologist))).status).toBe(409);
});
test("a conflict reason is reported before the unchecked reason", async () => { /* unchecked + open conflict → message mentions conflict */ });
```

Extend `newFact` with an option `check?: "unchecked" | "correct" | "incorrect" | "excluded"` (default `"correct"` so existing sign-off tests stay green; `"excluded"` writes `check_state='incorrect', error_type='not_in_document', excluded_at=now()`). Add `signReq` if it does not exist (same shape as `patchReq`, `POST`).

- [ ] **Step 2: Run to verify the new tests fail**, implement the gate in `signOffFact`:

```ts
    if (before.excluded_at !== null) return "excluded" as const;
    if (before.check_state === "unchecked") return "unchecked" as const;
```

placed after the conflict check; map outcomes to the two 409 messages above.

- [ ] **Step 3: Repair the other fixtures**

- `conflicts.test.ts`: where it inserts facts it later signs off through the route, add `check_state` `'correct'` to the INSERT (column list + value). 
- Any patients test that signs off via the route: same.
- `seed.ts`: add `check_state, checked_at` (`'correct', now()`) to the two signed-off inserts so demo data is internally consistent (the seed bypasses the route).

- [ ] **Step 4: Run the full suite**

Run: `cd apps/api && bun --env-file=../../.env test`, then from the repo root `bunx tsc --noEmit`
Expected: all pass. A red test here is a missed fixture, not a reason to loosen the gate.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat: oncologist sign-off requires a spot-check mark and a non-excluded fact

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Reads and the measurement roll-ups

**Files:**
- Modify: `apps/api/src/routes/facts.ts` (`queryFacts` select list, `getDocumentFacts`)
- Modify: `apps/api/src/routes/patients.ts` (`listPatients` subquery)
- Create: `apps/api/src/routes/checks.ts`, `apps/api/src/routes/checks.test.ts`
- Modify: `apps/api/src/index.ts`
- Modify tests: `routes/facts.test.ts` (GET cases), `routes/patients.test.ts` (list)

**Interfaces:**
- `queryFacts` additionally selects: `f.check_state, f.checked_by, f.checked_at, f.error_type, f.excluded_at, f.printed_flag, f.parse_checks`.
- `GET /documents/:id/facts` response gains `check_summary: { total, correct, incorrect, unchecked }`. Counts cover every fact of the document; excluded facts count toward `incorrect`.
- `listPatients` rows gain `unchecked_fact_count: number`: facts in the patient's **current visit**, `check_state='unchecked'`, `excluded_at IS NULL`, document not held/rejected (reuse `LIVE_FACT_FILTER`; same scoping as `needs_attention_count`).
- `GET /documents/:id/check-summary` (staff, oncologist):
  ```ts
  { document_id, lab_name: string | null, total, checked, correct, incorrect, unchecked,
    agreement: number | null,                    // correct / checked, null when checked = 0
    errors_by_type: Record<CheckErrorType, number>,
    checked_by: Array<{ user_id: string; name: string; count: number }> }
  ```
- `GET /checks/by-lab` (staff, oncologist): `Array<{ lab_name: string; documents: number; checked: number; correct: number; incorrect: number; agreement: number | null; errors_by_type: … }>`; a NULL `documents.lab_name` groups as `"unknown"`. Backfilled marks (`checked_by IS NULL`) are listed under `checked_by` as `{ user_id: null, name: "backfilled" }` and are **excluded** from `agreement` (they were not spot-checked).

- [ ] **Step 1: Write failing tests**

`facts.test.ts`: GET returns the check fields on each fact and `check_summary` for a doc with 1 correct, 1 incorrect-excluded, 2 unchecked → `{ total: 4, correct: 1, incorrect: 1, unchecked: 2 }`; `parse_checks` and `printed_flag` are present.
`patients.test.ts`: `unchecked_fact_count` is the number of unchecked live facts on the latest visit; excludes an excluded fact and a fact of a `mismatch` document; reaches 0 once all are marked.
`checks.test.ts`: per-document summary values (agreement 2/3 for 2 correct + 1 incorrect; null with none checked; backfilled rows excluded from `agreement` and shown as "backfilled"); by-lab grouping including the `"unknown"` bucket; `errors_by_type` counts.

- [ ] **Step 2: Run to verify they fail**, implement, re-run.

Implementation notes: `agreement = correct / (correct + incorrect)` over rows with `checked_by IS NOT NULL`. Use `COUNT(*) FILTER (WHERE …)`. Keep `check-summary` SQL in `checks.ts`; `getDocumentFacts` computes `check_summary` from the facts it already loaded (no extra query).

- [ ] **Step 3: Routes** in `index.ts`:

```ts
    "/documents/:id/check-summary": cors({ GET: requireRole(["staff", "oncologist"], getDocumentCheckSummary) }),
    "/checks/by-lab": cors({ GET: requireRole(["staff", "oncologist"], getLabCheckSummary) }),
```

- [ ] **Step 4: Full suite, tsc, commit**

Run: `cd apps/api && bun --env-file=../../.env test`, then from the repo root `bunx tsc --noEmit`

```bash
git add apps/api/src
git commit -m "feat: check fields and summary on fact reads, unchecked count on the patient list, per-document and per-lab roll-ups

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Review-screen UI

**Files:**
- Create: `apps/web/src/lib/riskOrder.ts`, `apps/web/src/lib/riskOrder.test.ts`
- Create: `apps/web/src/components/FactCheck.tsx`
- Modify: `apps/web/src/api/client.ts` (`ReviewFact`, `DocumentReview`, `PatientSummary`, new `checkFact`, `getDocumentCheckSummary`)
- Modify: `apps/web/src/components/FactCard.tsx`, `apps/web/src/screens/ExtractionReview.tsx`, `apps/web/src/screens/PatientList.tsx`
- Modify: `apps/web/e2e/smoke.test.ts` (the `fact()` stub and new tests)

**Interfaces:**
- `client.ts`:
  ```ts
  export type CheckState = "unchecked" | "correct" | "incorrect";
  export type CheckErrorType = "value" | "unit" | "marker" | "date" | "range" | "not_in_document" | "wrong_patient";
  // ReviewFact gains: check_state: CheckState; checked_by: string | null; checked_at: string | null;
  //   error_type: CheckErrorType | null; excluded_at: string | null; printed_flag: string | null;
  //   parse_checks: { failed?: string[] } | null;
  // DocumentReview gains: check_summary: { total: number; correct: number; incorrect: number; unchecked: number }
  // patient list item gains: unchecked_fact_count: number
  checkFact: (factId: string, body:
      | { result: "correct" }
      | { result: "incorrect"; error_type: CheckErrorType; correction?: { value?: string; unit?: string; reference_range?: string; tracked_marker_id?: string; as_of_date?: string } }) =>
    request<ReviewFact>(`/facts/${factId}/check`, { method: "POST", body: JSON.stringify(body) }),
  ```
- `riskOrder.ts`: `export function riskRank(f: ReviewFact): number` (lower = review first) and `export function sortByRisk(facts: ReviewFact[]): ReviewFact[]` (stable; ties by `source_page` then id). Rank: `0` extraction_uncertain, `1` failed parse check (`parse_checks?.failed?.length`), `2` printed flag present and `flagForRange` disagrees, `3` out of range (`flagForRange(value, reference_range) !== null`), `4` unmapped marker (`field_type === "marker_value" && !tracked_marker_id`), `5` everything else. Already-checked facts sort after unchecked ones regardless of rank.
- `FactCheck` props: `{ fact: ReviewFact; trackedMarkers: TrackedMarker[]; onChanged: () => void; active: boolean }`. Renders, for staff and oncologist, **Correct** and **Incorrect** buttons, the current mark ("Checked correct" / "Marked incorrect: value"), and disabled with a reason when the fact is signed off ("Reopen to change the check"). Incorrect opens the correction form (existing value/unit/range/marker/date inputs reused from `FactCard`) plus a required "What was wrong" `<select>` (Value, Unit, Marker, Date, Reference range, Not in the document, Wrong patient). The last two skip the form and show an inline confirm: "This fact will be excluded from every view. Continue?" with Confirm / Cancel.
- Copy for a reset mark: when `check_state === "unchecked"` and `verification_state === "staff_corrected"`: "Changed since it was checked. Mark it again."
- Sign-off blocked reason (in `FactCard`), appended **after** the existing three so their precedence is unchanged: `fact.check_state === "unchecked" ? "Check this fact against the source first" : fact.excluded_at ? "Excluded from this document" : null`.
- `ExtractionReview`: facts rendered via `sortByRisk`; header line `"{checked} of {total} checked"` (`checked = correct + incorrect` from `check_summary`); banner "All facts checked." only when `total > 0 && unchecked === 0`; the existing `FactCard` gets the new controls. Keyboard handler on `window` `keydown`: `c` correct, `x` open Incorrect, `ArrowDown`/`ArrowUp` move the active card; ignored when `event.target` is an `input`, `textarea`, `select`, or contenteditable, when a modifier key is held, or when the incorrect form is open.
- `PatientList`: next to the existing "need review" tag, `unchecked_fact_count > 0` shows `"{n} to check"`.

- [ ] **Step 1: Write the failing unit test for `riskOrder`** (`riskOrder.test.ts`): a table of seven facts covering each rank plus a checked fact; assert `sortByRisk(...).map(f => f.id)` equals the expected order, that equal ranks keep `source_page` order, and that checked facts come last.

- [ ] **Step 2: Run to verify it fails, implement `riskOrder.ts`, re-run to PASS**

Run: `bun test apps/web/src/lib/riskOrder.test.ts`

- [ ] **Step 3: Update the e2e stub first** (`smoke.test.ts` `fact()` and the facts-response in `openReviewAs`): add `check_state: state.check_state ?? "correct"`, `checked_by: null`, `checked_at: null`, `error_type: null`, `excluded_at: null`, `printed_flag: null`, `parse_checks: null`, and `check_summary: { total: 1, correct: 1, incorrect: 0, unchecked: 0 }` to the document response; extend `StubFact` with `check_state?: string`. Run `bun run --cwd apps/web test:e2e` and confirm the existing tests (lines ~283-347) still pass **before** any component change; this proves the stub, not the UI, was the only fixture change.

- [ ] **Step 4: Write the failing e2e tests** (new, in `smoke.test.ts`, using `openReviewAs`-style stubs with a POST handler for `/facts/f1/check` that records the body and flips `state.check_state`):

1. unchecked staff fact shows **Correct** / **Incorrect**; clicking Correct POSTs `{result:"correct"}` and the card shows "Checked correct" and the progress text becomes "1 of 1 checked".
2. Incorrect requires a "What was wrong" choice before the submit button enables; choosing Value + new value POSTs `{result:"incorrect", error_type:"value", correction:{value:"5.0"}}`.
3. Not in the document shows the exclusion confirmation, POSTs nothing until Confirm, then POSTs `{result:"incorrect", error_type:"not_in_document"}`.
4. Oncologist, unchecked, otherwise unblocked: Sign off is disabled with "Check this fact against the source first"; with a conflict, the conflict reason is shown instead (precedence).
5. **Keyboard:** with focus on the page body, `c` POSTs correct for the active card; with focus **inside the value input or the marker select**, typing `c` / `x` POSTs nothing and changes no card; arrow keys move the active card (`aria-current`).
6. **Zero facts / all excluded:** a document with `check_summary.total = 0` shows no "All facts checked." banner.
7. Console-error check: every new test asserts `errors` is empty (as the existing tests do).
8. Patient list shows "2 to check" for `unchecked_fact_count: 2` and nothing for 0.

- [ ] **Step 5: Run to verify they fail**, then implement `FactCheck.tsx` and the `FactCard` / `ExtractionReview` / `PatientList` / `client.ts` changes above.

- [ ] **Step 6: Wording guard and typecheck**

Run: `bun test apps/web/src` and `bunx tsc --noEmit`
Expected: pass. If the guard flags a word, reword the copy (do not edit the guard).

- [ ] **Step 7: Full web check**

Run: `bun run --cwd apps/web test:e2e`
Expected: all pass, no console errors.

- [ ] **Step 8: Commit**

```bash
git add apps/web
git commit -m "feat: spot-check controls, risk-ordered review list, progress, and keyboard shortcuts on the extraction review screen

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Export spot-checked documents as eval answer keys

**Files:**
- Create: `apps/api/eval/exportChecks.ts`, `apps/api/eval/exportChecks.test.ts`
- Modify: `apps/api/eval/types.ts` (`keyOrigin`), `apps/api/eval/run.ts:53`, `package.json` (script)

**Interfaces:**
- `types.ts`: `keyOrigin: z.enum(["hand", "scripted", "spot_check"]).default("hand")`.
- `run.ts`: `const source = expected.keyOrigin === "scripted" ? "real_scripted" : expected.keyOrigin === "spot_check" ? "real_spot_check" : expected.source;`. The run summary prints, for `real_spot_check`, "recall not measurable: the key contains only rows the extractor found". (Find the summary print site with `grep -n "real_scripted" apps/api/eval/*.ts`; the label table must accept the new source or `scoreDoc`'s typing will fail.)
- `exportChecks.ts`: `export async function buildExpectedDoc(documentId: string): Promise<ExpectedDoc | { skipped: string }>` and a `main()` that exports every document whose live facts are all checked, writing `apps/api/eval/fixtures/<slug>.expected.json`.
  - Eligible: document not held/rejected; at least one non-excluded fact; every fact `check_state != 'unchecked'`.
  - Per non-excluded fact: `fieldType`, `markerLabel` = the **upload audit row's** `after_value.raw_marker_label` if present, else the tracked marker name (a mapped marker has NULL `raw_marker_label` on the fact), `canonicalMarker` = tracked marker name or null, `value`/`unit`/`referenceRange`/`asOfDate` = the **current** (corrected) values, `sourcePage`.
  - Excluded facts are omitted.
  - `source: "real"`, `keyOrigin: "spot_check"`, `documentType` from the document, `header` from `lab_name`/`collected_on`/`patient_name_on_report`/`lab_patient_ref` when present.
  - Slug: if `documents.file_sha256` equals the SHA-256 of a file in `docs/reports/`, use `slugFor(thatFilename)` so the key pairs with its OCR fixture; otherwise `spotcheck-<first 8 chars of document id>`. There is no original-filename column.
  - Output is PHI: the file lands in the gitignored `eval/fixtures/`. The script prints counts only, never values.
- `package.json`: `"eval:export-checks": "bun apps/api/eval/exportChecks.ts"`.

- [ ] **Step 1: Write the failing test** (`exportChecks.test.ts`, synthetic data only): build a document with three facts: (a) mapped marker, corrected value (audit `upload` row carries `raw_marker_label: "Carcino Emb Ag"`, current value "5.0", marked incorrect/value), (b) plain correct fact, (c) excluded `not_in_document` fact. Assert `buildExpectedDoc` returns a doc that `ExpectedDocSchema.parse`s, has exactly two facts, uses the corrected value for (a), `markerLabel === "Carcino Emb Ag"`, `keyOrigin === "spot_check"`; a document with one unchecked fact returns `{ skipped }`; a document with only excluded facts returns `{ skipped }`.

- [ ] **Step 2: Run to verify it fails**, implement, re-run to PASS.

Run: `cd apps/api && bun --env-file=../../.env test eval/exportChecks.test.ts`

- [ ] **Step 3: Harness regression**

Run: `cd apps/api && bun --env-file=../../.env test eval/` and `EVAL_PROVIDER=deterministic bun --env-file=../../.env eval/run.ts` from the repo root (`bun run eval:extraction`).
Expected: existing eval tests pass; the deterministic run's numbers on the existing fixtures are unchanged.

- [ ] **Step 4: Commit**

```bash
git add apps/api/eval package.json
git commit -m "eval: export spot-checked documents as answer keys (recall not measurable, origin spot_check)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs and final verification

**Files:**
- Modify: `docs/03-implementation-invariants.md` (§2), `docs/extraction-pipeline-status.md`, `docs/m3-backlog.md`, `docs/superpowers/specs/2026-10-13-fact-spot-check-design.md` (status + the corrections above), `README.md` (one line under the eval section)
- Modify: the Decisions Log artifact entry (see Step 2)

- [ ] **Step 1: Invariants §2 paragraph.** Add after the "Cross-cutting rule" bullet: *"Second cross-cutting rule: a fact cannot be oncologist_signed_off until it has been spot-checked (`check_state` is `correct` or `incorrect`) and it is not excluded (`excluded_at IS NULL`). `check_state` is a separate axis from `verification_state`; it adds no state to this matrix. Any PATCH of a checked fact resets it to `unchecked`; PATCH of an excluded fact is a 409."* Also add to the Conflict section: *"A conflict with an excluded fact on either side is ignored for blocking and display; clearing the exclusion re-runs detection."*

- [ ] **Step 2: Decisions Log.** The Decisions Log is an artifact (`https://claude.ai/code/artifact/aeadec59-b7b6-4c12-ba6c-d843652a9ca5`), not a file in the repo. Use the Artifact tool's `read` action on it, add an "Extraction pipeline" entry covering: spot-check is both gate and measure; the label is "staff-checked agreement"; exported keys are `spot_check` and cannot measure recall; excluded facts keep their conflicts rows but are ignored. **Ask the user before republishing it** (it is a shared document).

- [ ] **Step 3: Status docs.** `extraction-pipeline-status.md`: add a "Fact spot-check" subsection under Work done and the deploy note below. `m3-backlog.md`: add the item with its deployment status. Update the spec's status line from "awaiting review" to "implemented (not deployed)" and fold in the eight corrections from the top of this plan.

- [ ] **Step 4: Deploy note (docs only; nothing is deployed from here).** Migration 010 must be applied on the production database **before** the new API code starts, because `queryFacts` selects the new columns and `signOffFact` reads `check_state`: `docker exec -i <postgres> psql -U prelude -d prelude_prod < apps/api/src/db/migrations/010_fact_spot_check.sql`. After deploy, every existing unsigned fact is `unchecked` and shows up in the "to check" badge.

- [ ] **Step 5: Final verification (all must pass, in this order)**

```bash
cd apps/api && bun --env-file=../../.env test        # expect: 0 fail
cd ../.. && bunx tsc --noEmit                         # expect: no output
bun test apps/web/src                                 # wording guard + unit
bun run --cwd apps/web test:e2e                       # expect: 0 fail, no console errors
```

- [ ] **Step 6: Commit and hand off**

```bash
git add docs README.md
git commit -m "docs: fact spot-check (invariants, status, backlog, spec corrections)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Then use superpowers:finishing-a-development-branch.

---

## Self-Review

**Spec coverage.** §3 data → Task 2 (backfill, both constraints, compose mounts; `schema.sql` deviation decided in point 3). §4 shared service → Task 1; `POST /check` and every listed 409, audit rows, PATCH reset → Task 4; reads, `check_summary`, `unchecked_fact_count` → Task 6; `LIVE_FACT_FILTER` and its reads → Task 3; gate → Task 5; measurement endpoints → Task 6, `eval:export-checks` → Task 8. §5 UI (risk order, source link already in `FactCard`, two buttons, required error type, exclusion confirm, progress, banner, badge, keyboard, wording guard) → Task 7. §8 testing: every transition, PATCH reset, sign-off gate, audit rows, backfill, concurrency, and excluded-from-every-read are in Tasks 2-5; the service refactor keeps existing tests green in Task 1; Playwright in Task 7; export round-trip in Task 8. §9 order of work matches. Gaps found in review (points 1-9 at the top) each have an owning task.

**Placeholder scan.** No "TBD"/"similar to". Two steps point at an existing search rather than listing lines (`grep -n "FROM conflicts…"` in Task 3 Step 4, the `scoreDoc` label site in Task 8) because the line numbers shift as earlier tasks land; each gives the exact command. Task 4 test 11 (concurrency) states the invariant to assert.

**Type consistency.** `Correction` uses camelCase (`referenceRange`, `trackedMarkerId`, `asOfDate`) inside the API and snake_case on the wire; `parseCorrection` and `parseCheck` are the only converters. `CheckErrorType` is defined once in `factChecks.ts` and mirrored in `client.ts`. `ApplyOutcome` / `CheckOutcome` names are used identically in Tasks 1 and 4. The `CONFLICT_SIDES_LIVE` fragment requires the alias `c` at every use (stated in Task 3).
