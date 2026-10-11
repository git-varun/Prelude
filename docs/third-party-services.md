# Third-Party Services

Living inventory of every external service/vendor this project talks to (or
is configured to talk to). Unlike the frozen spec docs (01–03), **this
document is not frozen** — update it whenever a provider is added, swapped,
or its config changes. Companion to `docs/m1-backlog.md` / `docs/m2-backlog.md`.

Last updated: 2026-10-02.

| Service | Purpose | Selected via | Required env vars | Client library | Free tier? | DPA status |
| --- | --- | --- | --- | --- | --- | --- |
| PostgreSQL | Primary datastore (patients, visits, documents, facts, tracked_markers, audit_log, users, sessions) | `DATABASE_URL` | `DATABASE_URL` | Bun's built-in `SQL` (`apps/api/src/db/client.ts`) — not `pg`/`postgres.js`, per project convention | N/A (self-hosted, `docker-compose` for local per `docs/02-implementation-blueprint.md` Q2) | N/A — self-hosted, no vendor data-sharing |
| Azure AI Document Intelligence | OCR provider option (`prebuilt-read` model; the layout/table model is planned for scans, see `docs/extraction-pipeline-status.md` phase 3) | `OCR_PROVIDER=azure_doc_intelligence` | `AZURE_DOC_INTELLIGENCE_ENDPOINT`, `AZURE_DOC_INTELLIGENCE_KEY` | `@azure-rest/ai-document-intelligence`, `@azure/core-auth` | Yes — F0 tier, 500 pages/month, ongoing (not time-limited), 1 free instance per subscription | Not yet confirmed (blocks real patient data, not synthetic use — see Open Items below) |
| Google Document AI | OCR provider option (Document AI OCR processor) | `OCR_PROVIDER=google_document_ai` | `GOOGLE_DOCUMENT_AI_PROJECT_ID`, `GOOGLE_DOCUMENT_AI_LOCATION`, `GOOGLE_DOCUMENT_AI_PROCESSOR_ID`, `GOOGLE_DOCUMENT_AI_CREDENTIALS_JSON` | `@google-cloud/documentai` | First 1,000 OCR pages free per Google's pricing table (recurring monthly vs. one-time not confirmed here); new GCP customers separately get $300 credit for 90 days | Not yet confirmed (same caveat as above) |
| Anthropic API (Claude) | LLM fact extraction from OCR'd text (`services/extraction/anthropicExtraction.ts`), default model `claude-sonnet-5-5`, overridable with `EXTRACTION_MODEL` | `EXTRACTION_PROVIDER=anthropic` | `LLM_API_KEY` | `@anthropic-ai/sdk` | No published free tier; pay-as-you-go | **Not yet confirmed — explicit open pre-launch item, see below** |
| Google Gemini API | **Pilot-testing only** extraction adapter (`services/extraction/geminiExtraction.ts`, default model `gemini-flash-lite-latest` via `GEMINI_MODEL`); the live server is currently set to it | `EXTRACTION_PROVIDER=gemini` + `GEMINI_PILOT_TESTING_ONLY=true` | `GEMINI_API_KEY`, `GEMINI_PILOT_TESTING_ONLY` | `@google/genai` | Free tier is rate-limited (15 requests/minute) | **Never for real patient data** (Decisions Log); scoped to the developer's own documents. Switch back to `anthropic` before real patient use |
| pdfjs-dist (open source, runs locally) | Reads the text layer and word positions of born-digital PDFs for the rule-based extractor (`services/extraction/deterministic/textLayer.ts`) | always (library) | none | `pdfjs-dist@4.10.38` | N/A (open source) | N/A — no data leaves the server |
| Local filesystem | Object storage for uploaded documents + OCR text (dev/pilot; abstracted behind `file_ref` so swapping to S3-compatible storage later is config-only) | `OBJECT_STORAGE_DRIVER=local` | `OBJECT_STORAGE_LOCAL_PATH` | `Bun.file`/`Bun.write` (`apps/api/src/services/storage.ts`) | N/A (local disk) | N/A |

## Only the selected provider's credentials are required at runtime

`EXTRACTION_MODE` (`llm` default | `deterministic`) is a separate switch: `deterministic` parses text-layer PDFs with rules and falls back to the configured LLM provider, so the LLM credentials are still needed for the fallback. It is off in production.

`OCR_PROVIDER` and `EXTRACTION_PROVIDER` each select one adapter; the other
adapter's env vars aren't read. See `.env.example` (root) for the full list
and `apps/api/src/services/providerFactory.ts` for the selection logic
(memoized per-process — changing `OCR_PROVIDER` requires a fresh process,
not just a re-read of `process.env`).

## Open items

- **No DPA confirmed yet with the LLM vendor (Anthropic)** — per the frozen
  spec (`docs/01-mvp-specification (1).md` lines 341/353/447/460) and
  `docs/02-implementation-blueprint.md` (lines 48/268), this must close
  before any **real** patient data reaches the extraction pipeline. Does not
  block synthetic/de-identified data use (e.g. the ingestion eval).
- **No DPA status tracked for the OCR vendors** (Azure/Google) — the frozen
  spec's DPA language is Anthropic-specific; worth explicitly confirming
  whether Azure/Google also need one before real patient documents are OCR'd
  through them (their standard enterprise agreements may already cover
  this, but that hasn't been confirmed here).
- **Neither OCR provider's credentials are currently in `.env`** — as of
  this update, `OCR_PROVIDER`/`EXTRACTION_PROVIDER` are both unset, so
  neither provider path can construct successfully. See
  `docs/m2-backlog.md`'s "Resolved" section for the ingestion eval tooling
  waiting on these.
