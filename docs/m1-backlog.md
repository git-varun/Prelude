# M1 Backlog, Known Issues & Open Questions

Living tracker for the M1 (Foundation) milestone, maintained alongside the
frozen spec docs (01–03). Unlike those, **this document is not frozen** —
update it as items get resolved or new ones surface.

Last updated: 2026-09-22, after resolving the M1 findings (Q1–Q4, B1–B8) below.

---

## Open questions — resolved 2026-09-22

| # | Question | Decision |
| --- | --- | --- |
| Q1 | How do real staff/oncologist accounts get created before pilot? | Added a minimal `POST /users` (oncologist-only) endpoint (`apps/api/src/routes/users.ts`) instead of relying solely on `db/seed.ts`/raw SQL. Not in the frozen API contract table (docs/01 §11) — same precedent as `GET /patients` below. |
| Q2 | Should local Postgres setup be scripted? | Added `infra/docker-compose.yml`, matching `.env.example`'s `DATABASE_URL` (port 5434, db `opd_dev`, user `opd`). Mounts `schema.sql` and `migrations/001_sessions.sql` as init scripts. Run with `docker compose -f infra/docker-compose.yml up -d`. |
| Q3 | Is `401` for unauthenticated requests an acceptable addition to §11's `400/403/404/409/422` set? | Kept `401` — correct HTTP semantics for "not authenticated" vs. `403` "authenticated but forbidden." Recorded here as the confirmed addition to §11's error set, alongside `429` (see B6). |
| Q4 | Who builds the S3-compatible object storage driver, and when? | Deferred to M8 (Pilot Readiness), per the original M1-kickoff decision that vendor choice is staging-time. No code change; `OBJECT_STORAGE_DRIVER=s3` still throws at runtime by design until then. |

## Known issues / gaps — resolved 2026-09-22

| # | Issue | Resolution |
| --- | --- | --- |
| B1 | No persisted automated test suite beyond `roles.test.ts`. | Added a kept `bun test` suite: `patients.test.ts`, `visits.test.ts`, `documents.test.ts`, `users.test.ts`, `auth.test.ts` (routes) and `cors.test.ts` (middleware), plus a shared `test-helpers.ts`. 35 tests total, run with `bun test`. |
| B2 | No cleanup job for expired `sessions` rows. | `createSession` now deletes expired rows (`expires_at <= now()`) on every login — no cron needed at MVP login volume. |
| B3 | Document upload had no file size limit or MIME-type check. | Added a 25MB size cap (checked via `Content-Length` pre-parse, `file.size` post-parse, and `Bun.serve`'s `maxRequestBodySize` as the hard server-level backstop) and a MIME-type allowlist (`application/pdf`, `image/jpeg`, `image/png`, `image/heic`) shared across all three document types — a UX guard, not a security control, since `file.type` is client-supplied. Malware scanning intentionally still out of scope (§12). |
| B4 | Orphaned file on DB-insert failure after file write. | `storage.ts` now exports `deleteDocumentFile`; `uploadDocument` calls it (best-effort) if the `INSERT` throws, before re-throwing. |
| B5 | `GET /patients` had no pagination. | Added optional `?limit=` (default 100, max 500) and `?offset=` query params. Kept the bare-array response shape — a wrapped `{items, total}` shape would have broken `PatientList.tsx`/`api.listPatients`'s `PatientSummary[]` contract for no benefit yet at "tens of patients" scale. |
| B6 | No rate-limiting on `POST /auth/login`. | Added an in-memory, per-email limiter (5 failed attempts / 15 min window → `429 too_many_requests`). Keyed on email, not IP, since `login`'s call site has no access to the request's source IP; single-instance only, noted in code. `429` is a confirmed addition to §11's error set alongside `401` (Q3). |
| B7 | `AuthContext`'s initial `GET /auth/me` failure couldn't distinguish "not logged in" from "API unreachable." | `AuthContext` now exposes `connectivityError` (true for anything other than a `401` from `/auth/me`); `Login` renders a distinct "Couldn't reach the server" banner when set. |
| B8 | Upload screen re-POSTs `/patients/:id/visits` on every mount. | Added a module-level cache keyed by `patientId:today's-date`, so remounting the Upload screen for the same patient on the same day reuses the already-open visit instead of re-opening it. |

## Backlog (explicitly deferred, tracked for later milestones)

These are known-missing pieces that are correctly *not* part of M1 — listed
here so they don't get lost, not because M1 should have included them.

- `GET /documents/:id` (source view / OCR text fetch) — needed for M6 tap-through and useful earlier for M2/M3 review screens. In the frozen API table (§11) but not yet built.
- `PATCH /facts/:id`, `POST /facts/:id/sign-off`, `POST /facts/:id/reopen` — M3.
- `POST /conflicts/:id/resolve`, `POST /conflicts/:id/annotate` — M7.
- `GET /patients/:id/snapshot` — M4 (needs delta computation to exist first).
- `DELETE /patients/:id` (F10, P1 — "ships if time allows," oncologist-only). No backend or frontend for this yet. `RoleGate` (the role-aware shell primitive) has nothing to gate in the M1 UI as a result — it's wired but unused until this or another oncologist-only action exists.
- Real controlled marker list — currently `CEA`, `CA-125`, `CA 19-9`, `PSA` as an explicit placeholder (`packages/shared/src/markers.ts`), confirmed with you as a TODO to replace with the oncologist's actual list before pilot.
- S3-compatible object storage driver (see Q4 above).

## Resolved gaps (logged for the record, not open anymore)

Flagged mid-build, confirmed with you, already fixed in the relevant commit —
kept here so the history of "spec vs. build" deviations is in one place
alongside the backlog, rather than only buried in commit messages.

- `coverage_status` enum: Blueprint's DDL (docs/02) had 6 stored values; Invariants doc (docs/03) corrected this to 5, with `not_found_in_document_set` synthesized at read time, never stored. Implemented per docs/03 (`d6c3e44`).
- `GET /patients` (list/search) and `GET /patients/:id` were missing from the frozen API contract table (§11) despite the Patient List screen requiring them. Added as a minimal, read-only addition after your confirmation (`704d3e5`).
- `users.password_hash` and the `sessions` table aren't in the Blueprint's DDL — added as necessary infrastructure for the confirmed "email/password with sessions" auth decision (`d6c3e44`, `aee07ea`).
- `conflicts.authoritative_fact_id` (Invariants §3's resolution mechanic) added to the schema now even though conflict resolution itself is M7 work, so the table shape doesn't need a later migration.

---

## Code review findings (2026-09-22, `/code-review --level high`)

Both confirmed and fixed directly (small, low-risk UI fixes) rather than
just logged — kept here for the record.

| # | Finding | Fix |
| --- | --- | --- |
| R1 | `Upload.tsx` showed "Loading patient..." based on `patient?.name` being falsy — but `PatientDetail.name` is nullable, so a patient created with no name would show "Loading patient..." forever even after the page finished loading. | Added an explicit `loadingPatient` boolean state instead of overloading `patient?.name` for two different meanings. |
| R2 | The data-loading `useEffect` in `Upload.tsx` had no guard against `patientId` changing (hash-navigating to a different patient) before an in-flight `getPatient`/`createOrOpenVisit` request resolved — a stale response could overwrite state for the wrong patient, and a subsequent upload could pair the new `patientId` with an old `visit.id` from a different patient, failing the server's visit-ownership check. | Added a `current` flag captured per-effect-run that gates every `setState` call, plus resetting `patient`/`visit` to `null` at the start of each run so a screen never shows another patient's stale data while the new one loads. |

Both fixes are in the working tree, verified via `tsc --noEmit`, ready to
commit.
