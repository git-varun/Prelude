# Extraction Review Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff review a document's extracted facts, correct values, map unmapped markers, and supply missing as-of dates, in a new Extraction Review screen backed by two new API endpoints.

**Architecture:** Two new endpoints in a new `apps/api/src/routes/facts.ts`: `GET /documents/:id/facts` (document + facts + the patient's tracked markers) and `PATCH /facts/:id` (value / tracked_marker_id / as_of_date correction, one transaction, audit-logged). The web app gets a hash route `/documents/:id/review`, a screen `ExtractionReview.tsx`, and a `FactCard.tsx` component, following the existing fetch-wrapper + `useState` conventions.

**Tech Stack:** Bun (`Bun.serve`, `bun:test`, built-in `SQL`), Postgres 16, React 19, TypeScript.

**Spec:** `docs/m2-backlog.md` section "Design decisions captured, not yet implemented" (revised 2026-09-24). State rules: `docs/03-implementation-invariants.md` §1 (coverage transitions) and §2 (verification transitions). Schema: `docs/02-implementation-blueprint.md` DDL + `apps/api/src/db/migrations/003_undated_facts_and_extraction_status.sql`.

## Global Constraints

- Bun only: `bun test`, `bun install`, `bun run`. No express, no `pg`, no jest/vitest (CLAUDE.md).
- Use `sql` from `apps/api/src/db/client.ts` (Bun's built-in `SQL`). Transactions: `sql.begin(async (tx) => ...)`, using `tx` for every query inside.
- Bun's `SQL` returns `jsonb` columns as raw JSON **strings** — `JSON.parse` before asserting on `audit_log.after_value`/`before_value`.
- A bare `sql\`...\`` is a lazy thenable: in tests, wrap in an `async` function before `expect(...).rejects`.
- Route handlers are plain functions typed `Request & { params: { id: string } }`, registered in `apps/api/src/index.ts` inside `cors({...})`, wrapped with `requireRole(["staff", "oncologist"], handler)`. Unit tests call handlers directly with `asAuthedUser(user)` (no HTTP).
- `PATCH /facts/:id` on an `oncologist_signed_off` fact returns **409** (Invariants §2 — it overrides the Blueprint M3 line that says 403).
- Correction never sets `oncologist_signed_off`, never touches `signed_off_*`, never sets `conflicting_sources`.
- Never fabricate data: `source_snippet` null renders "Source detail unavailable".
- Dates cross the API as `YYYY-MM-DD` strings (use `to_char`), never JS `Date` JSON.
- Run all tests and `bunx tsc --noEmit -p tsconfig.json` from the **repo root** (Bun loads `.env` from cwd only).
- Dev DB: `docker start opd_postgres` if stopped; migration 003 is already applied to it.

## File Structure

- Modify `packages/shared/src/index.ts` — `Fact` and `Document` types gain the new columns.
- Create `apps/api/src/routes/facts.ts` — `getDocumentFacts`, `patchFact`.
- Create `apps/api/src/routes/facts.test.ts` — tests for both.
- Modify `apps/api/src/index.ts` — register the two routes.
- Modify `apps/web/src/api/client.ts` — types + `getDocumentFacts`, `patchFact`; `DocumentRecord` gains fields.
- Create `apps/web/src/components/FactCard.tsx` — one fact: raw text vs structured value, status, correction, marker mapping, date entry.
- Create `apps/web/src/screens/ExtractionReview.tsx` — loads the document, gating and list.
- Modify `apps/web/src/router.ts`, `apps/web/src/App.tsx` — route.
- Modify `apps/web/src/screens/Upload.tsx` — "Review extraction" link on uploaded documents.

## Design details fixed by this plan (flag if you disagree)

1. **Confirming a value:** saving the value field unchanged still counts as a correction (sets `staff_corrected`, flips `extraction_uncertain` → `value_found`). That is how staff confirm an extraction as-is. Marker mapping alone does **not** change `coverage_status`.
2. **Gating:** if *every* fact of the document needs a date (the whole-document gap), the screen shows only one date form ("apply to all facts") until it is submitted. If only some facts are undated, each shows its own date input inline and the rest of the review is usable.
3. **Bulk date:** the "apply to all" form issues one `PATCH` per fact, sequentially; if one fails, the error is shown and the reload reflects what succeeded.
4. **Sign-off is out of scope.** Undated facts stay unsignable via the DB constraint; nothing here signs off.

---

### Task 1: Shared and client types

**Files:**
- Modify: `packages/shared/src/index.ts` (the `Document` and `Fact` interfaces)
- Modify: `apps/web/src/api/client.ts` (`DocumentRecord`)

**Interfaces:**
- Produces: `Document.needs_manual_date: boolean`, `Document.extraction_status: ExtractionStatus`, `Fact.as_of_date: string | null`, `Fact.needs_manual_date: boolean`, `Fact.raw_marker_label: string | null`, exported `ExtractionStatus` type.

- [ ] **Step 1: Edit the shared types**

In `packages/shared/src/index.ts`, add next to the other status types (near `OcrStatus`):

```ts
export type ExtractionStatus = "pending" | "done" | "failed";
```

In `interface Document`, after `ocr_text_ref: string | null;` add:

```ts
  needs_manual_date: boolean;
  extraction_status: ExtractionStatus;
```

In `interface Fact`, replace `as_of_date: string;` with:

```ts
  as_of_date: string | null;
  needs_manual_date: boolean;
  raw_marker_label: string | null;
```

- [ ] **Step 2: Update the web `DocumentRecord`**

In `apps/web/src/api/client.ts`, in `interface DocumentRecord` after `ocr_text_ref: string | null;` add:

```ts
  needs_manual_date: boolean;
  extraction_status: "pending" | "done" | "failed";
```

- [ ] **Step 3: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json`
Expected: no errors. If anything else in the repo read `Fact.as_of_date` as non-null, fix that call site to handle `null` (a grep earlier found no web usages).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts apps/web/src/api/client.ts
git commit -m "shared: nullable Fact.as_of_date, needs_manual_date/extraction_status fields"
```

---

### Task 2: `GET /documents/:id/facts`

**Files:**
- Create: `apps/api/src/routes/facts.ts`
- Create: `apps/api/src/routes/facts.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Produces (used by Task 3 and Task 4):
  - `getDocumentFacts(req: Request & { params: { id: string } }): Promise<Response>` → `200 { document, facts, tracked_markers }`, `404` for unknown/invalid id.
  - Each fact object: `id, patient_id, visit_id, document_id, tracked_marker_id, tracked_marker_name, raw_marker_label, field_type, value, unit, reference_range, as_of_date (YYYY-MM-DD | null), needs_manual_date, coverage_status, verification_state, source_page, source_location, source_snippet`.
  - module-private helpers `queryFacts(exec, filter)` and `isUuid(value)`, reused by Task 3 in the same file.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/facts.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getDocumentFacts } from "./facts";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, asAuthedUser, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let otherPatientId: string;
let visitId: string;
let ceaMarkerId: string;
let otherPatientMarkerId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "facts-route-staff");
  oncologist = await createTestUser("oncologist", "facts-route-onc");
  patientId = (await createTestPatient(staff.id)).id;
  otherPatientId = (await createTestPatient(staff.id)).id;
  [{ id: visitId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: ceaMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  [{ id: otherPatientMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${otherPatientId}, 'PSA', false, ${staff.id}) RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId, otherPatientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newDocument(): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', 'blood', 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  return doc.id;
}

async function newFact(documentId: string, o: Record<string, unknown> = {}): Promise<string> {
  const f = {
    value: "4.2", asOf: "2026-02-01", needsDate: false, coverage: "value_found", verification: "unverified",
    rawLabel: null as string | null, markerId: null as string | null, ...o,
  };
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, raw_marker_label, field_type, value,
      as_of_date, needs_manual_date, coverage_status, verification_state, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${f.markerId}, ${f.rawLabel}, 'marker_value', ${f.value},
      ${f.asOf}, ${f.needsDate}, ${f.coverage}, ${f.verification},
      ${f.verification === "oncologist_signed_off" ? oncologist.id : null})
    RETURNING id`;
  return row.id;
}

function getReq(id: string) {
  const req = new Request(`http://localhost/documents/${id}/facts`) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

function patchReq(id: string, body: unknown) {
  const req = new Request(`http://localhost/facts/${id}`, { method: "PATCH", body: JSON.stringify(body) }) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

test("GET returns the document, its facts (dates as YYYY-MM-DD, marker name joined) and the patient's markers", async () => {
  const docId = await newDocument();
  await newFact(docId, { markerId: ceaMarkerId });
  await newFact(docId, { asOf: null, needsDate: true, rawLabel: "Mystery", coverage: "extraction_uncertain" });

  const res = await getDocumentFacts(getReq(docId));
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body.document.id).toBe(docId);
  expect(body.facts).toHaveLength(2);
  const mapped = body.facts.find((f: any) => f.tracked_marker_id === ceaMarkerId);
  expect(mapped.tracked_marker_name).toBe("CEA");
  expect(mapped.as_of_date).toBe("2026-02-01");
  const undated = body.facts.find((f: any) => f.needs_manual_date);
  expect(undated.as_of_date).toBeNull();
  expect(undated.raw_marker_label).toBe("Mystery");
  expect(body.tracked_markers.map((m: any) => m.marker_name)).toEqual(["CEA"]);
});

test("GET returns 404 for an unknown or malformed document id", async () => {
  expect((await getDocumentFacts(getReq("00000000-0000-0000-0000-000000000000"))).status).toBe(404);
  expect((await getDocumentFacts(getReq("not-a-uuid"))).status).toBe(404);
});
```

(`patchReq` is defined here because Task 3's tests, appended to this same file, use it.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/routes/facts.test.ts --timeout 8000`
Expected: FAIL — cannot resolve `./facts` (module missing).

- [ ] **Step 3: Implement**

Create `apps/api/src/routes/facts.ts`:

```ts
import { sql } from "../db/client";
import { jsonError } from "../middleware/auth";
import type { AuthedUser } from "../middleware/auth";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

type Exec = typeof sql;

// Explicit column list (not f.*) so as_of_date is a YYYY-MM-DD string, never a JS Date.
async function queryFacts(exec: Exec, filter: { documentId?: string; factId?: string }) {
  return exec`
    SELECT f.id, f.patient_id, f.visit_id, f.document_id, f.tracked_marker_id,
           tm.marker_name AS tracked_marker_name, f.raw_marker_label, f.field_type, f.value, f.unit,
           f.reference_range, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.needs_manual_date,
           f.coverage_status, f.verification_state, f.source_page, f.source_location, f.source_snippet
    FROM facts f
    LEFT JOIN tracked_markers tm ON tm.id = f.tracked_marker_id
    WHERE (${filter.documentId ?? null}::uuid IS NULL OR f.document_id = ${filter.documentId ?? null}::uuid)
      AND (${filter.factId ?? null}::uuid IS NULL OR f.id = ${filter.factId ?? null}::uuid)
    ORDER BY f.source_page NULLS LAST, tm.marker_name NULLS LAST, f.field_type, f.id
  `;
}

export async function getDocumentFacts(req: Request & { params: { id: string } }): Promise<Response> {
  const documentId = req.params.id;
  if (!isUuid(documentId)) return jsonError(404, "not_found", "Document not found.");

  const [document] = await sql`SELECT * FROM documents WHERE id = ${documentId}`;
  if (!document) return jsonError(404, "not_found", "Document not found.");

  const facts = await queryFacts(sql, { documentId });
  const trackedMarkers = await sql`
    SELECT id, marker_name, is_custom, added_at, added_by FROM tracked_markers
    WHERE patient_id = ${document.patient_id} ORDER BY added_at ASC
  `;
  return Response.json({ document, facts, tracked_markers: trackedMarkers });
}
```

(`AuthedUser` is imported now because Task 3 adds `patchFact` to this file; if `tsc` flags the unused type import at this point, add the import in Task 3 instead.)

- [ ] **Step 4: Register the route**

In `apps/api/src/index.ts` add `import { getDocumentFacts } from "./routes/facts";` and inside `routes`:

```ts
    "/documents/:id/facts": cors({
      GET: requireRole(["staff", "oncologist"], getDocumentFacts),
    }),
```

- [ ] **Step 5: Run to verify pass, then typecheck**

Run: `bun test apps/api/src/routes/facts.test.ts --timeout 8000` → 2 pass.
Run: `bunx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/facts.ts apps/api/src/routes/facts.test.ts apps/api/src/index.ts
git commit -m "feat: GET /documents/:id/facts for the Extraction Review screen"
```

---

### Task 3: `PATCH /facts/:id`

**Files:**
- Modify: `apps/api/src/routes/facts.ts`
- Modify: `apps/api/src/routes/facts.test.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: `queryFacts`, `isUuid` (same file, Task 2); test helpers `newDocument`, `newFact`, `patchReq` (same test file, Task 2).
- Produces: `patchFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response>`. Body `{ value?: string; tracked_marker_id?: string; as_of_date?: string }` (≥1 field). `200` → the updated fact (same shape as Task 2's fact object). `400` invalid body; `404` unknown fact; `409` when `verification_state='oncologist_signed_off'`.

Semantics (all in one transaction, `SELECT ... FOR UPDATE` on the fact first):
- any accepted edit → `verification_state='staff_corrected'`, `corrected_by=user.id`
- `value` (trimmed, non-empty) → set; if `coverage_status='extraction_uncertain'` → `value_found`
- `tracked_marker_id` (must belong to the fact's patient) → set, `raw_marker_label=NULL`
- `as_of_date` (real `YYYY-MM-DD`) → set, fact `needs_manual_date=false`
- `documents.needs_manual_date` recomputed = any sibling fact still needs a date
- `audit_log` row: `action='correct'`, `entity_type='fact'`, `before_value`/`after_value`

- [ ] **Step 1: Write the failing tests**

In `facts.test.ts`, change the top import to `import { getDocumentFacts, patchFact } from "./facts";` and append:

```ts
async function factRow(id: string) {
  const [row] = await sql`SELECT * FROM facts WHERE id = ${id}`;
  return row;
}

test("PATCH value on an extraction_uncertain fact stores it, flips coverage to value_found, marks staff_corrected, audits", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { coverage: "extraction_uncertain", value: "4.?" });
  const res = await patchFact(patchReq(id, { value: "4.2" }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.value).toBe("4.2");
  expect(row.coverage_status).toBe("value_found");
  expect(row.verification_state).toBe("staff_corrected");
  expect(row.corrected_by).toBe(staff.id);

  const [audit] = await sql`SELECT * FROM audit_log WHERE entity_type = 'fact' AND entity_id = ${id} AND action = 'correct'`;
  expect(audit.actor_id).toBe(staff.id);
  expect(JSON.parse(audit.before_value).value).toBe("4.?");
  expect(JSON.parse(audit.after_value).value).toBe("4.2");
});

test("PATCH value does not change coverage_status when it was not extraction_uncertain", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { coverage: "not_applicable" });
  await patchFact(patchReq(id, { value: "x" }), asAuthedUser(staff));
  expect((await factRow(id)).coverage_status).toBe("not_applicable");
});

test("PATCH tracked_marker_id maps the marker, clears raw_marker_label, leaves coverage_status alone", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { rawLabel: "Carcino Embryonic", coverage: "extraction_uncertain" });
  const res = await patchFact(patchReq(id, { tracked_marker_id: ceaMarkerId }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  const row = await factRow(id);
  expect(row.tracked_marker_id).toBe(ceaMarkerId);
  expect(row.raw_marker_label).toBeNull();
  expect(row.coverage_status).toBe("extraction_uncertain");
  expect(row.verification_state).toBe("staff_corrected");
  expect(((await res.json()) as any).tracked_marker_name).toBe("CEA");
});

test("PATCH rejects a tracked_marker_id that belongs to another patient", async () => {
  const docId = await newDocument();
  const id = await newFact(docId);
  const res = await patchFact(patchReq(id, { tracked_marker_id: otherPatientMarkerId }), asAuthedUser(staff));
  expect(res.status).toBe(400);
  expect((await factRow(id)).tracked_marker_id).toBeNull();
});

test("PATCH as_of_date clears the fact's needs_manual_date and recomputes the document flag", async () => {
  const docId = await newDocument();
  const a = await newFact(docId, { asOf: null, needsDate: true });
  const b = await newFact(docId, { asOf: null, needsDate: true });
  await sql`UPDATE documents SET needs_manual_date = true WHERE id = ${docId}`;

  await patchFact(patchReq(a, { as_of_date: "2026-03-05" }), asAuthedUser(staff));
  let [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${docId}`;
  expect(doc.needs_manual_date).toBe(true); // b is still undated
  expect((await factRow(a)).needs_manual_date).toBe(false);

  await patchFact(patchReq(b, { as_of_date: "2026-03-06" }), asAuthedUser(staff));
  [doc] = await sql`SELECT needs_manual_date FROM documents WHERE id = ${docId}`;
  expect(doc.needs_manual_date).toBe(false);
});

test("PATCH returns 409 for an oncologist_signed_off fact and changes nothing", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { verification: "oncologist_signed_off" });
  const res = await patchFact(patchReq(id, { value: "9.9" }), asAuthedUser(oncologist));
  expect(res.status).toBe(409);
  expect((await factRow(id)).value).toBe("4.2");
});

test("PATCH is allowed from reopened_by_oncologist and lands in staff_corrected, not signed off", async () => {
  const docId = await newDocument();
  const id = await newFact(docId, { verification: "reopened_by_oncologist" });
  const res = await patchFact(patchReq(id, { value: "5.0" }), asAuthedUser(staff));
  expect(res.status).toBe(200);
  expect((await factRow(id)).verification_state).toBe("staff_corrected");
});

test("PATCH validates the body", async () => {
  const docId = await newDocument();
  const id = await newFact(docId);
  for (const body of [{}, { value: "" }, { value: "   " }, { value: 5 }, { as_of_date: "2026-13-45" }, { as_of_date: "03/05/2026" }, { tracked_marker_id: "nope" }]) {
    expect((await patchFact(patchReq(id, body), asAuthedUser(staff))).status).toBe(400);
  }
  const bad = new Request("http://localhost/facts/x", { method: "PATCH", body: "{not json" }) as Request & { params: { id: string } };
  bad.params = { id };
  expect((await patchFact(bad, asAuthedUser(staff))).status).toBe(400);
});

test("PATCH 404s for an unknown or malformed fact id", async () => {
  expect((await patchFact(patchReq("00000000-0000-0000-0000-000000000000", { value: "1" }), asAuthedUser(staff))).status).toBe(404);
  expect((await patchFact(patchReq("nope", { value: "1" }), asAuthedUser(staff))).status).toBe(404);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/api/src/routes/facts.test.ts --timeout 8000`
Expected: the 9 PATCH tests FAIL (`patchFact` is not a function / not exported); the 2 GET tests still pass.

- [ ] **Step 3: Implement `patchFact`**

Append to `apps/api/src/routes/facts.ts`:

```ts
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function patchFact(req: Request & { params: { id: string } }, user: AuthedUser): Promise<Response> {
  const factId = req.params.id;
  if (!isUuid(factId)) return jsonError(404, "not_found", "Fact not found.");

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(400, "bad_request", "Malformed JSON body.");
  }
  if (typeof body !== "object" || body === null) return jsonError(400, "bad_request", "Expected a JSON object.");

  const { value, tracked_marker_id: markerId, as_of_date: asOfDate } = body;
  if (value === undefined && markerId === undefined && asOfDate === undefined) {
    return jsonError(400, "bad_request", "Provide at least one of value, tracked_marker_id, as_of_date.");
  }
  if (value !== undefined && (typeof value !== "string" || value.trim() === "")) {
    return jsonError(400, "bad_request", "value must be a non-empty string.");
  }
  if (markerId !== undefined && !isUuid(markerId)) {
    return jsonError(400, "bad_request", "tracked_marker_id must be a UUID.");
  }
  if (asOfDate !== undefined && (typeof asOfDate !== "string" || !isRealDate(asOfDate))) {
    return jsonError(400, "bad_request", "as_of_date must be a real date in YYYY-MM-DD format.");
  }

  const newValue = typeof value === "string" ? value.trim() : null;
  const newMarkerId = typeof markerId === "string" ? markerId : null;
  const newDate = typeof asOfDate === "string" ? asOfDate : null;

  const outcome = await sql.begin(async (tx) => {
    const [before] = await tx`SELECT * FROM facts WHERE id = ${factId} FOR UPDATE`;
    if (!before) return "not_found" as const;
    if (before.verification_state === "oncologist_signed_off") return "signed_off" as const;

    if (newMarkerId) {
      const [marker] = await tx`SELECT id FROM tracked_markers WHERE id = ${newMarkerId} AND patient_id = ${before.patient_id}`;
      if (!marker) return "bad_marker" as const;
    }

    const [updated] = await tx`
      UPDATE facts SET
        value = COALESCE(${newValue}::text, value),
        tracked_marker_id = COALESCE(${newMarkerId}::uuid, tracked_marker_id),
        raw_marker_label = CASE WHEN ${newMarkerId}::uuid IS NOT NULL THEN NULL ELSE raw_marker_label END,
        as_of_date = COALESCE(${newDate}::date, as_of_date),
        needs_manual_date = CASE WHEN ${newDate}::date IS NOT NULL THEN false ELSE needs_manual_date END,
        coverage_status = CASE WHEN ${newValue}::text IS NOT NULL AND coverage_status = 'extraction_uncertain'
                               THEN 'value_found'::coverage_status ELSE coverage_status END,
        verification_state = 'staff_corrected',
        corrected_by = ${user.id}
      WHERE id = ${factId}
      RETURNING *
    `;

    await tx`
      UPDATE documents SET needs_manual_date =
        EXISTS (SELECT 1 FROM facts WHERE document_id = ${before.document_id} AND needs_manual_date)
      WHERE id = ${before.document_id}
    `;
    await tx`
      INSERT INTO audit_log (actor_id, action, entity_type, entity_id, before_value, after_value)
      VALUES (${user.id}, 'correct', 'fact', ${factId}, ${JSON.stringify(before)}::jsonb, ${JSON.stringify(updated)}::jsonb)
    `;
    return "ok" as const;
  });

  if (outcome === "not_found") return jsonError(404, "not_found", "Fact not found.");
  if (outcome === "signed_off") {
    return jsonError(409, "conflict", "This fact is oncologist signed-off; it must be reopened before it can be corrected.");
  }
  if (outcome === "bad_marker") return jsonError(400, "bad_request", "tracked_marker_id does not belong to this fact's patient.");

  const [fact] = await queryFacts(sql, { factId });
  return Response.json(fact);
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/index.ts` change the import to `import { getDocumentFacts, patchFact } from "./routes/facts";` and add:

```ts
    "/facts/:id": cors({
      PATCH: requireRole(["staff", "oncologist"], patchFact),
    }),
```

- [ ] **Step 5: Run to verify pass, typecheck, full suite**

Run: `bun test apps/api/src/routes/facts.test.ts --timeout 8000` → 11 pass.
Run: `bunx tsc --noEmit -p tsconfig.json` → clean.
Run: `bun test --timeout 8000` → all pass.

If a parameter-typing error appears (`could not determine data type of parameter`), keep the explicit `::text`/`::uuid`/`::date` casts shown above — they exist for that reason.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/facts.ts apps/api/src/routes/facts.test.ts apps/api/src/index.ts
git commit -m "feat: PATCH /facts/:id (value, marker mapping, as_of_date) with audit logging"
```

---

### Task 4: Web API client methods

**Files:**
- Modify: `apps/web/src/api/client.ts`

**Interfaces:**
- Consumes: Task 2/3 response shapes.
- Produces: `ReviewFact`, `DocumentReview` types; `api.getDocumentFacts(documentId: string): Promise<DocumentReview>`, `api.patchFact(factId: string, patch: { value?: string; tracked_marker_id?: string; as_of_date?: string }): Promise<ReviewFact>`.

- [ ] **Step 1: Add types and methods**

After `DocumentRecord` add:

```ts
export interface ReviewFact {
  id: string;
  patient_id: string;
  visit_id: string;
  document_id: string;
  tracked_marker_id: string | null;
  tracked_marker_name: string | null;
  raw_marker_label: string | null;
  field_type: string;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  as_of_date: string | null;
  needs_manual_date: boolean;
  coverage_status: string;
  verification_state: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
}

export interface DocumentReview {
  document: DocumentRecord;
  facts: ReviewFact[];
  tracked_markers: TrackedMarker[];
}
```

Inside `api` after `uploadDocument`:

```ts
  getDocumentFacts: (documentId: string) => request<DocumentReview>(`/documents/${documentId}/facts`),

  patchFact: (factId: string, patch: { value?: string; tracked_marker_id?: string; as_of_date?: string }) =>
    request<ReviewFact>(`/facts/${factId}`, { method: "PATCH", body: JSON.stringify(patch) }),
```

- [ ] **Step 2: Typecheck and commit**

Run: `bunx tsc --noEmit -p tsconfig.json` → clean.

```bash
git add apps/web/src/api/client.ts
git commit -m "web: API client for document facts review and fact correction"
```

---

### Task 5: `FactCard` component

**Files:**
- Create: `apps/web/src/components/FactCard.tsx`

**Interfaces:**
- Consumes: `ReviewFact`, `TrackedMarker`, `api.patchFact`, `api.addMarker`, `ApiError` from `../api/client`.
- Produces: `export function FactCard(props: { fact: ReviewFact; trackedMarkers: TrackedMarker[]; onChanged: () => void }): JSX.Element`. `onChanged` is called after any successful save so the parent reloads.

Behaviour: left column "Raw text from document" (`source_snippet`, or "Source detail unavailable"; plus page/location when present); right column the structured fields. Coverage status in plain language: `value_found` "Value found", `not_assessed` "Not assessed", `not_applicable` "Not applicable per source", `extraction_uncertain` "Needs review", `conflicting_sources` "Conflicting values, see sources". Value correction input + "Save value" (also serves as "confirm"). If `raw_marker_label`: mapping control — a `<select>` of existing tracked markers with "Map", plus a text input + "Add as new marker" that calls `api.addMarker(fact.patient_id, name)` then `api.patchFact(fact.id, { tracked_marker_id: newMarker.id })`. If `needs_manual_date`: date input + "Save date". Every action shows its own error and disables its button while saving.

- [ ] **Step 1: Create the component**

```tsx
import { useState } from "react";
import { api, ApiError, type ReviewFact, type TrackedMarker } from "../api/client";

const COVERAGE_LABELS: Record<string, string> = {
  value_found: "Value found",
  not_assessed: "Not assessed",
  not_applicable: "Not applicable per source",
  extraction_uncertain: "Needs review",
  conflicting_sources: "Conflicting values, see sources",
};

const FIELD_LABELS: Record<string, string> = {
  marker_value: "Marker value",
  reference_range: "Reference range",
  treatment_regimen: "Treatment regimen",
  radiology_impression: "Radiology impression",
  disease_status_trend: "Disease status / trend",
};

interface Props {
  fact: ReviewFact;
  trackedMarkers: TrackedMarker[];
  onChanged: () => void;
}

export function FactCard({ fact, trackedMarkers, onChanged }: Props) {
  const [value, setValue] = useState(fact.value ?? "");
  const [markerId, setMarkerId] = useState("");
  const [customName, setCustomName] = useState("");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, action: () => Promise<unknown>) {
    setError(null);
    setBusy(label);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Save failed.");
    } finally {
      setBusy(null);
    }
  }

  const heading = fact.tracked_marker_name ?? fact.raw_marker_label ?? FIELD_LABELS[fact.field_type] ?? fact.field_type;
  const needsReview = fact.coverage_status === "extraction_uncertain";

  return (
    <div className="card">
      <div className="page-heading" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{heading}</h2>
        <span className={`tag ${needsReview ? "tag--pending" : ""}`}>{COVERAGE_LABELS[fact.coverage_status] ?? fact.coverage_status}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {FIELD_LABELS[fact.field_type] ?? fact.field_type} · {fact.verification_state.replace(/_/g, " ")} ·{" "}
        {fact.as_of_date ? `as of ${fact.as_of_date}` : "no as-of date"}
      </p>

      {error && <div className="error-banner">{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div>
          <h3 style={{ marginTop: 0 }}>Raw text from document</h3>
          {fact.source_snippet ? <blockquote style={{ margin: 0 }}>{fact.source_snippet}</blockquote> : <p className="muted">Source detail unavailable</p>}
          {(fact.source_page !== null || fact.source_location) && (
            <p className="field-hint">
              {fact.source_page !== null && `Page ${fact.source_page}`}
              {fact.source_page !== null && fact.source_location && " · "}
              {fact.source_location}
            </p>
          )}
        </div>
        <div>
          <h3 style={{ marginTop: 0 }}>Extracted value</h3>
          <p style={{ marginTop: 0 }}>
            {fact.value ?? <span className="muted">(no value)</span>}
            {fact.unit && ` ${fact.unit}`}
            {fact.reference_range && <span className="muted"> · ref {fact.reference_range}</span>}
          </p>
          <form
            className="field"
            onSubmit={(e) => {
              e.preventDefault();
              void run("value", () => api.patchFact(fact.id, { value }));
            }}
          >
            <label htmlFor={`value-${fact.id}`}>Correct value (saving confirms it)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id={`value-${fact.id}`} value={value} onChange={(e) => setValue(e.target.value)} />
              <button className="btn btn--secondary" type="submit" disabled={busy !== null || value.trim() === ""}>
                {busy === "value" ? "Saving..." : "Save value"}
              </button>
            </div>
          </form>
        </div>
      </div>

      {fact.raw_marker_label && (
        <div className="field" style={{ marginTop: 16 }}>
          <label>
            Marker "{fact.raw_marker_label}" isn't mapped to a tracked marker
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <select value={markerId} onChange={(e) => setMarkerId(e.target.value)} aria-label="Existing tracked marker">
              <option value="">Map to existing marker...</option>
              {trackedMarkers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.marker_name}
                </option>
              ))}
            </select>
            <button
              className="btn btn--secondary"
              type="button"
              disabled={busy !== null || !markerId}
              onClick={() => void run("map", () => api.patchFact(fact.id, { tracked_marker_id: markerId }))}
            >
              {busy === "map" ? "Mapping..." : "Map"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="Or add as a new marker"
              aria-label="New custom marker name"
            />
            <button
              className="btn btn--secondary"
              type="button"
              disabled={busy !== null || customName.trim() === ""}
              onClick={() =>
                void run("add", async () => {
                  const created = await api.addMarker(fact.patient_id, customName.trim());
                  await api.patchFact(fact.id, { tracked_marker_id: created.id });
                })
              }
            >
              {busy === "add" ? "Adding..." : "Add and map"}
            </button>
          </div>
        </div>
      )}

      {fact.needs_manual_date && (
        <form
          className="field"
          style={{ marginTop: 16 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run("date", () => api.patchFact(fact.id, { as_of_date: date }));
          }}
        >
          <label htmlFor={`date-${fact.id}`}>As-of date (not found in the document)</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input id={`date-${fact.id}`} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            <button className="btn btn--secondary" type="submit" disabled={busy !== null || !date}>
              {busy === "date" ? "Saving..." : "Save date"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/FactCard.tsx
git commit -m "web: FactCard component (raw vs structured, correction, marker mapping, date entry)"
```

---

### Task 6: `ExtractionReview` screen, route and entry point

**Files:**
- Create: `apps/web/src/screens/ExtractionReview.tsx`
- Modify: `apps/web/src/router.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/screens/Upload.tsx`

**Interfaces:**
- Consumes: `api.getDocumentFacts`, `api.patchFact`, `DocumentReview`, `FactCard` (Tasks 4–5).
- Produces: `export function ExtractionReview(props: { documentId: string }): JSX.Element`; `matchDocumentReview(path: string): string | null` in `router.ts`.

- [ ] **Step 1: Router matcher**

Append to `apps/web/src/router.ts`:

```ts
export function matchDocumentReview(path: string): string | null {
  const m = path.match(/^\/documents\/([^/]+)\/review$/);
  return m ? m[1]! : null;
}
```

- [ ] **Step 2: Screen**

Create `apps/web/src/screens/ExtractionReview.tsx`:

```tsx
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type DocumentReview } from "../api/client";
import { FactCard } from "../components/FactCard";
import { navigate } from "../router";

export function ExtractionReview({ documentId }: { documentId: string }) {
  const [data, setData] = useState<DocumentReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [bulkDate, setBulkDate] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.getDocumentFacts(documentId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load document.");
    } finally {
      setLoading(false);
    }
  }, [documentId]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    void load();
  }, [load]);

  async function applyDateToAll(e: FormEvent) {
    e.preventDefault();
    if (!data) return;
    setBulkBusy(true);
    setError(null);
    try {
      for (const fact of data.facts.filter((f) => f.needs_manual_date)) {
        await api.patchFact(fact.id, { as_of_date: bulkDate });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save the date for every fact.");
    } finally {
      setBulkBusy(false);
      await load();
    }
  }

  if (loading) return <p className="muted">Loading...</p>;
  if (!data) return <div className="error-banner">{error ?? "Document not found."}</div>;

  const { document, facts, tracked_markers } = data;
  const undated = facts.filter((f) => f.needs_manual_date);
  const wholeDocumentUndated = facts.length > 0 && undated.length === facts.length;

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1>Extraction review</h1>
          <p className="muted" style={{ margin: 0 }}>
            {document.document_type} · {document.source_origin.replace(/_/g, " ")}
          </p>
        </div>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${document.patient_id}/upload`)}>
          Back to upload
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {document.ocr_status !== "done" ? (
        <div className="card">
          <p className="muted">
            OCR status is "{document.ocr_status}", so there are no extracted facts to review for this document.
          </p>
        </div>
      ) : document.extraction_status === "failed" ? (
        <div className="error-banner">
          Fact extraction failed for this document — it was not analyzed. This is different from "nothing found".
        </div>
      ) : document.extraction_status === "pending" ? (
        <div className="card">
          <p className="muted">Extraction has not run for this document yet.</p>
        </div>
      ) : facts.length === 0 ? (
        <div className="empty-state">Extraction ran and found no facts in this document.</div>
      ) : wholeDocumentUndated ? (
        <div className="card">
          <h2>No date found in this document</h2>
          <p className="muted">
            None of the {facts.length} extracted fact(s) has an as-of date. Enter the date to continue the review.
          </p>
          <form onSubmit={applyDateToAll} className="field">
            <label htmlFor="bulk-date">As-of date for all facts</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input id="bulk-date" type="date" value={bulkDate} onChange={(e) => setBulkDate(e.target.value)} required />
              <button className="btn btn--primary" type="submit" disabled={bulkBusy || !bulkDate}>
                {bulkBusy ? "Saving..." : "Apply date"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          {undated.length > 0 && (
            <div className="card">
              <p style={{ margin: 0 }}>
                {undated.length} fact(s) have no as-of date — enter one on each card below. Facts without a date can be
                corrected but not signed off.
              </p>
            </div>
          )}
          {facts.map((fact) => (
            <FactCard key={fact.id} fact={fact} trackedMarkers={tracked_markers} onChanged={load} />
          ))}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire the route**

In `apps/web/src/App.tsx`: change the router import to `import { useHashRoute, matchPatientUpload, matchDocumentReview } from "./router";`, add `import { ExtractionReview } from "./screens/ExtractionReview";`, and in `Routed()`:

```tsx
  const reviewDocumentId = matchDocumentReview(route);
```
then extend the chain:
```tsx
  if (uploadPatientId) {
    screen = <Upload patientId={uploadPatientId} />;
  } else if (reviewDocumentId) {
    screen = <ExtractionReview documentId={reviewDocumentId} />;
  } else if (route === "/patients/new") {
```

- [ ] **Step 4: Entry point from Upload**

In `apps/web/src/screens/Upload.tsx` add nothing to imports (`navigate` is already imported). In the "Uploaded this session" row, replace

```tsx
              <span className="tag tag--pending">{doc.ocr_status}</span>
```
with
```tsx
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className="tag tag--pending">{doc.ocr_status}</span>
                {doc.ocr_status === "done" && (
                  <button className="btn btn--ghost" type="button" onClick={() => navigate(`/documents/${doc.id}/review`)}>
                    Review extraction
                  </button>
                )}
              </span>
```

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p tsconfig.json` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/screens/ExtractionReview.tsx apps/web/src/router.ts apps/web/src/App.tsx apps/web/src/screens/Upload.tsx
git commit -m "web: Extraction Review screen, route, and entry point from Upload"
```

---

### Task 7: Verify in a browser and update docs

**Files:**
- Modify: `docs/m2-backlog.md`, `docs/02-implementation-blueprint.md` (M2 checklist line), `docs/m2-tracker.xlsx` (regenerate via the scratchpad script only if the user still wants the sheet current)

There are no web unit tests in this repo; UI correctness is verified by using it (CLAUDE.md: test the golden path and edge cases in a browser before reporting done).

- [ ] **Step 1: Seed data that exercises every state**

With the API running (`bun --hot apps/api/src/index.ts` from the repo root) and the dev users seeded (`bun apps/api/src/db/seed.ts`), insert a patient, visit, document (`ocr_status='done'`, `extraction_status='done'`) and facts directly with `docker exec -i opd_postgres psql -U opd -d opd_dev` covering: (a) a mapped, dated, `value_found` fact; (b) an `extraction_uncertain` fact with `raw_marker_label` set and a null snippet; (c) an undated fact (`as_of_date NULL`, `needs_manual_date=true`); and a second document whose facts are **all** undated; a third with `extraction_status='failed'`; a fourth with zero facts.

- [ ] **Step 2: Walk the golden path and edge cases**

Start the web app (`bun --hot apps/web/src/server.ts`), sign in as `staff@opd.local` / `staff-password`, open `#/documents/<id>/review`. Confirm: raw text beside structured value; plain-language status; saving a value flips "Needs review" to "Value found" and shows `staff corrected`; mapping to an existing marker removes the mapping control and keeps "Needs review"; "Add and map" creates a custom marker and maps it; the per-fact date input clears the "no as-of date" note; the all-undated document shows only the single date form until submitted, then the cards; the failed document shows the "not analyzed" message; the empty one shows "found no facts"; an OCR-not-done document shows the OCR-status message. Also confirm a signed-off fact (set via SQL) returns the 409 message when saving.

- [ ] **Step 3: Update docs**

In `docs/02-implementation-blueprint.md`, tick the M2 line "Build the Extraction Review (staff) screen ..." (`- [x]`). In `docs/m2-backlog.md` move the Extraction Review section from "Design decisions captured, not yet implemented" to Resolved with what was built and the four fixed design details above; add the 409-vs-403 note (Invariants §2 governs).

- [ ] **Step 4: Final verification and commit**

Run: `bun test --timeout 8000` and `bunx tsc --noEmit -p tsconfig.json` from the repo root — all green.

```bash
git add docs/
git commit -m "docs: mark Extraction Review screen done, record final design"
```
