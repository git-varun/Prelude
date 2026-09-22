# M1 Backlog, Known Issues & Open Questions

Living tracker for the M1 (Foundation) milestone, maintained alongside the
frozen spec docs (01–03). Unlike those, **this document is not frozen** —
update it as items get resolved or new ones surface.

Last updated: 2026-09-22, after M1 completion + first code review pass.

---

## Open questions (need your decision)

| # | Question | Why it matters |
| --- | --- | --- |
| Q1 | How do real staff/oncologist accounts get created before pilot? Right now the only way is running `apps/api/src/db/seed.ts` (two hardcoded dev accounts) or a raw SQL insert — there is no signup endpoint or admin UI, by design (spec has no admin/IT role). | Someone needs to provision the partner oncologist's and their staff's real accounts before go-live. Is a one-off seed script + manual password handoff acceptable for a single-hospital informal deployment, or do we want a minimal `POST /users` (oncologist-only, or CLI-only) path? |
| Q2 | Should local Postgres setup be scripted (e.g. a `docker-compose.yml` in `/infra`) instead of the ad hoc `docker run` command used to stand up `opd_postgres` during M1? | Right now a new developer cloning the repo has no reproducible way to get a working local DB matching `.env.example`'s `DATABASE_URL`. Low effort, but currently undocumented outside this file. |
| Q3 | `requireRole` returns `401` for unauthenticated requests. The frozen spec's error convention (§11) only enumerates `400/403/404/409/422` — it doesn't mention `401`. Is `401` an acceptable addition, or should unauthenticated collapse into `403` to stay strictly within the documented set? | Affects every protected endpoint's contract. Low risk either way, but it's an assumption I made unilaterally and should be confirmed rather than silently kept. |
| Q4 | Object storage: only the `local` driver is implemented. `OBJECT_STORAGE_DRIVER=s3` (or similar) will throw at runtime — there's no actual S3-compatible client written yet. When staging setup happens, who picks the vendor and writes that driver — is that an M8 (Pilot Readiness) task, or should it move earlier? | Confirmed at M1 kickoff that vendor choice is a "staging-time decision," but the driver code itself still needs to exist before staging can deploy. |

## Known issues / gaps (not blocking M1, but real)

| # | Issue | Severity | Notes |
| --- | --- | --- | --- |
| B1 | No persisted automated test suite beyond `apps/api/src/middleware/roles.test.ts`. Every other verification (patients, markers, visits, documents, CORS, list/search) was an ad hoc `bun test` file written, run, and **deleted** before committing, per how each task was verified in the moment. | Medium | Regressions in patient/visit/document logic won't be caught automatically. Should write and keep a real test suite before M2 builds on top of this surface. |
| B2 | No cleanup job for expired `sessions` rows — they accumulate forever. | Low | Fine at MVP scale; a cron/sweep is a pre-Phase-2 nicety. |
| B3 | Document upload has no file size limit, no MIME-type/document_type cross-check, no malware scanning. | Medium (security) | Acceptable for an informal single-hospital pilot per §12, but should be revisited before any expansion. |
| B4 | If the DB insert in `uploadDocument` fails after the file is already written to local storage, the file is orphaned (no transactional coordination between file write and DB row). | Low | Rare failure path; worth a cleanup-on-error someday, not urgent. |
| B5 | `GET /patients` has no pagination. | Low | Fine at "tens of patients" scale (§7 N6); would need addressing before any Phase 3 multi-centre expansion. |
| B6 | No rate-limiting / brute-force protection on `POST /auth/login`. | Low (security) | Consistent with the "no formal SLA/informal deployment" posture (§12), but worth a line item before real patient data is involved. |
| B7 | `AuthContext`'s initial `GET /auth/me` failure is indistinguishable from "not logged in" vs. "API unreachable" — user just sees the Login screen either way, no connectivity error shown. | Low (UX) | Minor polish item. |
| B8 | The Upload screen calls `POST /patients/:id/visits` on every mount. Harmless (idempotent by date), but causes a redundant network round-trip on every screen visit/navigation. | Low | Could cache per-session if it becomes noticeable. |

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
