# Marker panel admin mechanism — design spec

m3-backlog #4: "a staff/oncologist screen to add/edit disease-site panels
and their marker lists through the UI" — explicitly scoped to the
*mechanism* only, not to inventing panel *content*. The current 7 panels
(`packages/shared/src/markers.ts`) came from real "Clinical input — partner
oncologist" sessions (Decisions Log) and must stay that way; this item
gives that process a UI instead of a code change, so a non-engineer can
maintain panels going forward.

## Scope decisions (from brainstorming)

- **Who can edit:** staff and oncologist both — treated as routine
  admin/config work, not a clinical judgment, same as most other actions in
  this app (only sign-off, conflict resolution, and patient deletion are
  oncologist-only per `docs/01-mvp-specification §337`).
- **Fallback set:** `FALLBACK_MARKER_SET` (the default marker preselection
  shown when no disease site is selected at patient creation) becomes
  admin-editable too, as one more row in the same table/screen — not left
  behind as a separate code-only constant.
- **Rename/delete:** full CRUD is safe. A patient's `cancer_type` is a free
  text field, never a foreign key into the panel table — selecting a site
  at patient creation only drives the create-flow's marker checkbox
  defaults, transiently, and nothing about an existing patient references a
  panel by id or name. Renaming or deleting a panel has zero effect on
  already-created patients.
- **Entry point:** a new "Manage panels" link in `Shell.tsx`'s header, next
  to the role badge — reachable from every screen, same visibility as Sign
  out. There's no existing settings/admin area to attach it to instead.
- **Storage shape:** one table, markers as a JSON array column (see
  Architecture below) rather than a normalized join table — nothing in this
  app ever needs to query "which panels contain marker X," only "give me
  this panel's ordered list" and "give me all panels," both trivial either
  way; the join-table shape would buy nothing for the extra schema.
- **Standards/modules considered:** HL7 FHIR mCODE's "Tumor Marker Test"
  ValueSet (https://www.hl7.org/fhir/us/mcode/ValueSet-mcode-tumor-marker-test-vs.html)
  is a real maintained standard for this same concept (a named set of
  tumor-marker tests, each backed by a LOINC code — e.g. CA-125 is LOINC
  `83082-8`). Adopting full FHIR resources (ValueSet/Observation/
  PlanDefinition) for a 7-panel internal admin screen would be real
  over-engineering and conflicts with this app's established
  hand-rolled-everything, zero-UI-framework convention (every existing
  screen, CLAUDE.md). No existing open-source admin-panel/CRUD-builder
  module (React Admin, AdminJS, etc.) fits for the same reason. Decision:
  build it hand-rolled like every other screen; see Out of scope for the
  one interoperability hook worth leaving a door open for.

## Architecture

- **One new table**, `marker_panels`:
  - `id` uuid pk
  - `name` text, not null, unique (case-insensitive) — the disease-site
    name (e.g. "Breast"), or the fallback row's fixed identity
  - `markers` jsonb, not null — ordered array of canonical marker name
    strings. Every entry must be in `CONTROLLED_MARKERS`
    (`@prelude/shared`) at write time — this mechanism assigns from the
    existing controlled list, it never invents a new marker. No duplicate
    entries within one panel's array.
  - `is_fallback` boolean, not null default false — exactly one row may be
    true (enforced by a partial unique index: `CREATE UNIQUE INDEX ON
    marker_panels (is_fallback) WHERE is_fallback`). This is the "no site
    selected" default set. Never created or deleted via the API — seeded
    once by the migration — and its `name` is immutable (`400` on any
    attempt to change it), though its `markers` list is editable like any
    other panel's.
  - `display_order` int, not null — controls the checkbox order on
    `PatientCreate` and the card order on the admin screen.
  - `created_at`, `updated_at` timestamps.
- **A migration seeds the table** from today's exact
  `DISEASE_SITE_PANELS`/`FALLBACK_MARKER_SET` content in
  `packages/shared/src/markers.ts` — same names, same marker lists, same
  order — so there is zero behavior change on deploy. `DISEASE_SITE_PANELS`,
  `DISEASE_SITES`, and `FALLBACK_MARKER_SET` are then removed from the
  shared package once nothing imports them. `MARKER_REGISTRY`,
  `CONTROLLED_MARKERS`, and `matchMarker` are untouched — separate concern
  (m2-backlog C8).
- **One new backend file**, `apps/api/src/routes/markerPanels.ts`,
  registered in `apps/api/src/index.ts` alongside the other patient/document
  routes, every route gated `requireRole(["staff", "oncologist"])`.
- **One new frontend screen**, `apps/web/src/screens/MarkerPanelAdmin.tsx`,
  routed at `/marker-panels` via a new `matchMarkerPanelAdmin` in
  `router.ts`, wired into `App.tsx` the same way every other screen is.
  Reached from a new "Manage panels" link added to `Shell.tsx`'s header.

## Backend API

- **`GET /marker-panels`** — list all panels ordered by `display_order`:
  `{ id, name, markers, is_fallback, display_order }[]`.
- **`POST /marker-panels`** — create `{ name, markers: string[] }`.
  `markers` may start empty (a fresh panel is populated via the same
  add-marker control immediately after creation on the admin screen — no
  separate bulk-picker needed at creation time). Validates: `name`
  non-empty and unique case-insensitively; every entry in `markers` is in
  `CONTROLLED_MARKERS`; no duplicate markers within the list.
  `display_order` is assigned as `max(display_order) + 1`. `is_fallback` is
  never settable through this endpoint.
- **`PATCH /marker-panels/:id`** — partial update of `name` and/or
  `markers` and/or `display_order` (same validation as create, applied to
  whichever fields are present — same COALESCE-over-undefined pattern as
  `PATCH /facts/:id`). `400` if the target row is `is_fallback` and the
  request tries to change `name`.
- **`DELETE /marker-panels/:id`** — `400` if the target row is
  `is_fallback`.

Two existing call sites move off the static shared constants onto this
API:
- **`apps/web/src/screens/PatientCreate.tsx`** fetches
  `api.listMarkerPanels()` once on mount, same `load()`/`loading`/`error`
  pattern as every other screen. `DISEASE_SITES` becomes
  `panels.filter(p => !p.is_fallback).map(p => p.name)`; the auto-marker
  computation (`autoMarkers`) reads the fetched panels' `markers` arrays
  instead of the removed `DISEASE_SITE_PANELS`/`FALLBACK_MARKER_SET`
  imports.
- **`apps/api/src/db/seed.ts`** (synthetic demo-patient seeding) queries the
  `marker_panels` table directly via SQL — it already runs after the
  migration seeds that table, so it stays the same source of truth with no
  duplication.

## Frontend: `MarkerPanelAdmin.tsx`

- Same `load()`/`error`/`busy` interaction pattern as
  `MarkerManagement.tsx`: every add/remove/rename/reorder/delete action
  calls one API method, then `await load()` to refresh. No optimistic local
  state, no big "Save" button — every click persists immediately, matching
  every other mutation screen in this app.
- **One card per panel:**
  - Panel name, with an inline "Rename" control.
  - Its markers rendered as tags, each with a remove (×) button.
  - An "Add marker" `<select>` populated from `CONTROLLED_MARKERS`,
    filtered to exclude markers already in that panel (same filtering idea
    as `MarkerManagement.tsx`'s `available`).
  - Up/down reorder buttons that `PATCH` `display_order`, swapping with the
    adjacent panel's value.
  - A "Delete panel" button — except on the fallback panel's card, which
    shows a muted "(default when no site selected)" badge instead, and
    hides the rename control entirely (its name is server-immutable, so
    hiding the control avoids a guaranteed `400`).
- **A "New panel" form** at the top: name input + "Create" button. Markers
  start empty.
- **Entry point:** a new "Manage panels" link in `Shell.tsx`'s header, next
  to the role badge/Sign out button.
- Error/loading states: the same `ApiError`-driven error banner and
  "Loading..." text used on every other screen.

## Testing

- **Backend** (`apps/api/src/routes/markerPanels.test.ts`, against the real
  Postgres, same pattern as every other route test):
  - Reject a marker not in `CONTROLLED_MARKERS`.
  - Reject a duplicate marker within one panel's list.
  - Reject a duplicate panel name (case-insensitive).
  - Rename/reorder/edit-markers on a normal panel; delete a normal panel.
  - `400` on deleting the fallback panel.
  - `400` on renaming the fallback panel; its `markers` list is still
    editable.
  - `GET` returns panels ordered by `display_order`.
  - The seeding migration produces exactly today's 7 panels + fallback set
    (same names, same marker lists, same order) — a regression test pinning
    "the migration didn't silently alter existing behavior."
- **Frontend/e2e:** `apps/web/e2e/smoke.test.ts` already has a test
  (`"Patient create: selecting a disease site pre-checks..."`) that relies
  on `PatientCreate` reading panel data statically. Once it fetches from
  the API, that test's `page.route` mock needs a `/marker-panels` handler
  returning the same Gynecologic/Breast data it exercises today — an
  existing test this change touches, not new coverage, but required to keep
  passing. New e2e coverage for `MarkerPanelAdmin` itself: create a panel,
  add/remove a marker, rename, reorder, delete a normal panel, and confirm
  the fallback panel's card has no Delete button and no rename control.

## Out of scope (explicitly)

- Editing `MARKER_REGISTRY` (marker aliases/units) or the controlled-marker
  list itself — a separate, clinically-gated item (m2-backlog C8), content
  this mechanism must not touch.
- Any FHIR/LOINC adoption now — noted as a future interoperability hook (an
  optional `loinc_code` field on `MARKER_REGISTRY` entries, left for a
  later, separate change if ever wanted), not built as part of this item.
- Audit history of panel edits (who changed what, when) — not requested;
  if wanted later it's an additive `panel_edits` log table, not a redesign
  of this one.
