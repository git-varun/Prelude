# M2 Status: Work Done and Remaining Tasks

Snapshot as of 2026-09-25, after the `m2-extraction-review` branch was merged into `master` (18 commits, 29 files, tests 49 → 76, `tsc` clean). This is a summary and hand-off list; the detailed, living trackers are `docs/m2-backlog.md` (issue IDs C*/E*) and `docs/third-party-services.md`. Nothing has been pushed (the repo has no remote).

## 1. Work done

### M2 review and documentation pass
- Code review of the M2 ingestion cycle found five issues (later fixed, see below).
- Docs: `README.md` rewritten (setup, run, test, eval, docs index); `docs/third-party-services.md` created (Postgres, Azure Document Intelligence, AWS Textract, Anthropic API, local storage: env vars, free tier, DPA status); `docs/m2-backlog.md` brought up to date; Blueprint reference DDL updated to the final schema.
- Dependency check: `bun audit` clean; `typescript` bumped 5.9.3 → 7.0.2 (see U10).
- Duplicate MVP-spec files and an unrelated QR image at the repo root were removed.

### Test coverage added
- Test for the document-upload `audit_log` row. Found that Bun's SQL client returns `jsonb` columns as strings.

### Ingestion evaluation tooling (built, not yet run)
- `apps/api/src/scripts/generateSampleDocs.ts` (9 synthetic single-page PDFs, `pdf-lib` dev dependency) and `evalIngestion.ts` (runs the real OCR → extraction → persistence pipeline, reports per-document `ocr_status`, `extraction_status`, fact, `extraction_uncertain` and `needs_manual_date` counts). Run with `bun run eval:generate-samples` / `bun run eval:ingestion` from the repo root.

### Backlog items C4–C7 (migration 003)
- **C4:** undated candidates are persisted with `as_of_date` NULL and `facts.needs_manual_date`, never dropped; DB check `no_signoff_while_undated`.
- **C5:** all inserts for a document run in one transaction.
- **C6:** extraction uses `Promise.allSettled`; it now throws when a field-type call failed and nothing survived (so a failure is not shown as "no facts").
- **C7:** `documents.extraction_status` (`pending`/`done`/`failed`) is set after every run.
- LLM-supplied dates are validated as real ISO dates or treated as unknown (previously an unvalidated string could be misparsed).

### Extraction Review screen (staff)
- **API:** `GET /documents/:id/facts` and `PATCH /facts/:id` (value, marker mapping, as-of date; one transaction with row locks; audit-logged; 409 on signed-off facts per Invariants §2).
- **Web:** `FactCard` and `ExtractionReview` screens at `#/documents/:id/review`, a "Review extraction" button on Upload, and API client methods. Handles marker mapping, "Add and map" for custom markers, per-fact date entry, a single "apply date to all" form when every fact is undated, and distinct messages for OCR-not-done, extraction failed/pending, and no facts.
- **Process:** every task was reviewed; reviews found and fixed real issues (a lock race in PATCH, duplicate custom markers on partial failure, stale value drafts, a swallowed bulk-date error, cross-document stale responses). A final whole-branch review found no critical issues; its two important items were fixed.
- **Verification:** 76 automated tests, 22 real-HTTP checks (auth, roles, CORS, validation, state rules, audit rows), and a browser walkthrough of every screen state.

## 2. Remaining tasks

### A. Waiting on you (cannot be done without your input or credentials)
| # | Task | Why / notes |
| --- | --- | --- |
| U1 | Add `OCR_PROVIDER=google_document_ai`, `GOOGLE_DOCUMENT_AI_PROJECT_ID` / `_LOCATION` / `_PROCESSOR_ID` / `_CREDENTIALS_JSON`, and `EXTRACTION_PROVIDER=anthropic` to `.env`, then run `bun run eval:ingestion` | The eval is built and verified to fail cleanly at provider setup; no results exist yet. `.env` also holds an unused `OCR_API_KEY` to remove. AWS Textract was dropped as the comparison vendor (credentials never became available); `apps/api/src/services/ocr/awsTextract.ts` is left in place, unused. |
| U2 | Choose the default OCR provider | Deliberately deferred until the comparison exists. Only Google is being set up; Azure would need its own credentials for a real comparison. |
| U3 | Confirm a Data Processing Agreement with Anthropic (and decide whether Azure/Google need one) | Required before any real patient data reaches the pipeline. Synthetic data is unaffected. |
| U4 | Provide de-identified scanned or photographed documents | The Blueprint M2 item "test against realistic scanned paper" is still open; current samples are clean PDFs. |
| U5 | Get the oncologist to approve the real controlled marker list (C8) | `CONTROLLED_MARKERS` in `packages/shared/src/markers.ts` is a placeholder. |
| U6 | Product decisions: (a) add a `partial` extraction status (E6)? (b) should "apply date" mark facts `staff_corrected` when no value was reviewed? (c) should value edits on `not_assessed` / `not_applicable` / `conflicting_sources` facts be allowed? (d) confirm `no_signoff_while_undated` matches your intent | (a) a partial field-type failure with surviving results still ends as `done`. (b)/(c) decide before M3 treats `staff_corrected` as "reviewed" and before the Snapshot is built. |
| U7 | Clinical review of the review-screen wording ("Needs review", "Value found", "saving confirms it") | Needs an oncologist's judgment. |
| U8 | Decide whether to push/merge to a shared remote | There is no remote configured. |
| U9 | Apply migration 003 to any other database you use; decide on a migration runner | Migrations are applied by hand (compose init mounts only cover fresh databases). |
| U10 | ~~Decide whether to bump `typescript` 5.9.3 → 7.0.2~~ | Done — bumped to 7.0.2 as a root devDependency (was an unused `^5` peerDependency). Required one fix: an ambient `*.css` module declaration (`apps/web/src/css.d.ts`) for TS7's new `TS2882` side-effect-import check. |
| U11 | ~~Regenerate or retire `docs/m2-tracker.xlsx`~~ | Done — retired (`git rm`); superseded by the Decisions Log doc (link pending — not found in this repo; needs the doc's URL to add to the README). |

### B. Engineering tasks
| # | Task | Priority | Reference |
| --- | --- | --- | --- |
| D1 | Fix the browser bug in `apps/web/src/api/client.ts:3` (`process.env.OPD_API_URL` throws in the browser, so the app renders only an error overlay). Do not inline all env vars, which would leak secrets into the bundle | **High** | E1 (existing M1 bug) |
| D2 | Verify the two untested UI paths: Upload → "Review extraction" (needs a real OCR-complete upload) and the oncologist role in the browser | Medium | E-verification |
| D3 | Stable card ordering on the review screen (facts have no creation timestamp; cards jump after marker mapping) | Low | E2 |
| D4 | Disable/hide correction controls on oncologist-signed-off facts | Low | E3 (sign-off UI is M3) |
| D5 | Cosmetics: duplicate "CEA" headings, "Save value" button wrapping | Low | E4 |
| D6 | Write `extraction_status='done'` inside the persist transaction (a failing status update after commit would show real facts as "extraction failed") | Low | E5 |
| D7 | Add HTTP-level tests for route registration and role guards on the two new routes; add a test proving `normalizeAsOfDate` is wired into candidate conversion | Low | E5 |
| D8 | Replace `SELECT *` documents in `GET /documents/:id/facts` with explicit columns (currently exposes `file_ref`) | Low | E5 |
| D9 | Extraction retry action and a stored failure reason (`extraction_error`) | Medium | C7 residual |
| D10 | Move OCR + extraction off the upload request into a background job | Medium | C1 |
| D11 | ~~Multi-page PDFs for AWS Textract (async API + S3) if AWS becomes the default provider~~ | Moot | AWS Textract is no longer the comparison vendor (see U1); `googleDocumentAi.ts` handles multi-page documents natively. |
| D12 | Extend eval samples with degraded/photographed images | Low | eval tooling |
| D13 | Minor deferred nits (label `htmlFor`, `onChanged` error wording, unit shown with null value, matcher trailing slash, Back button `type`, audit snapshots storing ISO timestamps, year/length caps) | Low | E5 |

### C. Next milestone
- **M3, Review & Sign-off (Blueprint):** sign-off and reopen endpoints, audit logging for them, coverage-status correction transitions, and the sign-off UI on the Snapshot screen. `PATCH /facts/:id` already exists from this work. The sign-off UI must handle facts that cannot be signed off because they have no as-of date, and M4/M7 delta and conflict logic must tolerate `as_of_date` being null.
