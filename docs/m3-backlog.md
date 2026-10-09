# M3 Backlog — UI/UX Roadmap

Living tracker for the post-MVP UI/UX work, maintained alongside the frozen
spec docs (01–03), `docs/02-implementation-blueprint.md`, and the Decisions
Log. Unlike those, **this document is not frozen** — update it as items get
resolved or new ones surface. Mirrors the pattern established in
`docs/m1-backlog.md` / `docs/m2-backlog.md`.

Last updated: 2026-10-09, after granular imaging modality shipped.

---

## Context: why this roadmap exists

A full-codebase review (code quality + security + product/UX) found the app
was clinically *correct* but read like a CRUD app, not a decision-support
tool a doctor would reach for. Two angles came out of that:

1. **Review findings** (security + correctness bugs) — all fixed and deployed
   as of commit `95bcd2c`. Not tracked here; see git log `11a4d88`..`d611d99`.
2. **Product/UX gaps** — grounded in research on real OPD oncology workflow
   pain points (EHR burden, point-of-care decision support), not guesswork.
   This doc tracks that half.

Three gaps were identified, ranked by effort-to-impact:

| # | Gap | Status |
| --- | --- | --- |
| 1 | No pre-visit synthesis/triage — doctor has to read every block to find what matters | **Done** (commit `95bcd2c`) |
| 2 | Three disconnected blocks (Treatment/Markers/Radiology), no correlation | Open |
| 3 | No granular imaging report types (CT/MRI/PET-CT/etc.) | Implemented, **not deployed** (see below) |

A fourth, smaller item (marker panel admin UI) was split out separately —
panel *content* needs real oncologist input and is out of scope for design
work; the *mechanism* to add/edit panels through the UI does not.

---

## Done

### Pre-visit synthesis / triage (commit `95bcd2c`)

- `listPatients` returns `needs_attention_count` per patient, scoped to
  their current (most recent) visit: live facts (`LIVE_FACT_FILTER`) that
  are unverified, `extraction_uncertain`, or party to an open/annotated
  conflict. Patient list shows a badge only when > 0.
- Snapshot's "Since Last Visit" sorts by priority: out-of-range changed/new
  value first, other changed/new next, unchanged last — instead of flat API
  order.
- Verified end-to-end against the live instance (real varying counts 0–6
  across demo patients).

**Not done in this pass, worth a follow-up:** the badge/sort logic doesn't
distinguish "needs *oncologist* attention" (blocking sign-off) from "needs
*staff* attention" (routine correction) — both currently count equally. If
noisy in practice, split into two counts.

### Granular imaging report types

- New nullable `documents.imaging_modality` column (migration 008: `ct`,
  `ct_contrast`, `mri`, `mri_contrast`, `pet_ct`, `ultrasound`, `xray`,
  `mammography`, `other`), required by `uploadDocument` only when
  `document_type = "radiology"`. Mounted in both compose files.
- `Upload.tsx`: modality `<select>` shown only when "radiology" is chosen.
- `ExtractionReview.tsx` and `SourceView.tsx`: modality shown next to the
  document-type line (`SourceView.tsx` didn't actually have one yet — added
  a one-line muted caption under the heading).
- `Snapshot.tsx`'s Radiology section: shows modality as a badge on the
  `FactCard`. Needed backend work beyond a display tweak — `SnapshotField`
  only ever carried `document_id`, never joined back to `documents` — so
  `loadRadiology` (`apps/api/src/routes/patients.ts`) now `LEFT JOIN`s
  `documents` and the snapshot's radiology field objects carry
  `imaging_modality` alongside `provenance`.
- No extraction/prompt changes, as scoped.
- **Deployment status: implemented and verified against local dev only,
  NOT deployed.** Migration 008 was applied directly to the local dev
  Postgres via `docker exec` (same dance as 006/007) — and 006/007 turned
  out to still be missing from that volume too, so they were applied in the
  same pass. None of this touched the real instance: `infra/deploy.sh` says
  prod runs on an EC2 box (`/opt/prelude`) via `git pull` +
  `docker-compose.prod.yml up -d --build`, no CI, no SSH access from here.
  That rebuild alone won't run migration 008 — same as 006/007, prod's
  Postgres volume already exists, so `docker-entrypoint-initdb.d` won't
  rerun it. Before merging/deploying this: SSH to the instance and run
  migration 008 via `docker exec`, in that order, since the `uploadDocument`
  INSERT now names the `imaging_modality` column on every upload, not just
  radiology ones — deploying the code first would break all uploads.
- Tests: `uploadDocument` (4 new cases: require/validate/persist/ignore-for-
  non-radiology `imaging_modality`), snapshot route (1 new case for the
  `documents` join), and one new web e2e case (modality select
  appears/disappears with document type, and reaches the upload POST) — all
  green, alongside the full existing API suite (221 tests) and e2e smoke
  (44 tests).

---

## Open

### 2. Cross-block correlation (Tumor Markers ↔ Treatment ↔ Radiology)

**Problem:** research explicitly flags tumor markers as most useful "in
association with radiographic response/progression" — right now a doctor
has to manually reconstruct "did CA-125 drop after cycle 3 of carboplatin"
by cross-referencing dates across three independent sections.

**Status:** not yet brainstormed. Biggest design lift of the three gaps —
needs its own classification pass (likely architectural, not bounded: it's
plausibly a new correlation/timeline subsystem, not a small extension of an
existing screen). Candidate angles to explore when picked up:
- A combined timeline view (all three fact types on one axis by date) vs.
  cross-links from each marker to the nearest treatment-regimen change.
- Whether this needs new backend aggregation or can be computed client-side
  from data the Snapshot/trend endpoints already return.

### 3. Marker panel admin mechanism

**Status:** not yet brainstormed. Explicitly scoped to the *mechanism* only
— a staff/oncologist screen to add/edit disease-site panels and their
marker lists through the UI — not to inventing panel *content*. The current
7 panels (`packages/shared/src/markers.ts`) came from real "Clinical input —
partner oncologist" sessions (Decisions Log) and must stay that way; this
item is purely "give that process a UI instead of a code change," so a
non-engineer can maintain panels going forward.

Related, not the same thing: `docs/m2-backlog.md` C8 notes
`CONTROLLED_MARKERS` is still an illustrative placeholder "never locked by
an oncologist" — that's a content gap, still blocked on clinical input
regardless of whether this admin UI exists.

---

## Deliberately out of scope for this roadmap

- File format support (compressed/more images/docs) — smaller, separable,
  lower clinical value per the product review. Pick up anytime without
  blocking the above.
- Seed data expansion (~50 common patient profiles) — demo/testing utility,
  not a doctor-facing gap.
- Marker panel *content* and additional cancer-type panels — needs real
  oncology input, not a design task (see `docs/m2-backlog.md` C8).
