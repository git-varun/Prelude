# OPD AI Snapshot Tool — Implementation Blueprint

2026-09-19 · @Someone

Build-ready companion to the frozen MVP Specification v1.1: repo scaffold, schema, API stubs, and a concrete task checklist per milestone (M1–M8), for the 2-person team building with Claude Code.

## Overview

This blueprint doesn't restate the MVP Specification v1.1 (personas, business rules, regulatory boundaries) — it translates the frozen decisions into things you can literally run: a repo layout, schema DDL, API stubs, and a per-milestone task list matching M1–M8. Build in milestone order; M1–M3 are the critical path (nothing else works without ingestion + review), M4–M7 can parallelize across the 2-person team once M3 is stable.

**How to use with Claude Code:** each milestone section ends with a checklist written as concrete, scoped tasks — paste one task at a time as a prompt, point Claude Code at the relevant scaffold file, and check it off. Don't paste a whole milestone at once; each task is sized to be one focused change.

## Repo Scaffold

```
/opd-snapshot
  /apps
    /web                      React + TypeScript frontend
      /src
        /screens               PatientList, PatientCreate, Upload, ExtractionReview,
                                Snapshot, SourceView, ConflictResolution, MarkerManagement
        /components
        /api                    typed fetch client for the backend
    /api                       Node.js + TypeScript backend
      /src
        /routes                 one file per resource: patients, visits, documents, facts, conflicts
        /services
          ocr.ts                 OCR provider client
          extraction.ts          LLM extraction client + prompt templates
          rules.ts               deterministic rules engine (reference-range, coverage_status, conflict detection, delta)
        /db
          schema.sql             see § Database Schema
          migrations/
        /middleware
          auth.ts
          roles.ts                staff / oncologist permission checks
  /packages
    /shared                     shared TS types: Patient, Visit, Document, Fact, Conflict, coverage/verification enums
  /infra                        deployment config (see frozen spec §14)
  /docs
```

**Setup tasks (do once, before M1):**

- Initialize monorepo (npm workspaces or similar) with `/apps/web`, `/apps/api`, `/packages/shared`
- Provision PostgreSQL (local + staging + production per frozen spec §14)
- Provision object storage bucket for documents/OCR text
- Register accounts/API keys for the chosen OCR service and LLM API; confirm a DPA exists with the LLM vendor before any real patient data touches it (frozen spec §12)

## Database Schema

Direct implementation of the frozen data model, including the v1.1 corrections (`coverage_status` five-state enum, `VISIT` entity, extended provenance fields).

```sql
CREATE TYPE user_role AS ENUM ('staff', 'oncologist');
CREATE TYPE document_type AS ENUM ('prescription', 'blood', 'radiology');
CREATE TYPE source_origin AS ENUM ('own_hospital', 'outside_paper', 'outside_cd', 'whatsapp_pdf');
CREATE TYPE ocr_status AS ENUM ('pending', 'done', 'failed');
CREATE TYPE extraction_status AS ENUM ('pending', 'done', 'failed');
CREATE TYPE field_type AS ENUM ('marker_value', 'reference_range', 'treatment_regimen', 'radiology_impression', 'disease_status_trend');
CREATE TYPE coverage_status AS ENUM ('value_found', 'not_assessed', 'not_found_in_document_set', 'extraction_uncertain', 'conflicting_sources', 'not_applicable');
CREATE TYPE verification_state AS ENUM ('unverified', 'staff_corrected', 'oncologist_signed_off', 'reopened_by_oncologist');
CREATE TYPE delta_status AS ENUM ('new', 'changed', 'unchanged', 'not_observed_in_current_document_set');
CREATE TYPE conflict_status AS ENUM ('open', 'annotated', 'resolved');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role user_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  cancer_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES users(id)
);

CREATE TABLE visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  visit_date DATE NOT NULL DEFAULT current_date
);

CREATE TABLE tracked_markers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  marker_name TEXT NOT NULL,
  is_custom BOOLEAN NOT NULL DEFAULT false,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by UUID NOT NULL REFERENCES users(id)
);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  visit_id UUID NOT NULL REFERENCES visits(id),
  file_ref TEXT NOT NULL,
  document_type document_type NOT NULL,
  source_origin source_origin NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ocr_status ocr_status NOT NULL DEFAULT 'pending',
  ocr_text_ref TEXT,
  needs_manual_date BOOLEAN NOT NULL DEFAULT false,  -- derived summary: any fact of this document needs a date
  extraction_status extraction_status NOT NULL DEFAULT 'pending'  -- outcome of the LLM extraction + persistence pass
);

CREATE TABLE facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  visit_id UUID NOT NULL REFERENCES visits(id),
  document_id UUID NOT NULL REFERENCES documents(id),
  tracked_marker_id UUID REFERENCES tracked_markers(id),
  raw_marker_label TEXT,      -- set when the extracted marker name has no confident tracked-marker match
  field_type field_type NOT NULL,
  value TEXT,
  unit TEXT,
  reference_range TEXT,
  as_of_date DATE,            -- NULL only while needs_manual_date; never fabricated
  needs_manual_date BOOLEAN NOT NULL DEFAULT false,
  coverage_status coverage_status NOT NULL DEFAULT 'not_assessed',
  verification_state verification_state NOT NULL DEFAULT 'unverified',
  delta_status delta_status,
  source_page INTEGER,
  source_location TEXT,       -- OCR line/char range or bounding box, nullable
  source_snippet TEXT,        -- nullable
  corrected_by UUID REFERENCES users(id),
  signed_off_by UUID REFERENCES users(id),
  signed_off_at TIMESTAMPTZ,
  reopened_by UUID REFERENCES users(id),
  reopened_at TIMESTAMPTZ,
  CONSTRAINT signed_off_requires_oncologist CHECK (
    verification_state != 'oncologist_signed_off' OR signed_off_by IS NOT NULL
  ),
  CONSTRAINT no_signoff_while_undated CHECK (
    verification_state != 'oncologist_signed_off' OR as_of_date IS NOT NULL
  )
);

CREATE TABLE conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id_a UUID NOT NULL REFERENCES facts(id),
  fact_id_b UUID NOT NULL REFERENCES facts(id),
  status conflict_status NOT NULL DEFAULT 'open',
  resolution_note TEXT,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,        -- 'upload' | 'correct' | 'sign_off' | 'reopen' | 'resolve_conflict' | 'delete'
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  before_value JSONB,
  after_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Note:** the `signed_off_requires_oncologist` check enforces the frozen spec's rule at the database layer, not just in application code — a fact can never reach `oncologist_signed_off` without a `signed_off_by` actor, closing off the "LLM sets its own trust state" failure mode structurally.

## API Route Stubs

Matches the frozen spec's endpoint table (§11) including the v1.1 additions (`POST /patients/:id/visits`, `POST /facts/:id/reopen`). Each stub throws `NotImplemented` — fill in per milestone.

```typescript
// apps/api/src/routes/patients.ts
router.post('/patients', requireRole(['staff', 'oncologist']), createPatient);
router.get('/patients/:id/snapshot', requireRole(['staff', 'oncologist']), getSnapshot);
router.post('/patients/:id/markers', requireRole(['staff', 'oncologist']), addMarker);
router.post('/patients/:id/visits', requireRole(['staff', 'oncologist']), createOrOpenVisit);
router.post('/patients/:id/documents', requireRole(['staff', 'oncologist']), uploadDocument); // requires visit_id in body
router.delete('/patients/:id', requireRole(['oncologist']), deletePatient);

// apps/api/src/routes/documents.ts
router.get('/documents/:id', requireRole(['staff', 'oncologist']), getDocument);

// apps/api/src/routes/facts.ts
router.patch('/facts/:id', requireRole(['staff', 'oncologist']), correctFact); // 403 if oncologist_signed_off and not reopened
router.post('/facts/:id/sign-off', requireRole(['oncologist']), signOffFact);
router.post('/facts/:id/reopen', requireRole(['oncologist']), reopenFact);

// apps/api/src/routes/conflicts.ts
router.post('/conflicts/:id/resolve', requireRole(['oncologist']), resolveConflict);
router.post('/conflicts/:id/annotate', requireRole(['staff', 'oncologist']), annotateConflict);
```

**Error handling** (per frozen spec §11): `400` malformed input · `403` role/permission violation · `404` unknown id · `409` conflict-state violation · `422` OCR/extraction failure (returned in body, upload still succeeds). Shared response shape: `{ error: string, message: string }`.

## M1 — Foundation

No dependencies — start here.

- [ ] Run the schema DDL against local/staging Postgres; verify the `signed_off_requires_oncologist` constraint rejects a direct insert
- [ ] Implement `users` table + auth (email/password or magic-link) and a `requireRole` middleware
- [ ] Implement `POST /patients` (create patient + `cancer_type`) and `POST /patients/:id/markers` (default marker set from a controlled list, plus custom-add)
- [ ] Implement `POST /patients/:id/visits` (create/open the current visit) — a visit groups the documents pushed for one OPD consult; keep this lightweight, no encounter-management logic
- [ ] Implement `POST /patients/:id/documents` requiring `visit_id`; store the file in object storage, set `ocr_status = pending`, manual `document_type`/`source_origin` tags from the upload form
- [ ] Build the Patient List, Patient Creation, and Document Upload screens
- [ ] Role-aware UI shell: hide oncologist-only actions (sign-off, resolve, delete, reopen) from staff accounts

## M2 — Ingestion (Feature 6)

Depends on M1.

- [x] Wire the OCR service client (`services/ocr.ts`); on upload, run OCR and update `ocr_status` to `done`/`failed`; capture page number and line/char location or bounding box where the provider supports it — never fabricate location data if unavailable
- [x] Wire the LLM extraction client (`services/extraction.ts`) with prompt templates per `field_type`; extraction never sets `verification_state` beyond `unverified` — the LLM cannot self-authorize trust
- [x] Implement the rules engine (`services/rules.ts`) for initial `coverage_status` assignment per the deterministic rules: no value → `not_assessed`; value found → `value_found`; source states test not performed → `not_applicable`; low-confidence/ambiguous → `extraction_uncertain`
- [x] Persist extracted facts with `source_page`/`source_location`/`source_snippet` populated where available, `NULL` otherwise — UI must show "source detail unavailable" rather than a broken link when these are null
- [ ] Test against real or realistic scanned/photographed paper, not just clean digital PDFs (this is the actual expected input mix for outside reports)
- [ ] Build the Extraction Review (staff) screen showing raw extracted text next to the structured fact for low-confidence cases

## M3 — Review & Sign-off

Depends on M2.

- [ ] Implement `PATCH /facts/:id`: allowed when `verification_state` is `unverified`, `staff_corrected`, or `reopened_by_oncologist`; return `403` if `oncologist_signed_off`
- [ ] Implement `POST /facts/:id/sign-off` (oncologist only): sets `verification_state = oncologist_signed_off`, `signed_off_by`, `signed_off_at`
- [ ] Implement `POST /facts/:id/reopen` (oncologist only): sets `verification_state = reopened_by_oncologist`; staff or the oncologist can then correct it, returning it to `oncologist_signed_off`
- [ ] Wire audit logging on every correct/sign-off/reopen action: actor, before/after value, timestamp
- [ ] Implement coverage-status correction transitions: `extraction_uncertain` → `value_found` when a verified value is supplied; `extraction_uncertain` → `not_assessed` when review confirms no usable value exists
- [ ] Build the sign-off UI affordance on the Snapshot screen (oncologist-only button, visually distinct per fact)

## M4 — Delta View (Feature 5)

Depends on M3 (needs ≥2 visits of signed-off facts).

- [ ] Implement delta computation: for each `FACT` in the current visit's document set, compare against the most recent prior `oncologist_signed_off` fact of the same `field_type`/`tracked_marker_id`, scoped **per patient**, not per timestamp
- [ ] Result mapping: no prior signed-off fact → `new`; value differs → `changed`; value matches → `unchanged`; previously-tracked field absent from current visit → `not_observed_in_current_document_set` (a coverage gap — never rendered as "this is now clinically absent")
- [ ] Confirm custom markers get normal delta computation on `tracked_marker_id` match — only cross-name semantic matching is unsupported
- [ ] Build the "Since Last Visit" section on the Snapshot screen; new patients (zero prior visits) show current values only, no delta section rendered
- [ ] Every fact display includes: value/state, `coverage_status` (clinician-readable, not raw enum), as-of date, `verification_state`, source link

## M5 — Markers & Reference Ranges (Feature 3, rescoped)

Depends on M2.

- [ ] Seed the controlled marker list (e.g., CEA, CA-125, CA 19-9, PSA) as a lookup table or enum
- [ ] Implement custom-add: `TRACKED_MARKER.is_custom = true`, flagged in the UI as having no trend-matching guarantee across differently-named entries
- [ ] Reference-range display: value + unit + source-stated reference range shown side by side; a value outside range gets a neutral visual highlight only
- [ ] **Wording check (hard boundary, not a style preference):** UI copy may never use "abnormal," "flagged," "at risk," "concerning," or any phrasing implying a diagnostic judgment. Review every string touching markers or reference ranges against this before merging — this is the CDSCO Class C boundary the whole regulatory posture depends on
- [ ] Build Marker Management screen (view/add tracked markers per patient)

## M6 — Radiology & Trends (Features 2, 4)

Depends on M2, M4.

- [ ] Extend extraction prompts to pull radiology impression text as a `field_type = radiology_impression` fact, with the same provenance requirements as markers
- [ ] Build tap-through: clicking any fact opens the Source View at its `source_page`/`source_location`, or falls back to the full document/page-level view with the limitation shown if precise location is null
- [ ] Build the trend-over-visits chart for markers (value + as-of date across signed-off facts) — display only, no predictive or AI-generated trend interpretation
- [ ] "Current Treatment" block: latest source-supported regimen/status fact with provenance — do not compute or infer a line-of-therapy or reconstruct a full treatment history beyond what's explicitly stated in a source document

## M7 — Conflict Handling

Depends on M2, M3.

- [ ] Implement conflict detection as **patient-wide**, not visit-scoped: two facts for the same `patient_id` + `field_type` (+ `tracked_marker_id`) with overlapping/ambiguous `as_of_date` and differing `value` → auto-create a `CONFLICT` in `open` state, including two documents within the *same* visit
- [ ] Same value + compatible dates → retain both facts as separate observations, no conflict created, no merging
- [ ] Never implement last-write-wins anywhere in this path — differing values always surface a conflict, never silently overwrite
- [ ] Set `coverage_status = conflicting_sources` on both facts when a `CONFLICT` is created (wire this into the same rules-engine pass as detection, not a separate manual step)
- [ ] Implement `POST /conflicts/:id/annotate` (staff, oncologist) and `POST /conflicts/:id/resolve` (oncologist only — choose authoritative value or mark both-stand)
- [ ] Build the conflict badge/UI on the Snapshot screen and the Conflict Resolution screen

## M8 — Pilot Readiness

Depends on M1–M7.

- [ ] Seed 2–3 synthetic patients spanning cancer types, each with ≥2 visits; include one deliberate marker conflict and one `not_observed_in_current_document_set` case to exercise both state machines
- [ ] Manual QA pass against the frozen spec's acceptance criteria (§15), classifying any extraction errors found as critical/moderate/minor — no release with a known critical-severity error, regardless of aggregate accuracy
- [ ] Confirm the DPA is in place with the LLM vendor before any real patient data enters the system
- [ ] Confirm patient consent is covered by the hospital's existing process (explicitly outside this system's scope)
- [ ] Deploy to production (cloud-hosted); rehearse the demo walkthrough end-to-end
- [ ] Brief the partner oncologist and staff on the upload → correct → sign-off workflow before first real use

**Definition of done:** the partner oncologist can, for a real returning patient, open the snapshot instead of the raw document stack, review and sign off the facts they trust, and give feedback on whether it saved time or reduced missed details — without the team touching the database directly to make any of that happen.
