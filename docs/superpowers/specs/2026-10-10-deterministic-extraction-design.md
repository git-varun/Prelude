# Deterministic document extraction — design

Date: 2026-10-10. Status: draft for review. Builds on `2026-10-10-extraction-eval-harness-design.md` (the harness measures this work).

## Goal

Turn an uploaded lab, radiology or prescription document into structured data with the **fewest OCR pages and LLM calls that keep accuracy**, and extract more than test rows: lab, dates, patient identity (matched against the patient record), and keywords. Today every document is OCR'd in full and sent whole to an LLM (1–2 calls). The Gemini baseline on the real reports (harness, 2026-10-10) showed 65–95% recall that varied run to run, silent empty results (`{"candidates": []}` on a 58-fact report), and uninformative confidence (correct 1.00 vs incorrect 0.98).

Evidence the approach is viable: a throwaway ~50-line rule parser (no OCR, no LLM, no tuning) scored 90.4% recall, 92.4% precision, 100% value accuracy on 94 hand-keyed facts from 6 real reports. Misses were dash-formatted results (`Neutrophils - 74%`), textual values (`3-4 /hpf`), a letter-spaced date label, and unit-less rows. Sample is small and the parser was written after reading those documents; unseen labs are the real test.

## Non-goals

- Replacing human verification: facts stay `verification_state = 'unverified'` until clinician sign-off, as today.
- LOINC coding, new patient columns (age/sex/DOB), a Python OCR/table service (Docling, PaddleOCR, Surya).
- Changing the existing LLM extractors; they remain as the fallback tier.

## Principles

1. **Cheapest tier that passes its checks wins**; a tier that cannot pass escalates, never guesses.
2. **A wrong value is worse than a missing one.** Unplaced content is counted and flagged, never dropped or invented.
3. **Confidence comes from structure and checks**, not from a model's self-report.
4. **Provenance by construction:** snippets are the parsed source line, so they always verify against the stored page text (today 8% fail).

## Tier ladder

| Tier | When | Cost |
|---|---|---|
| T0 text layer | page has an embedded text layer (all 9 real PDFs) | no OCR, no LLM |
| T1 rule parser | rows/headers that match known line shapes | no LLM |
| T2 OCR | only pages without a text layer (scans, images) | Azure layout, per page |
| T3 residual LLM | only unplaced numeric lines + narrative text, one batched call per document | small prompt |
| T4 full-document LLM | layout unfamiliar (unplaced lines > `RESIDUAL_MAX_LINES`, default 60) or T3 unavailable | today's behaviour |

Routing is **per page**: a mixed document OCRs only its image pages. A page is "text layer" when it has at least `TEXT_LAYER_MIN_CHARS` (default 200) extracted characters, else OCR.

## Components (`apps/api/src/services/extraction/deterministic/`)

All pure functions over a common `Line { text, cells: { text, x0?, x1? }[], page, ocrConfidence? }`. When geometry is absent (harness fixtures, plain OCR text), cells come from splitting on 2+ spaces, so the parser is testable without the PDF library.

- `input.ts` — per-page source choice. Text layer via `pdfjs-dist` (word positions rebuild columns); images/scanned pages via the Azure layout model (switch from `prebuilt-read`; its table cells provide the grid). Produces the `OcrResult` we already store, so `SourceView` highlighting keeps working (page text = joined line text).
- `header.ts` — lab name/centre, referring doctor, collected/received/reported dates, patient name, lab patient ID, age/sex. Label dictionary matched on whitespace-stripped text (handles `S ample C oll. D ate`). Date formats: `dd/Mon/yyyy`, `dd-Mon-yy`, `dd/mm/yyyy`, `dd.mm.yyyy`.
- `rows.ts` — result rows: label (joining wrapped label lines), value (numeric, `<`/`>`, `a-b` counts, qualitative terms such as `NEGATIVE`), unit, reference range, printed flag (H/L), section/panel from section headers. Handles `Label - value%` and label+value merged in one cell. Stops at boilerplate/notes.
- `resolve.ts` — canonical test via alias groups (promoted from `eval/aliases.ts` into `src`, merged with `MARKER_REGISTRY` aliases so tracked-marker matching and general labs share one table; free vs total T3/T4 stay separate) and unit equivalence (promoted from `eval/score.ts`).
- `validate.ts` — free checks, per row and per document (see below).
- `accounting.ts` — classifies every line as row / header / boilerplate / narrative / **unplaced-numeric**; reports coverage.
- `identity.ts` — name normalisation and tiered match (see below).
- `keywords.ts` — tags and classification (see below).
- `residual.ts` — T3 LLM call and T4 fallback selection; validates every LLM snippet is verbatim in the lines it was given, else drops it.
- `pipeline.ts` — orchestrates tiers; returns `ExtractionResult` (existing interface) plus `DocumentMetadata`. The existing `ExtractionProvider` (Anthropic/Gemini) is reused for T3/T4.

## Identity match

Normalise both names: lowercase, strip titles (Mr, Mrs, Ms, Dr, Shri, Smt, Master, Baby), `s/o`/`w/o`/`d/o` suffixes, punctuation, extra spaces; tokenise.

- **matched:** token sets equal, or all tokens of the shorter name (≥2 tokens) appear in the longer.
- **partial:** shares the first token, or one side is a single token present in the other, or matches by initials (`V. Upadhyay`); fuzzy token match (Jaro-Winkler ≥ 0.9) for transliteration variants. Accepted with a warning.
- **mismatch:** none of the above. Facts from the document are **held**: persisted but excluded from the snapshot until staff confirm (`confirmed`) or reject.
- **unknown:** no name on the report or `patients.name` is null. No hold.

`documents.identity_status` stores the result. Every reader of facts for snapshots (`services/facts.ts`, `services/rules.ts`, `routes/patients.ts`) must exclude facts whose document is `mismatch` (to enumerate in the plan; a test per reader).

## Keywords and classification

Dictionary-driven from section headers, panel titles, resolved test canon names, lab name, and impression terms. Outputs: `keywords text[]` (searchable tags such as `cbc`, `thyroid`, `hba1c`, `chest x-ray`, lab name), a suggested `document_type` and imaging modality (rules: many unit-bearing rows → blood; `IMPRESSION`/`FINDINGS`/modality words with few numeric rows → radiology; `Rx`/dose/frequency tokens → prescription), and **tracked-marker coverage** (which of the patient's tracked markers the report covers or lacks, by canonical name). The suggested type never overrides the uploader's choice; a disagreement is shown as a warning. Documents list filter: `?keyword=`.

## Free accuracy checks

Per row: value parses; unit is plausible for the test; printed H/L flag agrees with value vs range. Per document (when the rows exist): differential % sums to 100 ± 2; MCHC ≈ Hb/PCV×100 (± 1.5); MCV ≈ PCV/RBC×10 (± 3); MCH ≈ Hb/RBC×10 (± 1); absolute count ≈ TLC × % /100 (± 5%); BUN ≈ urea × 0.467 (± 3%); A/G ≈ albumin/globulin (± 0.05); indirect bilirubin ≈ total − direct (± 0.05). A failed check never auto-corrects: the row gets `check_failed`, lower confidence, and goes to review (and, if its page was OCR, is a candidate for re-read).

Row confidence (0–1): base by shape (value+unit+range 0.95; value+unit 0.85; value only 0.7), minus 0.2 per failed check, minimum OCR word confidence for OCR pages. Below `CONFIDENCE_REVIEW_MIN` (0.6) → `extraction_uncertain`.

## Data model changes (one migration)

- `documents`: `lab_name`, `collected_on`, `received_on`, `reported_on` (DATE), `patient_name_on_report`, `lab_patient_ref`, `identity_status` (enum: matched, partial, mismatch, unknown, confirmed, rejected), `keywords text[]` (GIN index), `ingestion_stats jsonb` (pages by source, LLM calls, unplaced-line count, tier reached, checks failed), `file_sha256`.
- `facts`: `printed_flag` text null, `parse_checks jsonb` null.
- `as_of_date` keeps current semantics: collection date, falling back to report date, else `needs_manual_date`.
- OCR reuse: if a document with the same `file_sha256` exists for the patient, reuse its stored OCR text (parsing is free).

## Learning loop (phase 4)

When T3 places a line the rules could not, record `(normalised label, suggested canonical, document)`; an admin approves suggestions into a DB-backed alias table loaded with the static one. LLM use then decays as aliases accumulate. Optional shadow run: `EXTRACTION_SHADOW_RATE` (default 0; e.g. 0.05 in production) runs the full LLM path on a sample and stores only agreement metrics in `ingestion_stats`, to catch unfamiliar layouts early.

## Integration

`runExtraction` (routes/documents.ts) calls `pipeline` instead of `getExtractionProvider().extractFacts` for the same `ExtractedFactCandidate` → `persistExtractedFacts` path. `extraction_status` semantics hold: `partial` when T3/T4 fails but rows were placed; `failed` only when nothing could be read. A feature flag `EXTRACTION_MODE=llm|deterministic` (default `llm` until gates pass) allows rollback.

## Evaluation and gates

The harness gains a `DeterministicExtractionProvider` adapter and extra metrics: header accuracy (lab, collected date, patient name), identity status, keywords, LLM calls per document, % documents with zero LLM calls, OCR pages per document. Answer keys gain an optional `header` block.

Go/no-go before `EXTRACTION_MODE=deterministic` becomes default (measured on real text-layer PDFs plus synthetic):
- recall ≥ 98%; value accuracy 100% on matched facts; no silent empty result (every document with numeric lines yields rows or a flagged unplaced count);
- at least 80% of documents need zero LLM calls;
- OCR pages = pages without a text layer only;
- identity: a deliberately wrong-patient fixture is held; correct-name fixtures (`Mr. VARUN` vs `Varun Upadhyay`) are accepted.

## Phases (each gets its own implementation plan)

1. **Core parser:** `input` (text layer), `header`, `rows`, `resolve`, `accounting`, harness adapter and metrics; promote alias/unit tables to `src`. Gate: recall/value targets on the harness.
2. **Metadata and safety:** `identity`, `validate`, migration, upload integration, snapshot exclusion for held documents.
3. **LLM tiers:** `residual` (T3), T4 fallback routing, Azure layout for scanned pages.
4. **Keywords, search and learning:** `keywords`, documents filter, tracked-marker coverage, alias suggestions, shadow sampling.

## Spikes before plan 1

- `pdfjs-dist` under Bun, in the API Docker image, on the real PDFs (positions, letter-spaced text).
- Azure layout model: table schema, word confidence, per-page price (US rate not confirmed).
- Wrapped labels and multi-column pages on the real fixtures.

## Risks

- Unseen lab layouts: land in unplaced → T3/T4, never silently wrong; the shadow run surfaces them.
- Scans/photos: accuracy depends on Azure; arithmetic checks and OCR confidence route risky digits to review.
- Name matching false accepts on common names: partial matches are warned, mismatches held; thresholds tuned on fixtures.
- Small evidence base (10 real reports: 9 PDFs and 1 image, one patient family): gates must be re-run as documents are added.
- Held documents change snapshot contents: each fact reader needs the exclusion and a test.

## Open items

- Confirm thresholds (`TEXT_LAYER_MIN_CHARS`, `RESIDUAL_MAX_LINES`, `CONFIDENCE_REVIEW_MIN`, check tolerances) against more documents.
- Who approves alias suggestions (admin role vs any clinician).
- Whether the documents list already exposes a filter endpoint to extend (check in plan 4).
