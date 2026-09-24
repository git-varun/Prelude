# M2 Backlog, Known Issues & Open Questions

Living tracker for the M2 (Ingestion) milestone, maintained alongside the
frozen spec docs (01–03) and `docs/02-implementation-blueprint.md`'s M2
checklist. Unlike those, **this document is not frozen** — update it as
items get resolved or new ones surface. Mirrors the pattern established in
`docs/m1-backlog.md` for M1.

Last updated: 2026-09-24, after implementing C4–C7 (undated-fact persistence,
transactional inserts, partial-failure-tolerant extraction, extraction_status).

---

## Known issues / gaps (not blocking, but real)

| # | Issue | Severity | Notes |
| --- | --- | --- | --- |
| C1 | OCR runs synchronously inside the `POST /patients/:id/documents` request (`documents.ts`'s `runOcr`), per docs/02 M2's "on upload, run OCR and update ocr_status" wording. There's no queue/background-job infrastructure yet, so a slow OCR call — especially Azure Document Intelligence's long-running poller — holds the HTTP response open for however long that call takes. | Medium | Fine at pilot volume/latency tolerance, but will need to move to a background job (queue + polling or webhook) before this scales past occasional single-document uploads, and especially before multi-page documents are common (see C2). Extraction + FACT persistence (`runExtraction`, added 2026-09-23) run in the same synchronous chain, compounding this — a document now blocks on OCR *and* up to 2 sequential LLM extraction calls before the upload response returns. |
| C2 | `AwsTextractProvider` (`apps/api/src/services/ocr/awsTextract.ts`) uses Textract's synchronous `DetectDocumentTextCommand`, which only supports single-page PDFs (plus JPEG/PNG/TIFF). A multi-page PDF upload with `OCR_PROVIDER=aws_textract` will get whatever error Textract itself returns for that case — not silently mishandled, but not handled either. | Medium | Multi-page PDF support requires Textract's async `StartDocumentTextDetection` + S3 flow (the input must live in S3, not be passed as inline bytes), a materially bigger integration than the sync path. Azure Document Intelligence's `prebuilt-read` model (the other adapter) already handles multi-page documents natively, so this is AWS-specific. This limitation also shaped the ingestion eval's sample set (see below) — every synthetic sample is single-page so both providers can be compared on equal footing. |
| C8 | The oncologist-approved controlled marker list is still a placeholder: `packages/shared/src/markers.ts`'s `CONTROLLED_MARKERS = ["CEA", "CA-125", "CA 19-9", "PSA"]` was seeded illustratively during scoping, never locked by an oncologist. | Low (product, not code) | Blocks nothing technically, but every "confident match" in the extraction prompt and every `tracked_marker_id` resolution is only as good as this list. Tracked in the blueprint's M5 backlog too. |

## Design decisions captured, not yet implemented

**Extraction Review (staff) screen** — brainstormed 2026-09-23, revised
2026-09-24 after C4 changed how undated facts are stored. Not yet built; this
is the agreed design so it isn't lost before an implementation plan is written:

- Undated facts already exist in the database (`facts.as_of_date IS NULL`,
  `facts.needs_manual_date = true`), so there is nothing to "resubmit" or
  replay. The earlier `documents.pending_extraction_candidates` /
  `POST /documents/:id/resubmit-date` design is **withdrawn**.
- Endpoints: `GET /documents/:id/facts` (staff+oncologist; the document row —
  including `extraction_status` and the derived `needs_manual_date` — plus its
  facts, joined to `tracked_markers.marker_name`); `PATCH /facts/:id`
  (staff+oncologist; body `{ value?, tracked_marker_id?, as_of_date? }`, at
  least one required). Any edit sets `verification_state='staff_corrected'` and
  `corrected_by`, and writes an `audit_log` row (`action='correct'`). A value
  edit on an `extraction_uncertain` fact auto-flips `coverage_status` to
  `value_found`; a `tracked_marker_id` edit clears `raw_marker_label`; an
  `as_of_date` edit sets `facts.needs_manual_date=false` and recomputes
  `documents.needs_manual_date` (true iff any sibling fact still needs one).
- Per-fact date entry: each fact with `needs_manual_date` shows its own date
  input in the review list (covers a single undated fact in an otherwise-dated
  document as well as a fully undated document). Undated facts can be
  corrected but never signed off — enforced in the database by
  `no_signoff_while_undated`, so the sign-off UI (M3) must surface that
  constraint rather than assume any fact is signable.
- Correction scope otherwise value-only; unit/reference_range/coverage_status
  direct edits were decided against for now (YAGNI).
- Adding a custom marker reuses the existing `POST /patients/:id/markers`
  (`api.addMarker`), then PATCHes the fact with the new marker's id.
- If `extraction_status='failed'`, the screen should say the document was
  never analyzed (as opposed to "nothing found") and, eventually, offer a
  retry — the retry action itself is out of scope until designed.
- Frontend: `apps/web/src/screens/ExtractionReview.tsx`, hash route
  `/documents/:id/review`, following existing screen conventions
  (`apps/web/src/api/client.ts` fetch wrapper, plain `useState` forms).
  Sign-off stays oncologist-only and out of scope here.

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
