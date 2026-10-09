# Cross-block correlation timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the combined timeline screen (m3-backlog #2) that plots tumor marker
values, treatment-regimen changes, and radiology impressions on one chronological
view across a patient's full history, so a doctor can see "did CA-125 drop after
cycle 3 of carboplatin" without cross-referencing three Snapshot sections by hand.

**Architecture:** One new read-only backend endpoint (`GET /patients/:id/timeline`)
aggregates every `oncologist_signed_off` marker/treatment/radiology fact across the
patient's full history in one response. One new frontend screen (`Timeline.tsx`,
routed at `/patients/:id/timeline`, linked from a new button on `Snapshot.tsx`)
renders it as a hand-rolled inline-SVG chart: one line per tracked marker
(self-normalized to its own range) plus two tick rows for treatment/radiology
events, each tick clicking through to the existing Source view.

**Tech Stack:** Bun (`bun test` for API + frontend unit tests, `bun run --cwd
apps/web test:e2e` for the Playwright smoke suite), `postgres` tagged-template
queries via `sql` (apps/api/src/db/client.ts), React with hand-rolled inline SVG
(no charting library), the existing hash router (apps/web/src/router.ts).

**Spec:** `docs/superpowers/specs/2026-10-09-cross-block-correlation-design.md`

## Global Constraints

- Visualizes only existing signed-off `FACT` rows — never infers, interpolates,
  or reconstructs a treatment timeline (carried over from
  `docs/01-mvp-specification`).
- Every array (`markers`, `treatment`, `radiology`) filtered to
  `verification_state = 'oncologist_signed_off'` + `LIVE_FACT_FILTER`, reusing
  the exact predicate `getMarkerTrend`/`loadDeltaBaselines` already use — never
  reimplemented.
- Full patient history, all visits — not Snapshot's current+previous-visit
  scoping.
- Each tracked marker's line is normalized to **its own** observed min/max —
  never a shared scale across markers (avoids implying markers are clinically
  comparable).
- No new charting library — extends the existing hand-rolled inline-SVG chart
  code (`apps/web/src/lib/trendChart.ts`, pattern established by
  `MarkerTrendChart.tsx`).
- Every event click-throughs to the existing Source view
  (`/documents/:id/source?fact=:factId`) — no new provenance UI.
- No red/green/success-accent colors for marker identity (Decisions Log's
  "never a clinical alarm" rule).

## Review Focus

- An `oncologist_signed_off` fact with `as_of_date IS NULL` can't be placed on
  a chronological axis — excluded at the query level (all three loaders), with
  a test proving it's dropped rather than crashing position math.
- A patient with zero signed-off facts anywhere returns `200` with all-empty
  arrays (not a 404) and the frontend renders the "No signed-off history yet to
  chart" empty state instead of an empty/broken SVG.
- A fact that lost an authoritative-pick conflict resolution is excluded via
  `LIVE_FACT_FILTER`, same as every other block — tested explicitly here too,
  not assumed from Snapshot's existing coverage.
- A tracked marker with zero signed-off points across the whole history is
  omitted from `markers` entirely (not an empty-points entry) — both backend
  and the frontend grouping must agree on this.
- A tracked marker with exactly one signed-off point still renders a single
  positioned dot (not a line, not hidden, not a division-by-zero in the
  normalization math).

---

## Task 1: Backend `GET /patients/:id/timeline` endpoint

**Files:**
- Modify: `apps/api/src/routes/patients.ts` (add `loadTimelineMarkers`,
  `loadTimelineEvents`, `groupMarkers`, `timelineEventObject`,
  `getPatientTimeline`)
- Modify: `apps/api/src/index.ts` (register the route)
- Test: `apps/api/src/routes/patients.timeline.test.ts`

**Interfaces:**
- Consumes: `sql` (`apps/api/src/db/client.ts`), `jsonError`
  (`apps/api/src/middleware/auth.ts`), `isUuid` (already defined at the top of
  `patients.ts`), `LIVE_FACT_FILTER` (`apps/api/src/services/delta.ts`),
  `provenanceFor` (`apps/api/src/services/provenance.ts`).
- Produces: `getPatientTimeline(req: Request & { params: { id: string } }):
  Promise<Response>`, returning
  `{ markers: { tracked_marker_id: string; marker_name: string; points: {
  fact_id: string; value: string; unit: string | null; as_of_date: string;
  visit_id: string }[] }[]; treatment: TimelineEventJson[]; radiology:
  TimelineEventJson[] }` where `TimelineEventJson = { fact_id: string; value:
  string | null; as_of_date: string; visit_id: string; document_id: string;
  source_page: number | null; source_location: string | null; source_snippet:
  string | null; fallback_level: "exact" | "page" | "document" }`. Task 2's
  frontend types mirror this exactly.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/patients.timeline.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from "bun:test";
import { sql } from "../db/client";
import { getPatientTimeline } from "./patients";
import { createTestUser, deleteTestUsers, createTestPatient, deleteTestPatients, type TestUser } from "../test-helpers";

let staff: TestUser;
let oncologist: TestUser;
let patientId: string;
let visitAId: string;
let visitBId: string;
let ceaMarkerId: string;
let psaMarkerId: string;

beforeAll(async () => {
  staff = await createTestUser("staff", "timeline-route-staff");
  oncologist = await createTestUser("oncologist", "timeline-route-onc");
  patientId = (await createTestPatient(staff.id)).id;
  [{ id: visitAId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-01-01') RETURNING id`;
  [{ id: visitBId }] = await sql`INSERT INTO visits (patient_id, visit_date) VALUES (${patientId}, '2026-02-01') RETURNING id`;
  [{ id: ceaMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'CEA', false, ${staff.id}) RETURNING id`;
  [{ id: psaMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'PSA', false, ${staff.id}) RETURNING id`;
});

afterAll(async () => {
  await deleteTestPatients(patientId);
  await deleteTestUsers(staff.id, oncologist.id);
});

async function newDocument(visitId: string, documentType: "blood" | "radiology" = "blood"): Promise<string> {
  const [doc] = await sql`
    INSERT INTO documents (patient_id, visit_id, file_ref, document_type, source_origin, uploaded_by, ocr_status)
    VALUES (${patientId}, ${visitId}, 'local://t/x.pdf', ${documentType}, 'own_hospital', ${staff.id}, 'done') RETURNING id`;
  return doc.id;
}

async function newFact(documentId: string, visitId: string, o: Record<string, unknown> = {}): Promise<string> {
  const f = {
    fieldType: "marker_value", value: "4.2", asOf: "2026-02-01" as string | null,
    coverage: "value_found", verification: "oncologist_signed_off",
    markerId: null as string | null, sourcePage: null as number | null, sourceLocation: null as string | null,
    sourceSnippet: null as string | null, signedOffBy: oncologist.id as string | null, ...o,
  };
  const [row] = await sql`
    INSERT INTO facts (patient_id, visit_id, document_id, tracked_marker_id, field_type, value,
      as_of_date, coverage_status, verification_state, source_page, source_location, source_snippet, signed_off_by)
    VALUES (${patientId}, ${visitId}, ${documentId}, ${f.markerId}, ${f.fieldType}, ${f.value},
      ${f.asOf}, ${f.coverage}, ${f.verification}, ${f.sourcePage}, ${f.sourceLocation}, ${f.sourceSnippet}, ${f.signedOffBy})
    RETURNING id`;
  return row.id;
}

function timelineReq(id: string) {
  const req = new Request(`http://localhost/patients/${id}/timeline`) as Request & { params: { id: string } };
  req.params = { id };
  return req;
}

test("404s for an unknown or malformed patient id", async () => {
  expect((await getPatientTimeline(timelineReq("00000000-0000-0000-0000-000000000000"))).status).toBe(404);
  expect((await getPatientTimeline(timelineReq("not-a-uuid"))).status).toBe(404);
});

test("200 with all-empty arrays for a patient with no signed-off facts yet", async () => {
  const freshPatient = await createTestPatient(staff.id);
  try {
    const res = await getPatientTimeline(timelineReq(freshPatient.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ markers: [], treatment: [], radiology: [] });
  } finally {
    await deleteTestPatients(freshPatient.id);
  }
});

test("spans the patient's full history, not just the current visit", async () => {
  const docA = await newDocument(visitAId);
  const docB = await newDocument(visitBId);
  const factA = await newFact(docA, visitAId, { markerId: ceaMarkerId, asOf: "2026-01-01", value: "3.0" });
  const factB = await newFact(docB, visitBId, { markerId: ceaMarkerId, asOf: "2026-02-01", value: "9.0" });

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  const cea = body.markers.find((m: any) => m.tracked_marker_id === ceaMarkerId);
  expect(cea.points.map((p: any) => p.fact_id).sort()).toEqual([factA, factB].sort());
});

test("unverified and staff-corrected facts are excluded; only oncologist_signed_off is included", async () => {
  const doc = await newDocument(visitBId);
  await newFact(doc, visitBId, { markerId: psaMarkerId, verification: "unverified", asOf: "2026-02-01" });
  await newFact(doc, visitBId, { markerId: psaMarkerId, verification: "staff_corrected", asOf: "2026-02-01" });
  const signedOff = await newFact(doc, visitBId, { markerId: psaMarkerId, verification: "oncologist_signed_off", asOf: "2026-02-02", value: "1.5" });

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  const psa = body.markers.find((m: any) => m.tracked_marker_id === psaMarkerId);
  expect(psa.points.map((p: any) => p.fact_id)).toEqual([signedOff]);
});

test("a fact that lost an authoritative-pick conflict resolution is excluded", async () => {
  const doc = await newDocument(visitBId);
  const winner = await newFact(doc, visitBId, { fieldType: "treatment_regimen", asOf: "2026-02-05", value: "FOLFOX" });
  const loser = await newFact(doc, visitBId, { fieldType: "treatment_regimen", asOf: "2026-02-05", value: "FOLFIRI" });
  await sql`
    INSERT INTO conflicts (fact_id_a, fact_id_b, status, authoritative_fact_id)
    VALUES (${winner}, ${loser}, 'resolved', ${winner})
  `;

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  const ids = body.treatment.map((t: any) => t.fact_id);
  expect(ids).toContain(winner);
  expect(ids).not.toContain(loser);
});

test("a signed-off fact with no as_of_date is excluded (can't be placed on a chronological axis)", async () => {
  const doc = await newDocument(visitBId);
  const dated = await newFact(doc, visitBId, { fieldType: "radiology_impression", asOf: "2026-02-10", value: "stable" });
  await newFact(doc, visitBId, { fieldType: "radiology_impression", asOf: null, value: "no date given" });

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  expect(body.radiology.map((r: any) => r.fact_id)).toEqual([dated]);
});

test("a tracked marker with zero signed-off points anywhere is omitted from markers entirely", async () => {
  const [{ id: lonelyMarkerId }] = await sql`
    INSERT INTO tracked_markers (patient_id, marker_name, is_custom, added_by) VALUES (${patientId}, 'AFP', false, ${staff.id}) RETURNING id`;

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  expect(body.markers.find((m: any) => m.tracked_marker_id === lonelyMarkerId)).toBeUndefined();
});

test("treatment/radiology entries carry flat provenance fields with the correct fallback_level", async () => {
  const doc = await newDocument(visitBId, "radiology");
  const factId = await newFact(doc, visitBId, {
    fieldType: "radiology_impression", asOf: "2026-02-11", value: "no new lesions",
    sourcePage: 2, sourceSnippet: "no new lesions identified",
  });

  const res = await getPatientTimeline(timelineReq(patientId));
  const body = (await res.json()) as any;
  const entry = body.radiology.find((r: any) => r.fact_id === factId);
  expect(entry).toMatchObject({
    fact_id: factId, value: "no new lesions", document_id: doc,
    source_page: 2, source_snippet: "no new lesions identified", fallback_level: "exact",
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/api/src/routes/patients.timeline.test.ts`
Expected: FAIL — `getPatientTimeline` is not exported from `./patients` yet.

- [ ] **Step 3: Implement the endpoint**

In `apps/api/src/routes/patients.ts`, add after `getMarkerTrend`:

```ts
interface TimelineMarkerRow {
  tracked_marker_id: string;
  marker_name: string;
  fact_id: string;
  value: string;
  unit: string | null;
  as_of_date: string;
  visit_id: string;
}

// Full patient history (every visit), not scoped to the current visit like Snapshot --
// this is where cross-block correlation actually pays off (m3-backlog #2 design spec).
// Undated facts are excluded: a chronological axis has nowhere to put them.
async function loadTimelineMarkers(patientId: string): Promise<TimelineMarkerRow[]> {
  return sql`
    SELECT tm.id AS tracked_marker_id, tm.marker_name,
           f.id AS fact_id, f.value, f.unit, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.visit_id
    FROM tracked_markers tm
    JOIN facts f ON f.tracked_marker_id = tm.id
    WHERE tm.patient_id = ${patientId}
      AND f.verification_state = 'oncologist_signed_off'
      AND f.as_of_date IS NOT NULL
      AND ${LIVE_FACT_FILTER}
    ORDER BY tm.added_at ASC, f.as_of_date ASC
  `;
}

// Map rather than GROUP BY: insertion order (first row seen per marker) already follows
// tm.added_at ASC from the query above, which Map.values() preserves.
function groupTimelineMarkers(rows: TimelineMarkerRow[]) {
  const byMarker = new Map<string, { tracked_marker_id: string; marker_name: string; points: Omit<TimelineMarkerRow, "tracked_marker_id" | "marker_name">[] }>();
  for (const r of rows) {
    let entry = byMarker.get(r.tracked_marker_id);
    if (!entry) {
      entry = { tracked_marker_id: r.tracked_marker_id, marker_name: r.marker_name, points: [] };
      byMarker.set(r.tracked_marker_id, entry);
    }
    entry.points.push({ fact_id: r.fact_id, value: r.value, unit: r.unit, as_of_date: r.as_of_date, visit_id: r.visit_id });
  }
  return [...byMarker.values()];
}

interface TimelineEventRow {
  fact_id: string;
  value: string | null;
  as_of_date: string;
  visit_id: string;
  document_id: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
}

// Same signed-off + LIVE_FACT_FILTER + full-history rules as loadTimelineMarkers, for
// treatment_regimen/radiology_impression instead of marker_value.
async function loadTimelineEvents(
  patientId: string,
  fieldType: "treatment_regimen" | "radiology_impression",
): Promise<TimelineEventRow[]> {
  return sql`
    SELECT f.id AS fact_id, f.value, to_char(f.as_of_date, 'YYYY-MM-DD') AS as_of_date, f.visit_id,
           f.document_id, f.source_page, f.source_location, f.source_snippet
    FROM facts f
    WHERE f.patient_id = ${patientId} AND f.field_type = ${fieldType}
      AND f.verification_state = 'oncologist_signed_off'
      AND f.as_of_date IS NOT NULL
      AND ${LIVE_FACT_FILTER}
    ORDER BY f.as_of_date ASC
  `;
}

// Provenance fields flat on the entry (not nested under a `provenance` key like Snapshot) --
// the frontend tick-tooltip click-through needs document_id/fact_id directly.
function timelineEventObject(r: TimelineEventRow) {
  const p = provenanceFor(r.document_id, r.source_page, r.source_location, r.source_snippet);
  return {
    fact_id: r.fact_id,
    value: r.value,
    as_of_date: r.as_of_date,
    visit_id: r.visit_id,
    document_id: p.document_id,
    source_page: p.source_page,
    source_location: p.source_location,
    source_snippet: p.source_snippet,
    fallback_level: p.fallback_level,
  };
}

export async function getPatientTimeline(req: Request & { params: { id: string } }): Promise<Response> {
  const patientId = req.params.id;
  if (!isUuid(patientId)) return jsonError(404, "not_found", "Patient not found.");

  const [patient] = await sql`SELECT id FROM patients WHERE id = ${patientId}`;
  if (!patient) return jsonError(404, "not_found", "Patient not found.");

  const [markerRows, treatmentRows, radiologyRows] = await Promise.all([
    loadTimelineMarkers(patientId),
    loadTimelineEvents(patientId, "treatment_regimen"),
    loadTimelineEvents(patientId, "radiology_impression"),
  ]);

  return Response.json({
    markers: groupTimelineMarkers(markerRows),
    treatment: treatmentRows.map(timelineEventObject),
    radiology: radiologyRows.map(timelineEventObject),
  });
}
```

Register the route in `apps/api/src/index.ts`:

```ts
import { createPatient, listPatients, getPatient, updatePatient, addMarker, getPatientSnapshot, getMarkerTrend, getPatientTimeline } from "./routes/patients";
```

```ts
    "/patients/:id/timeline": cors({
      GET: requireRole(["staff", "oncologist"], getPatientTimeline),
    }),
```
(placed directly after the existing `/patients/:id/markers/:trackedMarkerId/trend` route)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/api/src/routes/patients.timeline.test.ts`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Run the full API suite to check for regressions**

Run: `bun test --cwd apps/api` (or `cd apps/api && bun test`)
Expected: PASS, no regressions in the existing suite.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/patients.ts apps/api/src/index.ts apps/api/src/routes/patients.timeline.test.ts
git commit -m "api: cross-block correlation timeline endpoint (m3-backlog #2)"
```

---

## Task 2: Frontend API client types + `getTimeline`

**Files:**
- Modify: `apps/web/src/api/client.ts`

**Interfaces:**
- Consumes: Task 1's JSON response shape exactly.
- Produces: `TimelineMarkerPoint`, `TimelineMarkerSeries`, `TimelineEvent`,
  `TimelineResponse` types, and `api.getTimeline(patientId: string):
  Promise<TimelineResponse>`. Task 3 and Task 4 both import these.

This task has no independent test of its own (it's typed plumbing with no
runtime behavior) — Task 4's e2e test is what exercises it end-to-end. No
failing-test step; add the types/function directly.

- [ ] **Step 1: Add the types and client method**

In `apps/web/src/api/client.ts`, after the `MarkerTrend` interface:

```ts
export interface TimelineMarkerPoint {
  fact_id: string;
  value: string;
  unit: string | null;
  as_of_date: string;
  visit_id: string;
}

export interface TimelineMarkerSeries {
  tracked_marker_id: string;
  marker_name: string;
  points: TimelineMarkerPoint[];
}

export interface TimelineEvent {
  fact_id: string;
  value: string | null;
  as_of_date: string;
  visit_id: string;
  document_id: string;
  source_page: number | null;
  source_location: string | null;
  source_snippet: string | null;
  fallback_level: "exact" | "page" | "document";
}

export interface TimelineResponse {
  markers: TimelineMarkerSeries[];
  treatment: TimelineEvent[];
  radiology: TimelineEvent[];
}
```

In the `api` object, after `getMarkerTrend`:

```ts
  getTimeline: (patientId: string) => request<TimelineResponse>(`/patients/${patientId}/timeline`),
```

- [ ] **Step 2: Typecheck**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/api/client.ts
git commit -m "web: add timeline API client types"
```

---

## Task 3: `buildMultiSeriesModel` chart model

**Files:**
- Modify: `apps/web/src/lib/trendChart.ts`
- Modify: `apps/web/src/lib/trendChart.test.ts`

**Interfaces:**
- Consumes: nothing new (pure function over plain data, same independence
  `buildTrendChartModel` already has from `api/client.ts`).
- Produces: `MultiSeriesInput`, `MultiSeriesPoint`, `MultiSeriesLine`,
  `buildMultiSeriesModel(markers: MultiSeriesInput[]): MultiSeriesLine[]`.
  Task 4's `Timeline.tsx` imports all four.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/lib/trendChart.test.ts`:

```ts
import { buildMultiSeriesModel, type MultiSeriesInput } from "./trendChart";

function series(overrides: Partial<MultiSeriesInput> = {}): MultiSeriesInput {
  return {
    tracked_marker_id: "m1",
    marker_name: "CEA",
    points: [
      { fact_id: "f1", value: "3.0", unit: "ng/mL", as_of_date: "2026-01-01", visit_id: "v1" },
      { fact_id: "f2", value: "9.0", unit: "ng/mL", as_of_date: "2026-02-01", visit_id: "v2" },
    ],
    ...overrides,
  };
}

test("empty input -> empty output", () => {
  expect(buildMultiSeriesModel([])).toEqual([]);
});

test("each marker is normalized to its own min/max, never a shared scale", () => {
  const wide = series({
    tracked_marker_id: "m1", marker_name: "CEA",
    points: [
      { fact_id: "f1", value: "0", unit: "ng/mL", as_of_date: "2026-01-01", visit_id: "v1" },
      { fact_id: "f2", value: "100", unit: "ng/mL", as_of_date: "2026-02-01", visit_id: "v2" },
    ],
  });
  const narrow = series({
    tracked_marker_id: "m2", marker_name: "PSA",
    points: [
      { fact_id: "f3", value: "4.0", unit: "ng/mL", as_of_date: "2026-01-01", visit_id: "v1" },
      { fact_id: "f4", value: "5.0", unit: "ng/mL", as_of_date: "2026-02-01", visit_id: "v2" },
    ],
  });
  const model = buildMultiSeriesModel([wide, narrow]);
  const wideOut = model.find((m) => m.tracked_marker_id === "m1")!;
  const narrowOut = model.find((m) => m.tracked_marker_id === "m2")!;
  expect(wideOut.points[0]!.pct).toBe(0);
  expect(wideOut.points[1]!.pct).toBe(100);
  expect(narrowOut.points[0]!.pct).toBe(0);
  expect(narrowOut.points[1]!.pct).toBe(100);
  // real values are never discarded even though pct is the draw-time position
  expect(narrowOut.points[0]!.value).toBe(4.0);
  expect(narrowOut.points[1]!.value).toBe(5.0);
});

test("a marker with exactly one point still produces a single positioned dot", () => {
  const single = series({ points: [{ fact_id: "f1", value: "7.0", unit: "ng/mL", as_of_date: "2026-01-01", visit_id: "v1" }] });
  const model = buildMultiSeriesModel([single]);
  expect(model[0]!.points).toEqual([{ date: "2026-01-01", value: 7.0, unit: "ng/mL", pct: 50 }]);
});

test("a marker with zero points produces an entry with an empty points array (grouping/omission is the backend's job, not this function's)", () => {
  const model = buildMultiSeriesModel([series({ points: [] })]);
  expect(model[0]!.points).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test apps/web/src/lib/trendChart.test.ts`
Expected: FAIL — `buildMultiSeriesModel` is not defined.

- [ ] **Step 3: Implement the function**

Append to `apps/web/src/lib/trendChart.ts`:

```ts
export interface MultiSeriesPoint {
  fact_id: string;
  value: string;
  unit: string | null;
  as_of_date: string;
  visit_id: string;
}

export interface MultiSeriesInput {
  tracked_marker_id: string;
  marker_name: string;
  points: MultiSeriesPoint[];
}

export interface MultiSeriesLine {
  tracked_marker_id: string;
  marker_name: string;
  points: { date: string; value: number; unit: string | null; pct: number }[];
}

// Each marker is normalized to its own observed min/max (0-100% of its own range),
// never a shared scale across markers — a shared scale would newly imply markers with
// different units/biology are clinically comparable (m3-backlog #2 design spec). The
// real value+unit is always carried alongside pct for tooltip/label display; pct is a
// draw-time positioning detail only, never shown to the user as a number.
//
// A single-point series is positioned at the midpoint (50%): there's no range yet to
// locate it within, but the point's existence on the shared timeline is itself
// informative even before its own trajectory is.
export function buildMultiSeriesModel(markers: MultiSeriesInput[]): MultiSeriesLine[] {
  return markers.map((m) => {
    const values = m.points.map((p) => Number(p.value));
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    return {
      tracked_marker_id: m.tracked_marker_id,
      marker_name: m.marker_name,
      points: m.points.map((p, i) => ({
        date: p.as_of_date,
        value: values[i]!,
        unit: p.unit,
        pct: values.length === 1 ? 50 : ((values[i]! - min) / span) * 100,
      })),
    };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test apps/web/src/lib/trendChart.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/trendChart.ts apps/web/src/lib/trendChart.test.ts
git commit -m "web: per-marker self-normalized multi-series chart model"
```

---

## Task 4: `Timeline.tsx` screen + routing + Snapshot entry point

**Files:**
- Create: `apps/web/src/screens/Timeline.tsx`
- Modify: `apps/web/src/router.ts` (add `matchPatientTimeline`)
- Modify: `apps/web/src/App.tsx` (wire the route)
- Modify: `apps/web/src/screens/Snapshot.tsx` (add the "Timeline" button)

**Interfaces:**
- Consumes: `api.getTimeline` + `TimelineResponse`/`TimelineEvent` (Task 2),
  `buildMultiSeriesModel`/`MultiSeriesLine` (Task 3), `navigate` (`router.ts`).
- Produces: `Timeline({ patientId }: { patientId: string })`, routed at
  `/patients/:id/timeline`. Task 5's e2e test drives this screen.

- [ ] **Step 1: Add the route matcher**

In `apps/web/src/router.ts`, after `matchPatientHistory`:

```ts
export function matchPatientTimeline(path: string): string | null {
  const m = path.match(/^\/patients\/([^/]+)\/timeline$/);
  return m ? m[1]! : null;
}
```

- [ ] **Step 2: Write the screen**

Create `apps/web/src/screens/Timeline.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type TimelineEvent, type TimelineResponse } from "../api/client";
import { buildMultiSeriesModel, type MultiSeriesLine } from "../lib/trendChart";
import { navigate } from "../router";

const WIDTH = 760;
const HEIGHT = 260;
const PAD_X = 24;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 140;
const TREATMENT_TICK_Y = 170;
const RADIOLOGY_TICK_Y = 200;
const DATE_LABEL_Y = 230;

// Identity-only palette: no red/green/success-accent, and no shared meaning across
// markers (Decisions Log's "never a clinical alarm" rule, extended here to "never
// implies cross-marker comparison" per the correlation-timeline design spec). Picking
// the actual palette is an implementation-time detail, not re-litigated by the spec.
const MARKER_COLORS = ["#6b7a8f", "#8a6fae", "#4f8a8b", "#a67c52", "#5b7fa6", "#8a5b6f"];

function EventTicks({
  label,
  entries,
  y,
  x,
}: {
  label: string;
  entries: TimelineEvent[];
  y: number;
  x: (d: number) => number;
}) {
  return (
    <g>
      <text x={PAD_X} y={y - 8} fontSize="9" fill="var(--color-text-muted)">
        {label}
      </text>
      {entries.map((e) => (
        <circle
          key={e.fact_id}
          cx={x(new Date(e.as_of_date).getTime())}
          cy={y}
          r={4}
          fill="var(--color-text-muted)"
          role="button"
          tabIndex={0}
          aria-label={`${label} ${e.as_of_date}: ${e.value}`}
          style={{ cursor: "pointer" }}
          onClick={() => navigate(`/documents/${e.document_id}/source?fact=${e.fact_id}`)}
        >
          <title>
            {e.as_of_date}: {e.value}
          </title>
        </circle>
      ))}
    </g>
  );
}

export function Timeline({ patientId }: { patientId: string }) {
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const latestLoad = useRef(0);

  const load = useCallback(async () => {
    const token = ++latestLoad.current;
    try {
      const result = await api.getTimeline(patientId);
      if (token !== latestLoad.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (token !== latestLoad.current) return;
      setError(err instanceof ApiError ? err.message : "Failed to load timeline.");
    } finally {
      if (token === latestLoad.current) setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    void load();
  }, [load]);

  if (loading) return <p className="muted">Loading...</p>;
  if (!data) return <div className="error-banner">{error ?? "Timeline not found."}</div>;

  const isEmpty = data.markers.length === 0 && data.treatment.length === 0 && data.radiology.length === 0;
  const model: MultiSeriesLine[] = buildMultiSeriesModel(data.markers);

  const allDates = [
    ...data.markers.flatMap((m) => m.points.map((p) => p.as_of_date)),
    ...data.treatment.map((t) => t.as_of_date),
    ...data.radiology.map((r) => r.as_of_date),
  ].map((d) => new Date(d).getTime());
  const minDate = allDates.length ? Math.min(...allDates) : 0;
  const maxDate = allDates.length ? Math.max(...allDates) : 0;
  const dateSpan = maxDate - minDate || 1;
  const x = (d: number) => PAD_X + ((d - minDate) / dateSpan) * (WIDTH - 2 * PAD_X);
  const yFromPct = (pct: number) => PLOT_BOTTOM - (pct / 100) * (PLOT_BOTTOM - PLOT_TOP);

  return (
    <div>
      <div className="page-heading">
        <h1>Timeline</h1>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${patientId}/snapshot`)}>
          Back to snapshot
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        {isEmpty ? (
          <p className="muted">No signed-off history yet to chart.</p>
        ) : (
          <>
            <svg
              width={WIDTH}
              height={HEIGHT}
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label="Cross-block correlation timeline"
            >
              {model.map((series, i) => (
                <g key={series.tracked_marker_id}>
                  {series.points.length >= 2 && (
                    <polyline
                      points={series.points.map((p) => `${x(new Date(p.date).getTime())},${yFromPct(p.pct)}`).join(" ")}
                      fill="none"
                      stroke={MARKER_COLORS[i % MARKER_COLORS.length]}
                      strokeWidth={2}
                    />
                  )}
                  {series.points.map((p) => (
                    <circle
                      key={`${series.tracked_marker_id}-${p.date}-${p.value}`}
                      cx={x(new Date(p.date).getTime())}
                      cy={yFromPct(p.pct)}
                      r={3}
                      fill={MARKER_COLORS[i % MARKER_COLORS.length]}
                    >
                      <title>
                        {series.marker_name} — {p.date}: {p.value}
                        {p.unit ? ` ${p.unit}` : ""}
                      </title>
                    </circle>
                  ))}
                </g>
              ))}

              <EventTicks label="Treatment" entries={data.treatment} y={TREATMENT_TICK_Y} x={x} />
              <EventTicks label="Radiology" entries={data.radiology} y={RADIOLOGY_TICK_Y} x={x} />

              <text x={PAD_X} y={DATE_LABEL_Y} fontSize="9" fill="var(--color-text-muted)">
                {new Date(minDate).toISOString().slice(0, 10)}
              </text>
              <text x={WIDTH - PAD_X} y={DATE_LABEL_Y} fontSize="9" fill="var(--color-text-muted)" textAnchor="end">
                {new Date(maxDate).toISOString().slice(0, 10)}
              </text>
            </svg>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
              {model.map((series, i) => {
                const last = series.points.at(-1);
                return (
                  <span key={series.tracked_marker_id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: "50%",
                        background: MARKER_COLORS[i % MARKER_COLORS.length],
                        display: "inline-block",
                      }}
                    />
                    {series.marker_name}
                    {last && ` — ${last.value}${last.unit ? ` ${last.unit}` : ""}`}
                  </span>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire the route in `App.tsx`**

```ts
import { Timeline } from "./screens/Timeline";
```

```ts
import {
  useHashRoute,
  matchPatientUpload,
  matchDocumentReview,
  matchPatientSnapshot,
  matchPatientMarkers,
  matchPatientEdit,
  matchPatientHistory,
  matchPatientTimeline,
  matchDocumentSource,
  matchConflict,
} from "./router";
```

```ts
  const historyPatientId = matchPatientHistory(route);
  const timelinePatientId = matchPatientTimeline(route);
```

```ts
  } else if (historyPatientId) {
    screen = <VisitHistory patientId={historyPatientId} />;
  } else if (timelinePatientId) {
    screen = <Timeline patientId={timelinePatientId} />;
  } else if (snapshotPatientId) {
```

- [ ] **Step 4: Add the entry point button on `Snapshot.tsx`**

In `apps/web/src/screens/Snapshot.tsx`, after the existing "Visit history"
button:

```tsx
            <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${patient.id}/history`)}>
              Visit history
            </button>
            <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${patient.id}/timeline`)}>
              Timeline
            </button>
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/web && bunx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/screens/Timeline.tsx apps/web/src/router.ts apps/web/src/App.tsx apps/web/src/screens/Snapshot.tsx
git commit -m "web: cross-block correlation timeline screen (m3-backlog #2)"
```

---

## Task 5: E2E smoke test

**Files:**
- Modify: `apps/web/e2e/smoke.test.ts`

**Interfaces:**
- Consumes: the existing `openSnapshot(role, body, trends, extraRoute)` helper
  (`apps/web/e2e/smoke.test.ts`) and `snapshotBody`/`snapshotField` builders
  already in that file, plus Task 4's `Timeline` screen and Task 1's endpoint
  shape.
- Produces: no new exports — a `test(...)` block only.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/e2e/smoke.test.ts`:

```ts
test("Snapshot -> Timeline: navigates via the new button, renders the chart/legend/tick rows, and a tick click lands on Source view for the right fact", async () => {
  const timelineBody = {
    markers: [
      {
        tracked_marker_id: "m1",
        marker_name: "CEA",
        points: [
          { fact_id: "f1", value: "3.0", unit: "ng/mL", as_of_date: "2026-01-01", visit_id: "v1" },
          { fact_id: "f2", value: "9.0", unit: "ng/mL", as_of_date: "2026-02-01", visit_id: "v2" },
        ],
      },
    ],
    treatment: [],
    radiology: [
      {
        fact_id: "rf1", value: "no new lesions", as_of_date: "2026-02-01", visit_id: "v2",
        document_id: "doc1", source_page: 2, source_location: null, source_snippet: "no new lesions",
        fallback_level: "exact",
      },
    ],
  };

  const { page } = await openSnapshot("staff", snapshotBody(), {}, (path) => {
    if (path === "/patients/p1/timeline") return timelineBody;
    if (path === "/documents/doc1") {
      return {
        document: {
          id: "doc1", patient_id: "p1", visit_id: "v2", file_ref: "local://p1/x.pdf",
          document_type: "radiology", imaging_modality: null, source_origin: "own_hospital",
          uploaded_by: "u1", uploaded_at: "2026-02-01T00:00:00Z", ocr_status: "done",
          ocr_text_ref: null, needs_manual_date: false, extraction_status: "complete", extraction_error: null,
        },
        ocr: { pages: [{ page_number: 1, text: "no new lesions" }] },
      };
    }
    return undefined;
  });

  await page.getByRole("button", { name: "Timeline" }).click();
  await page.getByRole("heading", { name: "Timeline" }).waitFor();

  await page.getByText("CEA — 9", { exact: false }).waitFor();
  await page.getByRole("button", { name: /Radiology 2026-02-01/ }).click();
  await page.getByRole("heading", { name: "Source document" }).waitFor();
}, 30_000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && bunx playwright install chromium && bun run test:e2e`
Expected: FAIL — no "Timeline" button exists yet / route 404s (only if Task 4
wasn't already applied; if run after Task 4 this instead validates the real
behavior, so run this step right after Task 1-4 are complete).

- [ ] **Step 3: Run the full e2e suite to verify it (and everything else) passes**

Run: `bun run --cwd apps/web test:e2e`
Expected: PASS, all tests including the new one.

- [ ] **Step 4: Commit**

```bash
git add apps/web/e2e/smoke.test.ts
git commit -m "web: e2e coverage for the Snapshot -> Timeline entry point"
```
