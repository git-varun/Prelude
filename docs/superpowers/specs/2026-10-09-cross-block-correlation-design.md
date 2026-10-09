# Cross-block correlation timeline — design spec

m3-backlog #2: "Three disconnected blocks (Treatment/Markers/Radiology), no
correlation." Research backing this gap: tumor markers are most useful "in
association with radiographic response/progression" — right now a doctor
has to manually reconstruct "did CA-125 drop after cycle 3 of carboplatin"
by cross-referencing dates across three independent Snapshot sections.

This spec covers a new combined timeline screen that puts tumor marker
values, treatment-regimen changes, and radiology impressions on one
chronological view, across the patient's full history.

## Constraint carried over from docs/01-mvp-specification

"Current Treatment scope... not a modeled complete oncology treatment
timeline (no computed line-of-therapy, no treatment-history reconstruction
beyond what's explicitly stated in a source document)." This feature
**visualizes existing signed-off facts** — it never infers, interpolates,
or reconstructs anything not already present as a FACT row.

## Scope decisions (from brainstorming)

- **Shape:** a combined timeline view (not per-marker cross-links).
- **History range:** full patient history, all visits — same as the
  existing per-marker trend chart, not Snapshot's current+previous-visit
  scoping. This is where correlation actually pays off.
- **Placement:** a new dedicated screen (`Timeline.tsx`), not embedded in
  Snapshot. Linked from Snapshot via a new "Timeline" button next to the
  existing "Visit history" button.
- **Verification filter:** signed-off only, consistently across all three
  fact types — matches the existing per-marker trend chart's rule
  (`verification_state = 'oncologist_signed_off'` + `LIVE_FACT_FILTER`).
  Unverified/staff-corrected facts are excluded from the chart the same way
  they already are from the marker trend; a fact that lost an
  authoritative-pick conflict resolution is excluded via the shared
  `LIVE_FACT_FILTER`, reused rather than reimplemented.
- **Multi-marker normalization — safety call:** each tracked marker's line
  is normalized to **its own** observed min/max (0–100% of its own range),
  never a shared absolute scale across markers. This was a deliberate
  correction during brainstorming: the app's existing trend-chart code
  carries a hard rule ("a value's trajectory carries no good/bad judgment
  here... never the app's terracotta accent, red, or success-green") and a
  shared scale across markers with different units/biology would newly
  imply the markers are comparable or that parallel movement means
  something clinically — a bigger judgment call than anything else in this
  app makes. Per-marker self-normalization avoids that: the chart shows
  each marker's own shape over time, with its real value+unit always
  available via tooltip/label, never a cross-marker comparison.
- **Provenance:** every event (marker point, treatment change, radiology
  impression) click-throughs to the existing Source view
  (`/documents/:id/source?fact=:factId`), same as `FactCard`'s "View
  source" today. No new provenance UI.

## Architecture

- **One new backend endpoint:** `GET /patients/:id/timeline`
  (`apps/api/src/routes/patients.ts`, alongside `getPatientSnapshot` and
  `getMarkerTrend`). Returns everything the screen needs in one response —
  avoids N+1 (looping the client over the per-marker trend endpoint for
  every tracked marker, plus separate calls for treatment/radiology).
- **One new screen:** `apps/web/src/screens/Timeline.tsx`, routed at
  `/patients/:id/timeline`. New `matchPatientTimeline` in
  `apps/web/src/router.ts` (same pattern as `matchPatientSnapshot` /
  `matchPatientHistory`), wired into `apps/web/src/App.tsx` the same way.
- **Chart:** extends the existing hand-rolled inline-SVG chart code
  (`apps/web/src/lib/trendChart.ts`, pattern established by
  `MarkerTrendChart.tsx`) rather than introducing a charting library —
  consistent with this app's existing minimal-dependency style for charts.

## Data flow / response shape

```
GET /patients/:id/timeline →
{
  markers: [
    { tracked_marker_id, marker_name, points: [
        { fact_id, value, unit, as_of_date, visit_id }
    ] }
  ],
  treatment: [
    { fact_id, value, as_of_date, visit_id,
      document_id, source_page, source_location, source_snippet, fallback_level }
  ],
  radiology: [
    { fact_id, value, as_of_date, visit_id,
      document_id, source_page, source_location, source_snippet, fallback_level }
  ],
}
```

- All three arrays filtered to `verification_state = 'oncologist_signed_off'`
  + `LIVE_FACT_FILTER`, reusing the same SQL predicate `getMarkerTrend`
  already uses (not reimplemented).
- `markers` omits any tracked marker with zero signed-off points — nothing
  to plot, no empty entry.
- `treatment`/`radiology` entries carry provenance fields directly (not
  wrapped in a `Provenance` object like Snapshot does) — `provenanceFor`
  is reused to compute `fallback_level` server-side, same function,
  inlined into each entry rather than nested, since the frontend needs it
  flat for the tick-tooltip click-through.
- 404 for an unknown/malformed patient id (`isUuid` + existence check),
  matching `getPatientSnapshot`'s pattern. No "no visits yet" 404 the way
  Snapshot has one — a patient with zero visits also trivially has zero
  signed-off facts, which the frontend's empty state (below) already
  covers; a 200 with all-empty arrays is simpler than a second 404 case to
  special-case on the frontend.

## Frontend: chart model

New `buildMultiSeriesModel` in `apps/web/src/lib/trendChart.ts`, alongside
the existing `buildTrendChartModel`:

- Input: `markers` array from the endpoint (one entry per tracked marker
  with ≥1 signed-off point).
- Per marker: normalize each point's value to 0–100% of that marker's own
  min/max across its own points (not the shared `buildTrendChartModel`
  "units must match" logic — there's no cross-marker unit comparison here,
  each marker only ever compares against itself).
- A marker with exactly 1 point still produces a single positioned dot
  (not a line, not hidden) — the point is real even though it can't form a
  line yet. This extends `buildTrendChartModel`'s "<2 points → no chart"
  rule rather than contradicting it: here the *existence* of the point is
  itself informative on a shared timeline, even if its own trajectory
  isn't yet.
- Output carries each point's real `value`+`unit` (never discarded) for
  tooltip/label display — the 0–100% figure is a draw-time positioning
  detail, never shown to the user as a number.

## UI (`Timeline.tsx`)

- Patient header: same pattern as `Snapshot.tsx`/`Upload.tsx` (name,
  cancer type, back button).
- One wide card containing the chart: full-width SVG (larger viewBox than
  the inline sparkline), x-axis = full date range across all returned
  points/events.
  - Each tracked marker: its own line + dots, a distinct muted/neutral
    color for **identity only** (no red/green/success semantics — picking
    the actual palette is an implementation-time detail for whoever builds
    this, following the app's existing "never implies clinical judgment"
    constraint; it is not re-litigated in this spec).
  - A legend below/beside the chart: color swatch → marker name → current
    (most recent) real value + unit.
  - Two tick-mark rows below the x-axis: one for treatment-regimen
    changes, one for radiology impressions. Each tick is hoverable/tappable
    for a tooltip with that fact's `value` text + date, linking to its
    Source view.
- Empty state: if `markers`, `treatment`, and `radiology` are all empty,
  render a muted "No signed-off history yet to chart" message instead of
  an empty SVG. This will be common for new patients, since nothing is
  signed off yet.
- Error state: fetch failure renders the same `ApiError`-driven error
  banner pattern already used in Snapshot/Upload — no bespoke error UI.
- Entry point: `Snapshot.tsx` gets a new "Timeline" button next to the
  existing "Visit history" button, navigating to
  `/patients/:id/timeline`.

## Testing

- **Backend** (`apps/api/src/routes/patients.timeline.test.ts`, mirroring
  `patients.snapshot.test.ts`'s fixture helpers):
  - Unverified/staff-corrected facts excluded; signed-off facts included.
  - A fact that lost an authoritative-pick conflict resolution excluded
    (via `LIVE_FACT_FILTER`).
  - A tracked marker with zero signed-off points is omitted from `markers`
    entirely (not an empty-points entry).
  - Provenance fields present and correct (`fallback_level` matches the
    existing exact/page/document rules already tested for Snapshot).
  - 404 for unknown/malformed patient id; 200 with all-empty arrays for a
    valid patient with no signed-off facts yet.
- **Frontend unit tests** (`apps/web/src/lib/trendChart.test.ts` if it
  exists already, else co-located with the existing chart model tests):
  - `buildMultiSeriesModel`: per-marker self-normalization math, the
    single-point-as-dot case, empty input.
- **E2E** (one new case in `apps/web/e2e/smoke.test.ts`): navigate
  Snapshot → Timeline via the new button, assert the chart/legend/tick
  rows render, click a tick, land on Source view for the right fact.

## Out of scope (explicitly)

- Any computed/inferred treatment timeline, line-of-therapy, or
  progression judgment — this is pure visualization of existing signed-off
  FACT rows (carried over from `docs/01-mvp-specification`'s existing
  constraint).
- Cross-links/annotations on the existing Snapshot sections (the
  alternative "lighter" shape considered and not chosen).
- Un-signed-off data on the timeline (deliberately excluded, matching the
  existing per-marker trend chart's trust bar).
- A charting library (deliberately extending the existing hand-rolled SVG
  approach instead).
