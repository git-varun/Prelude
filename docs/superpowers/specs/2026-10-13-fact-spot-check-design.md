# Fact spot-check: design

_2026-10-13. Status: awaiting review. Architectural path (new per-fact state, a new sign-off rule, a shared service refactor)._

## 1. Purpose

The person who uploads a document cross-checks every extracted fact against the place it was read from and marks it **Correct** or **Incorrect**. The marks serve two purposes:

1. **Gate.** A fact cannot be oncologist-signed-off until it has been checked.
2. **Measure.** The marks roll up into a staff-checked agreement figure per document and per lab, and export as ground-truth answer keys for the extraction eval (replacing the model-drafted keys for the photo fixtures).

What exists today: every fact stores a source snippet, page and location; the review screen shows them and links to the original (`SourceView`, which highlights the matching text); staff can edit a value, which sets `verification_state = 'staff_corrected'`. There is no way to say "I checked this and it is right", and no record of "I checked this and it is wrong".

## 2. Decisions taken in brainstorming

| Topic | Decision |
| --- | --- |
| Use of the mark | Both gate and measure |
| Scope | Every fact must be checked; the screen is risk-ordered |
| On Incorrect | Mark and correct in one step, with a required error type |
| Fact that should not exist (`not_in_document`, `wrong_patient`) | Excluded from every read, row kept with its mark and audit trail |
| Storage | Columns on `facts` plus `audit_log` rows (not a separate table) |
| Relation to `verification_state` | A separate axis. The frozen matrix in Invariants §2 gains no new state |

## 3. Data (migration 010)

New columns on `facts`:

- `check_state check_state NOT NULL DEFAULT 'unchecked'`, enum `unchecked | correct | incorrect`.
- `checked_by uuid REFERENCES users(id)`, `checked_at timestamptz`.
- `error_type check_error_type`, enum `value | unit | marker | date | range | not_in_document | wrong_patient`. A check constraint requires it to be set when `check_state = 'incorrect'` and NULL otherwise.
- `excluded_at timestamptz`. Set when `error_type` is `not_in_document` or `wrong_patient`. A check constraint ties it to those two values.

Backfill: every fact with `verification_state = 'oncologist_signed_off'` gets `check_state = 'correct'`, `checked_at = signed_off_at`, `checked_by` NULL. A user-made mark always has `checked_by` set, so a NULL `checked_by` means "backfilled". Other facts stay `unchecked`.

The migration is applied by hand (`psql ... -f`), and must be mounted in both compose files (the same step that was missed once for 009). `schema.sql` is updated to match.

## 4. API

### Shared correction service
The correction logic in `PATCH /facts/:id` (`routes/facts.ts`) moves into a service function used by both `PATCH` and the new check endpoint, including its row locks, the `needs_manual_date` recompute, the audit row and conflict detection. This refactor ships first, with the existing facts tests as its safety net.

### `POST /facts/:id/check` (staff and oncologist)
Body: `{ "result": "correct" }` or `{ "result": "incorrect", "error_type": "...", "correction": { ...same fields as PATCH } }`.

- One transaction. It takes the same `documents ... FOR UPDATE` lock as `PATCH`.
- `correct`: valid only when the fact is live, has a value (or is a non-marker fact type with content), and is not `needs_manual_date`. Otherwise 409 with the reason.
- `incorrect` with `value | unit | marker | date | range`: `correction` is required. It runs the shared correction service, then sets `check_state`, `checked_by`, `checked_at`, `error_type`. The service does not touch the check fields; the reset-to-`unchecked` described below belongs to the `PATCH` route, so the mark written here is never reset by its own correction.
- `incorrect` with `not_in_document | wrong_patient`: no correction. Sets `excluded_at`.
- 409 when the fact is `oncologist_signed_off` (it must be reopened first, as for `PATCH`) and when its document is held (`identity_status = 'mismatch'`).
- A mark can be changed until sign-off; each change writes an `audit_log` row (`check_fact`) with before and after. Changing an excluded fact's mark clears `excluded_at`.
- Any later `PATCH` of a checked fact resets `check_state` to `unchecked` and clears the mark fields, because its content changed since it was checked.

### Reads
- `GET /documents/:id/facts` returns the check fields on each fact and adds `check_summary: { total, correct, incorrect, unchecked }` (excluded facts count toward `incorrect`).
- Patient list and document list expose `unchecked_fact_count` for the "needs checking" badge.
- `LIVE_FACT_FILTER` gains `AND f.excluded_at IS NULL`, so an excluded fact never reaches the snapshot, timeline, trend, visit counts, needs-attention, conflict detection or either side of a conflict. Tests prove each of those reads.

### Gate
`POST /facts/:id/sign-off` additionally returns 409 unless `check_state IN ('correct','incorrect')` and `excluded_at IS NULL`. This is a new cross-cutting rule beside the conflict rule. Invariants §2 gets a paragraph, and the Decisions Log gets a matching entry.

### Measurement
- `GET /documents/:id/check-summary` and a per-lab roll-up (`documents.lab_name`; NULL labs group as "unknown"): facts checked, share marked correct, errors by type, who checked. The UI labels the figure **staff-checked agreement**, not accuracy.
- `bun run eval:export-checks` writes `apps/api/eval/fixtures/<slug>.expected.json` for documents whose facts are all checked. The extracted value is taken from the audit `before_value` of the correction when there was one, and the corrected value is the key. Exports are PHI and stay gitignored.

## 5. UI (extends `ExtractionReview`)

- Risk-ordered list: low confidence, failed parse checks, out of range, unmapped marker first; the rest by page.
- Each `FactCard` shows the extracted value next to its source snippet, with a "Show original" link to `SourceView` at the right page.
- Two buttons per card, **Correct** and **Incorrect**. Incorrect opens the existing correction form plus a required "what was wrong" choice. "Not in the document" and "wrong patient" skip the correction form and ask for confirmation, because the fact will be excluded.
- Progress "12 of 29 checked", and a banner when everything is checked. A "needs checking" badge on the document list.
- Keyboard: `c` correct, `x` incorrect, arrow keys move between cards. A mark can be changed until sign-off, so a mis-press is recoverable.
- Wording follows `wordingGuard.test.ts`.

## 6. Risks and limits

- **Work per upload.** Checking every fact is real effort; risk ordering and shortcuts reduce it but it is the main cost.
- **Existing facts cannot be signed off until checked**, apart from the backfilled signed-off ones.
- **Rubber-stamping.** If staff click Correct without looking, agreement is optimistic. Hence the label, the risk ordering, and the later option of planting known errors.
- **Not independent.** The uploader checks their own upload. That makes it a cross-check, not a second reviewer; the roll-up shows who checked.
- **Excluded facts have no UI undo beyond changing the mark** before sign-off; the audit log keeps the history.

## 7. Out of scope

Oncologist re-check of a staff mark, sampling instead of checking everything, drawn bounding boxes (only text highlighting exists), a stored extraction-time snapshot beyond the audit log.

## 8. Testing

- API: every transition and 409 above, the `PATCH` reset, the sign-off gate, audit rows, the backfill, concurrent check and `PATCH`, and `excluded_at` absent from every `LIVE_FACT_FILTER` read.
- Service: the extracted correction function keeps all existing facts and conflict tests green.
- Web: Playwright for the check flow, progress, shortcuts, the not-in-document confirmation, and no console errors.
- Export: a test that a fully checked synthetic document round-trips to a valid `ExpectedDocSchema` key.
- Done means `tsc --noEmit`, `bun test`, and `bun run --cwd apps/web test:e2e` all pass.

## 9. Order of work

1. Extract the shared correction service (no behavior change).
2. Migration 010, `schema.sql`, compose mounts.
3. Check endpoint, `LIVE_FACT_FILTER`, sign-off gate, reads.
4. Review-screen UI.
5. Roll-up and export.
6. Docs: Invariants §2 paragraph, Decisions Log entry, status doc.
