# M2 Backlog, Known Issues & Open Questions

Living tracker for the M2 (Ingestion) milestone, maintained alongside the
frozen spec docs (01–03) and `docs/02-implementation-blueprint.md`'s M2
checklist. Unlike those, **this document is not frozen** — update it as
items get resolved or new ones surface. Mirrors the pattern established in
`docs/m1-backlog.md` for M1.

Last updated: 2026-09-25, after the Extraction Review (staff) screen and its final fix wave (previously: C4–C7 —
undated-fact persistence, transactional inserts, partial-failure-tolerant extraction, extraction_status).

---

## Known issues / gaps (not blocking, but real)

| # | Issue | Severity | Notes |
| --- | --- | --- | --- |
| C1 | OCR runs synchronously inside the `POST /patients/:id/documents` request (`documents.ts`'s `runOcr`), per docs/02 M2's "on upload, run OCR and update ocr_status" wording. There's no queue/background-job infrastructure yet, so a slow OCR call — especially Azure Document Intelligence's long-running poller — holds the HTTP response open for however long that call takes. | Medium | Fine at pilot volume/latency tolerance, but will need to move to a background job (queue + polling or webhook) before this scales past occasional single-document uploads, and especially before multi-page documents are common (see C2). Extraction + FACT persistence (`runExtraction`, added 2026-09-23) run in the same synchronous chain, compounding this — a document now blocks on OCR *and* the per-field-type LLM extraction calls (run in parallel via `Promise.allSettled`, so the wait is the slowest call, not the sum) before the upload response returns. |
| C2 | `AwsTextractProvider` (`apps/api/src/services/ocr/awsTextract.ts`) uses Textract's synchronous `DetectDocumentTextCommand`, which only supports single-page PDFs (plus JPEG/PNG/TIFF). A multi-page PDF upload with `OCR_PROVIDER=aws_textract` will get whatever error Textract itself returns for that case — not silently mishandled, but not handled either. | Medium | Multi-page PDF support requires Textract's async `StartDocumentTextDetection` + S3 flow (the input must live in S3, not be passed as inline bytes), a materially bigger integration than the sync path. Azure Document Intelligence's `prebuilt-read` model (the other adapter) already handles multi-page documents natively, so this is AWS-specific. This limitation also shaped the ingestion eval's sample set (see below) — every synthetic sample is single-page so both providers can be compared on equal footing. |
| C8 | The oncologist-approved controlled marker list is still a placeholder: `packages/shared/src/markers.ts`'s `CONTROLLED_MARKERS = ["CEA", "CA-125", "CA 19-9", "PSA"]` was seeded illustratively during scoping, never locked by an oncologist. | Low (product, not code) | Blocks nothing technically, but every "confident match" in the extraction prompt and every `tracked_marker_id` resolution is only as good as this list. Tracked in the blueprint's M5 backlog too. |

## Open items from the Extraction Review build (2026-09-25)

| # | Item | Severity | Notes |
| --- | --- | --- | --- |
| E1 | **FIXED** (runtime `/config.json` + e2e smoke test). **Existing M1 bug:** `apps/web/src/api/client.ts:3` reads `process.env.OPD_API_URL`; in the browser this throws `process is not defined` under `bun apps/web/src/server.ts` (no `bunfig.toml`, so nothing inlines it), so the app renders only an error overlay. Present since commit `314b7c0` (M1). | High | Found only when the review screen was first driven in a real browser; tests and typecheck can't see it. All browser testing used a temporary hardcoded URL that was reverted. Needs a real fix (e.g. hardcode/inline a public URL, or configure Bun's `serve.static.env` for a `PUBLIC_` variable) — not inlining all env vars, which would leak secrets into the bundle. |
| E2 | Review cards reorder after a marker is mapped: `GET /documents/:id/facts` sorts by `source_page NULLS LAST, tracked_marker_name NULLS LAST, field_type, id`. | Low | The card you just acted on can jump to the top. Give facts a stable order (e.g. extraction order via a created-at/sequence column) — facts currently have no creation timestamp. |
| E3 | Oncologist-signed-off facts show editable inputs; the 409 message appears only after a save attempt. | Low | Disable/hide the correction controls when `verification_state='oncologist_signed_off'` (sign-off UI is M3). |
| E4 | Several cards can share the same heading (e.g. four "CEA" cards); "Save value" wraps to two lines. | Low | Cosmetic; distinguish cards by page/snippet or an index. |
| E5 | Deferred minors from the per-task reviews (bullets below). | Low | Triage before merge if desired. |
| E6 | **Resolved (2026-09-25).** Fix wave note: a *partial* field-type failure with surviving candidates ended as `extraction_status='done'` (C6 residual). LLM-provided `asOfDate` values are validated to real ISO `YYYY-MM-DD` or null (null becomes `needs_manual_date`). | Info | Resolved by migration `004_extraction_partial_status.sql` (adds `extraction_status='partial'` and `documents.extraction_error`) and `ExtractionProvider.extractFacts` now returning `{ candidates, failedFieldTypes, failureMessages }` without throwing on failed calls. `runExtraction` rule: **`done`** on zero failed field types (including a legitimate zero-candidate result); **`partial`** on failures + some candidates; **`failed`** on failures + zero candidates. This is deliberately *not* the literal `candidates.length === 0 → failed` rule, which would mark a document with nothing extractable as failed. `extraction_error` summarises the failed field types and messages for `partial`/`failed`. |

E5 deferred minors:
  - response read after commit in `patchFact`
  - audit snapshots store `as_of_date` as an ISO timestamp
  - value PATCH on `not_applicable`/`not_assessed`/`conflicting_sources` keeps that coverage and edits a value an open CONFLICT describes (product decision needed before the Snapshot)
  - the whole-document "apply date" marks every fact `staff_corrected` although no value was reviewed (decide before M3 treats `staff_corrected` as "reviewed")
  - `extraction_status='done'` is written outside the persist transaction, so a failing status UPDATE after commit would show real facts as "extraction failed"
  - no HTTP-level tests of route registration/authz for the two new routes
  - `GET /documents/:id/facts` returns `SELECT *` documents including `file_ref`
  - `bun.lock` top-level `tslib` moved 2.8.1 -> 1.14.1 via `pdf-lib`
  - label/layout nits in `FactCard`/`ExtractionReview`
  - commit ec6ee4e's trailer says Claude Haiku 4.5

## Resolved (2026-09-25): Extraction Review (staff) screen

Built as designed (2026-09-23, revised 2026-09-24) on branch `m2-extraction-review`:

- `GET /documents/:id/facts` (staff+oncologist): document + facts (dates as `YYYY-MM-DD`, marker name joined) + the patient's tracked markers.
- `PATCH /facts/:id` (staff+oncologist): body `{ value?, tracked_marker_id?, as_of_date? }`. One transaction; locks the fact and its document row (so concurrent date edits on sibling facts recompute `documents.needs_manual_date` correctly); any edit sets `staff_corrected` + `corrected_by` and writes an `audit_log` row (`action='correct'`, before/after); a value edit flips `extraction_uncertain` to `value_found`; a marker edit clears `raw_marker_label`; a date edit clears the fact's `needs_manual_date`. **409** on `oncologist_signed_off` facts (Invariants §2; the Blueprint's M3 line said 403 and was corrected).
- Web: hash route `#/documents/:id/review`, `ExtractionReview.tsx` + `FactCard.tsx`, and a "Review extraction" button on the Upload screen for OCR-done documents.
- Fixed design details: saving a value unchanged still confirms it (staff-corrected, uncertain → found); marker mapping alone doesn't change coverage; if **every** fact lacks a date the screen shows only one "apply date to all" form (sequential PATCHes; a partial failure stays visible with the count left undated), otherwise each undated card has its own date input; failed/pending extraction, zero facts and OCR-not-done each get a distinct message. Sign-off is out of scope; undated facts stay unsignable via `no_signoff_while_undated`.
- The withdrawn `pending_extraction_candidates` / `resubmit-date` design is not built (undated facts persist directly).
- Verification: `bun test` 73/73, `tsc` clean, 22 real-HTTP checks (auth, roles, CORS, validation, state rules, audit rows), and a Playwright walkthrough of every screen state including the bulk-failure path and a fast document switch (stale-load guard). Review found and fixed real issues along the way: a document-row lock race (PATCH), orphan/duplicate custom markers on partial "Add and map" failure, stale value drafts, a swallowed bulk-date error, and stale-document responses (ExtractionReview).
- Not verified: the Upload → "Review extraction" click path (needs an OCR-complete upload, i.e. real provider credentials) and the oncologist role in the browser.

## Resolved (2026-09-23)

| # | Item | Resolution |
| --- | --- | --- |
| C3 | Extraction ran but its output went nowhere (logged only, per the original scoping note in this doc). | `apps/api/src/services/facts.ts`'s `persistExtractedFacts` now persists `ExtractedFactCandidate[]` as `FACT` rows: `tracked_marker_id` resolved against the patient's existing `TRACKED_MARKER` rows (confident match) or `raw_marker_label` + forced `extraction_uncertain` (no match); `source_page`/`source_location`/`source_snippet` copied through as-is; `verification_state` hardcoded `unverified`; `as_of_date` never fabricated — a document with no dated candidates at all is held via the new `documents.needs_manual_date` column (migration `002_extraction_columns.sql`) instead. One `audit_log` row per created fact, plus one for the document upload itself, both attributed to the uploading user. |
| — | Per-fact `audit_log` row existed and was tested (`facts.test.ts`); the document-upload `audit_log` row (`documents.ts`, `action='upload'`, `entity_type='document'`) existed in code but had no test coverage. | Added `"uploadDocument writes an audit_log row for the upload"` to `apps/api/src/routes/documents.test.ts`. Also surfaced a Bun-specific gotcha while writing it: Bun's built-in `SQL` client (`apps/api/src/db/client.ts`) returns `jsonb` columns as raw JSON **strings**, not parsed objects — any test or code asserting on `audit_log.after_value`'s fields needs an explicit `JSON.parse` first. |
| — | No sample document set or eval tooling existed to compare `OCR_PROVIDER` options against real API behavior. | Added `apps/api/src/scripts/generateSampleDocs.ts` (9 synthetic single-page PDFs across blood/prescription/radiology, gitignored under `apps/api/.eval-samples/`) and `apps/api/src/scripts/evalIngestion.ts` (runs the real `getOcrProvider → getExtractionProvider → persistExtractedFacts` pipeline against them, using a throwaway patient/visit, printing per-document + total stats). Run via `bun run eval:generate-samples` / `bun run eval:ingestion` **from the repo root** — Bun's `.env` auto-load is cwd-based, not tree-walking, so running from `apps/api` directly misses the root `.env`. Added `pdf-lib` as an `apps/api` dev dependency to generate the PDFs. Provider selection intentionally deferred — eval hasn't been run yet (no OCR credentials configured as of this update). |
| C4 | Candidates with no `as_of_date` in an otherwise-dated document were silently dropped. | `persistExtractedFacts` no longer drops or holds anything: an undated candidate is persisted with `as_of_date` NULL and `facts.needs_manual_date = true`; `documents.needs_manual_date` is kept as a derived summary (true when any fact needs a date). This supersedes the whole-document hold described under C3 — those facts are now persisted rather than held. Migration `003_undated_facts_and_extraction_status.sql` makes `facts.as_of_date` nullable and adds the `no_signoff_while_undated` check so an undated fact can never be oncologist-signed-off. |
| C5 | Fact inserts had no transaction; a mid-loop failure left a partial set. | All inserts, audit rows and the `documents.needs_manual_date` update for one document run in a single `sql.begin` transaction; any failure rolls back everything and propagates (covered by a rollback test using a malformed `asOfDate`). |
| C6 | `Promise.all` across field-type LLM calls discarded successful calls when one failed. | `Promise.allSettled`: failures are logged and skipped, successes are kept. If **every** call fails it throws, so a total outage is not mistaken for an empty document. **Residual:** a *partial* failure (one field type failed, others succeeded) still ends with `extraction_status='done'` — the failed field type's facts are silently absent apart from a `console.error`. Distinguishing "done" from "done with gaps" needs a decision (e.g. a `partial` status). |
| C7 | `runExtraction` swallowed all failures into `console.error`. | New `documents.extraction_status` enum (`pending`/`done`/`failed`, migration 003). `runExtraction` (now exported, with an injectable provider for tests) sets `done` or `failed` after every run, including when `EXTRACTION_PROVIDER` is unset. It stays `pending` when OCR failed (extraction never ran) and for documents that predate the column. **Residual:** the failure reason is only in the log — there's no `extraction_error` column, and no retry mechanism yet. |
| — | Review finding: the same 10-column document `SELECT`/`RETURNING` list was duplicated 3× in `documents.ts`. | Replaced with `RETURNING *`/`SELECT *`, so new columns (like `extraction_status`) appear consistently. Side effect: the upload response now includes `needs_manual_date` and `extraction_status` on every path (the initial-insert path previously omitted `needs_manual_date`). |

**Operational notes (2026-09-24):** migrations are still applied by hand — `003`
was applied to the running dev DB with `docker exec -i opd_postgres psql ... <
003_...sql`, and is also mounted as an init script in `infra/docker-compose.yml`
for fresh databases (`schema.sql` is the base layer and is intentionally not
edited; the Blueprint's reference DDL was updated to the final state). The
`opd_postgres` container had also stopped (exited ~13h earlier) and had to be
restarted with `docker start opd_postgres` before tests could connect.
