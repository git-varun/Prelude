# M2 Backlog, Known Issues & Open Questions

Living tracker for the M2 (Ingestion) milestone, maintained alongside the
frozen spec docs (01–03) and `docs/02-implementation-blueprint.md`'s M2
checklist. Unlike those, **this document is not frozen** — update it as
items get resolved or new ones surface. Mirrors the pattern established in
`docs/m1-backlog.md` for M1.

Last updated: 2026-09-23, after wiring extraction + FACT persistence.

---

## Known issues / gaps (not blocking, but real)

| # | Issue | Severity | Notes |
| --- | --- | --- | --- |
| C1 | OCR runs synchronously inside the `POST /patients/:id/documents` request (`documents.ts`'s `runOcr`), per docs/02 M2's "on upload, run OCR and update ocr_status" wording. There's no queue/background-job infrastructure yet, so a slow OCR call — especially Azure Document Intelligence's long-running poller — holds the HTTP response open for however long that call takes. | Medium | Fine at pilot volume/latency tolerance, but will need to move to a background job (queue + polling or webhook) before this scales past occasional single-document uploads, and especially before multi-page documents are common (see C2). Extraction + FACT persistence (`runExtraction`, added 2026-09-23) run in the same synchronous chain, compounding this — a document now blocks on OCR *and* up to 2 sequential LLM extraction calls before the upload response returns. |
| C2 | `AwsTextractProvider` (`apps/api/src/services/ocr/awsTextract.ts`) uses Textract's synchronous `DetectDocumentTextCommand`, which only supports single-page PDFs (plus JPEG/PNG/TIFF). A multi-page PDF upload with `OCR_PROVIDER=aws_textract` will get whatever error Textract itself returns for that case — not silently mishandled, but not handled either. | Medium | Multi-page PDF support requires Textract's async `StartDocumentTextDetection` + S3 flow (the input must live in S3, not be passed as inline bytes), a materially bigger integration than the sync path. Azure Document Intelligence's `prebuilt-read` model (the other adapter) already handles multi-page documents natively, so this is AWS-specific. |
| C4 | A document whose extraction produces *some* dated and *some* undated candidates persists the dated ones and silently drops the undated ones (`facts.ts`'s `persistExtractedFacts`, logged via `console.warn` only) — `documents.needs_manual_date` is **not** set in this case, since that flag's documented trigger ("no extractable as_of_date anywhere in its facts") is specifically whole-document. | Medium | Was a judgment call, not a specified behavior — the original ask only defined the all-undated case. Dropped candidates aren't recoverable once dropped (no holding area for individual undated facts within an otherwise-persisted batch). Worth deciding: hold individual facts too (needs per-fact pending state, not just per-document), or is silent-drop-with-log acceptable at pilot scale? |

## Resolved (2026-09-23)

| # | Item | Resolution |
| --- | --- | --- |
| C3 | Extraction ran but its output went nowhere (logged only, per the original scoping note in this doc). | `apps/api/src/services/facts.ts`'s `persistExtractedFacts` now persists `ExtractedFactCandidate[]` as `FACT` rows: `tracked_marker_id` resolved against the patient's existing `TRACKED_MARKER` rows (confident match) or `raw_marker_label` + forced `extraction_uncertain` (no match); `source_page`/`source_location`/`source_snippet` copied through as-is; `verification_state` hardcoded `unverified`; `as_of_date` never fabricated — a document with no dated candidates at all is held via the new `documents.needs_manual_date` column (migration `002_extraction_columns.sql`) instead. One `audit_log` row per created fact, plus one for the document upload itself, both attributed to the uploading user. |
