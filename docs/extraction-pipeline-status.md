# Extraction Pipeline: Work Done and Remaining Tasks

_As of 2026-10-12. Production runs `main` at `33f9199` with `EXTRACTION_MODE` unset (today's LLM extraction); everything below is merged and pushed._

**In one paragraph.** Extraction accuracy was unmeasured and the LLM path was unreliable (silent empty results, run-to-run swings, uninformative confidence). We built a harness that scores extraction against hand-checked answer keys, then a rule-based parser that reads text-layer PDFs with no OCR and no LLM (100% recall and precision on the 10 real reports we have, header fields included). Phase 2 wrapped it in patient-safety controls: a patient-identity check that holds a wrong-patient document out of every read, free arithmetic checks, new database columns, an `EXTRACTION_MODE` flag (default `llm`), upload integration with an LLM fallback, and a confirm/reject endpoint. Production has the code and migrations but the new mode is **off**, and it must stay off until the three blockers in section 4 are closed.

Design and plans: `docs/superpowers/specs/2026-10-10-extraction-eval-harness-design.md`, `docs/superpowers/specs/2026-10-10-deterministic-extraction-design.md`, and the plans under `docs/superpowers/plans/` (eval harness, deterministic extraction phases 1 and 2). Product decisions live in the [Decisions Log](https://claude.ai/code/artifact/aeadec59-b7b6-4c12-ba6c-d843652a9ca5) ("Extraction pipeline" section).

---

## 1. Work done

### A. Accuracy eval harness (`apps/api/eval/`)
- `bun run eval:extraction` scores an extraction provider against answer keys: recall, precision, value/unit/range/date accuracy, snippet verification, confidence calibration, header accuracy, recall by source (real / synthetic) and precision by field type. `EVAL_PROVIDER=deterministic` runs the rule-based parser locally with no keys and no network; `EVAL_DELAY_MS` / `EVAL_RETRIES` pace rate-limited providers.
- `bun run eval:fixtures` builds fixtures from `docs/reports/` (PDFs via `pdftotext`; images via the configured OCR provider). `bun run eval:synthetic` writes PHI-free reports in three lab styles plus a radiology and a prescription document, with exact answer keys.
- Scoring tolerates the same test under different labels (`aliases.ts`: free vs total T3/T4 kept separate) and unit spellings (`10^3/µL` = `thou/µL` = `10^9/L`, `µIU/mL` = `uIU/ml`).
- **Real reports, answer keys and results are PHI**: `docs/reports/`, `apps/api/eval/fixtures/` and `apps/api/eval/results/` are gitignored. Never commit them; committed tests use synthetic data only.
- **Baseline of the old path** (production container, Gemini + Azure OCR, 2026-10-10): real-report recall 94.6% on one run and 65.2% on the next; a 58-fact report returned a clean `{"candidates": []}`; confidence carried no signal (correct 1.00, incorrect 0.98); the reference-range call produced only noise.

### B. Deterministic parser, phase 1 (`apps/api/src/services/extraction/deterministic/`)
- Text layer via `pdfjs-dist` (word positions rebuild columns; handles letter-spaced text and offset baselines), `header.ts` (lab, collected/received/reported dates, patient name, lab patient ID, age/sex, referring doctor), `rows.ts` (sections, wrapped labels, `Label - 74%`, counts, qualitative values, inline rows), alias and unit tables promoted into `src`, and a provider adapter for the harness.
- Result on the real reports (10 reports: 9 PDFs + 1 image): **recall 100%, precision 100%, value/unit/date accuracy 100%, 26/26 header fields**. Rows the parser cannot place are counted as unplaced, never dropped; snippets are verbatim source lines (100% verify).
- Phase 1 covers blood documents only; radiology and prescriptions are reported as "not handled", never as empty.

### C. Phase 2: identity, checks, storage, upload (`merged to main`)
- **Identity (`identity.ts`)**: `matched` / `partial` / `mismatch` / `unknown`. A different surname is a mismatch; a first-name-only report is `partial`; relational markers (`S/O`, `C/O`, `son of`, OCR variants) are stripped; implausibly long names (field bleed) are held; fuzzy match is per token at JW ≥ 0.95. A mismatch holds the document.
- **Held documents**: facts are stored but excluded from every read (`LIVE_FACT_FILTER`: snapshot, timeline, trend, visit counts, needs-attention), from the other side of conflicts, and from conflict detection. `POST /documents/:id/identity` confirms or rejects; confirm runs conflict detection for its now-live facts; reject is permanent; both are audited.
- **Free checks (`validate.ts`)**: per-row (value parses, unit plausible for the test, printed H/L flag agrees) and per-document arithmetic (differential sums to 100, MCHC/MCV/MCH, absolute counts with unit conversion, BUN, A/G, indirect bilirubin). A failed check caps confidence at 0.6, below the 0.7 review threshold, so the row becomes `extraction_uncertain`; it never auto-corrects or drops a row.
- **Database (migration 009)**: `documents.lab_name`, `collected_on`, `received_on`, `reported_on`, `patient_name_on_report`, `lab_patient_ref`, `identity_status`, `file_sha256` (+ index on `(patient_id, file_sha256)`); `facts.printed_flag`, `parse_checks`.
- **`EXTRACTION_MODE=llm|deterministic`** (default and any other value = `llm`).
- **Upload**: every upload stores `file_sha256`; in deterministic mode OCR text is reused for the same patient and hash only; a deterministic pass with zero candidates, or with 3+ unplaced numeric lines making up more than 20% of the result, falls back to the LLM (keeping the deterministic header so the identity check still runs); if the fallback fails, the deterministic rows are kept and the gap is recorded as a failed field type.

### D. Reviews
Two independent fresh-context reviews (one per phase) found 7 Critical and 13 Important issues; all were fixed, most with a test shown to fail without the fix. Highlights: a wrong patient's name accepted through field bleed or a relative's name, held facts opening conflicts and leaking into the snapshot, a partial parse recorded as a complete "done", arithmetic checks that failed on correct values.

### E. Production release (2026-10-11)
Backup `s3://prelude-backups-036281891241/20261011_150834/` → migrations **008 and 009** applied by hand (production was on 007) → `infra/deploy.sh`. 36 documents / 79 facts / 11 patients intact, 0 documents held, `/api/health` 200, no API errors. `EXTRACTION_MODE` unset.

---

## 2. How to operate it

```bash
bun test apps/api/src/services apps/api/src/routes apps/api/eval   # needs Postgres (docker compose -f infra/docker-compose.yml up -d)
EVAL_PROVIDER=deterministic bun run eval:extraction                  # local, no keys; prints the three gates
bun run eval:fixtures && bun run eval:synthetic                      # rebuild fixtures (needs docs/reports/ and pdftotext)
```

- **Deploy order matters.** Migrations are applied by hand (`psql ... -f`), and `LIVE_FACT_FILTER` now reads `documents.identity_status`, so **apply 009 before deploying this code, in every mode**; `infra/deploy.sh` does not run migrations. Take a backup first (`infra/backup.sh`).
- Env: `EXTRACTION_MODE` (see `.env.example`), plus `EVAL_PROVIDER`, `EVAL_DELAY_MS`, `EVAL_RETRIES`, `TEXT_LAYER_MIN_CHARS` for tooling.

## 3. Safety rules now in force
1. A wrong value is worse than a missing one: unplaced numeric lines are counted, failed checks lower confidence, nothing is auto-corrected or silently dropped.
2. A deterministic pass that found nothing (or only part) is never recorded as a complete "done".
3. A name conflict is evidence of a different person and is held; only the absence of evidence is `partial` / `unknown`.
4. Held documents never reach any read, conflict or conflict-detection path.
5. OCR reuse is keyed on `(patient_id, file_sha256)`, never on the hash alone.
6. Confidence comes from parse structure and checks, not from a model's self-report.

## 4. Remaining work

### Blockers before `EXTRACTION_MODE=deterministic` in production
_B1 and B2 are built (held-documents screen); B3 and more real reports remain. A rejected document has no undo in the UI._
| # | Task | Why |
| --- | --- | --- |
| B1 ✅ done | A screen that lists documents held for identity (`identity_status = 'mismatch'`) and lets staff confirm/reject (`#/patients/:id/held`, badge on the patient list, banner on the snapshot and review page) | Today a held document is invisible except on its own review page; a legitimate name variant (`Mohd` / `Mohammed`, OCR errors in the name) would silently drop out of the snapshot. |
| B2 ✅ done | Show staff the `partial` identity status (second section on the held screen, banner on the review page) | Close first-name variants (`Amit` / `Amita`, `Kumar` / `Kumari`) are accepted as `partial`; nothing reads that status yet. |
| B3 | **Decision (oncologist partner):** the `Tg` (thyroglobulin) alias vs a lipid-panel `TG`; and whether sign-off of a held document's facts should be blocked | `matchMarker` is case-insensitive, so a `TG 150 mg/dL` row would canonicalise to Thyroglobulin when candidates are matched; sign-off of held facts is still allowed. |

### Phase 3: LLM tiers and scans
- Narrative tier: radiology impression, prescription regimen and smear remarks via one small batched LLM call (the parser reports these document types as "not handled" today).
- Azure **layout** model (currently `prebuilt-read`) so scans and photos get a table grid; per-page routing so only pages without a text layer are OCR'd. Confirm Azure's US per-page price.
- Replace the fallback's "LLM replaces the deterministic rows" with a merge if that proves too lossy.

### Phase 4: keywords and learning
- Keywords/tags and document search, suggested document type and imaging modality, tracked-marker coverage, `?keyword=` filter on the documents list.
- Alias suggestions: record what the LLM places, let an approver promote labels into a DB-backed alias table so LLM use decays; optional shadow LLM runs on a sample to catch new layouts.

### Data and evidence
- **More real reports.** The 100% was measured on the same 10 reports the parser was tuned against, with answer keys partly completed during implementation. Needed: other labs' layouts, older reports, a scan and a phone photo, a prescription, a tumour-marker report (the controlled marker list is not exercised by any current report).
- Re-run the gates (`recall ≥ 98%`, `value accuracy 100%`, `all-correct 100%`, at least 80% of documents needing zero LLM calls) whenever documents are added.

### Engineering follow-ups and deferred minors
- `infra/docker-compose.prod.yml` now mounts 009; consider a migration runner instead of manual `psql`.
- Any staff user (not only an oncologist) can confirm/reject a hold; confirm the policy.
- `TEXT_LAYER_MIN_CHARS` / `hasTextLayer` are not yet consumed by the upload path (phase 3 routing); `TEXT_LAYER_MIN_CHARS=abc` yields NaN.
- Units such as `gm%` and `mm/1st hr` are dropped; `NUM` accepts `10,1`; letter-spaced row labels keep inner spaces (`C EA`); header gaps (`Sample Collected On`, a print date taken as the collection date).
- Migration 009's `CREATE TYPE` / `ADD COLUMN` are not idempotent (same as earlier migrations).
- `routes/conflicts.ts` `factWithProvenance` is unfiltered (no conflict can reference a held fact now; a conflict created earlier would still expose it).
- Real-report details from before the scrub remain in earlier git history (a lab phone number, a sample barcode, a lab name/address, the developer's own first name); rewrite history if the repo is, or becomes, public.

### Process notes
- Two Claude sessions edited one worktree concurrently during phase 2; keep one session per worktree.
- The eval run on the server used Gemini (pilot, free tier: 15 requests/minute, hence `EVAL_DELAY_MS`). The server's Gemini use is scoped to the developer's own documents; real patient documents must not go to it (Decisions Log). That run sent the supplied reports through it, some belonging to another person; the developer reviewed this on 2026-10-12 and accepted it at this level.
