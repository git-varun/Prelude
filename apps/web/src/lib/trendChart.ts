import { parseReferenceRange, type ParsedRange } from "./referenceRange";

export interface TrendPoint {
  fact_id: string;
  value: string;
  unit: string | null;
  reference_range: string | null;
  as_of_date: string;
  visit_id: string;
}

export type TrendChartModel =
  | { kind: "none" }
  | { kind: "mixed_units" }
  | { kind: "line"; unit: string | null; points: { date: string; value: number }[] };

function normalizeUnit(unit: string | null): string | null {
  return unit === null ? null : unit.trim().toLowerCase();
}

// Fewer than 2 points -> no chart. Different units (case/whitespace-normalized; null counts as
// its own distinct unit) never draw a single line — units are never converted (M5's rule) — the
// caller shows a "units differ" note instead.
export function buildTrendChartModel(points: TrendPoint[]): TrendChartModel {
  if (points.length < 2) return { kind: "none" };

  const firstUnit = normalizeUnit(points[0]!.unit);
  if (points.some((p) => normalizeUnit(p.unit) !== firstUnit)) {
    return { kind: "mixed_units" };
  }

  return {
    kind: "line",
    unit: points[0]!.unit,
    points: points.map((p) => ({ date: p.as_of_date, value: Number(p.value) })),
  };
}

// Draws the neutral reference band only when every point agrees on the same reference_range
// text (whitespace-normalized) and that text parses — never a band stitched together from
// different points' ranges, and never a guessed one.
export function bandRangeForPoints(points: TrendPoint[]): ParsedRange | null {
  if (points.length === 0) return null;
  const normalized = points.map((p) => (p.reference_range === null ? null : p.reference_range.trim()));
  const first = normalized[0]!;
  if (first === null || normalized.some((r) => r !== first)) return null;
  return parseReferenceRange(first);
}

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
  unitsMatch: boolean;
  points: { date: string; value: number; raw: string; unit: string | null; pct: number }[];
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
//
// A non-numeric value (e.g. a censored "<0.1" below the assay's detection limit --
// routine for tumor markers) never poisons the whole line: min/max are computed over
// the finite values only, and a non-numeric point's own pct falls back to the midpoint.
// `raw` always carries the original string so the UI can display it even when `value`
// is NaN -- the real value is never discarded, only its chart position is approximated.
//
// `unitsMatch` flags when a single marker's own points disagree on unit (case/whitespace-
// tolerant, same normalization as buildTrendChartModel). This is a different question from
// per-marker normalization above: two different units for the *same* marker drawn as one
// connecting line would imply a trend that isn't real, the same risk buildTrendChartModel
// already guards against for the single-marker Snapshot chart ("units are never
// converted"). The caller is expected to skip the connecting line when this is false.
export function buildMultiSeriesModel(markers: MultiSeriesInput[]): MultiSeriesLine[] {
  return markers.map((m) => {
    const numericValues = m.points.map((p) => Number(p.value));
    const finiteValues = numericValues.filter((n) => Number.isFinite(n));
    const min = finiteValues.length ? Math.min(...finiteValues) : 0;
    const max = finiteValues.length ? Math.max(...finiteValues) : 0;
    const span = max - min || 1;

    const firstUnit = normalizeUnit(m.points[0]?.unit ?? null);
    const unitsMatch = m.points.every((p) => normalizeUnit(p.unit) === firstUnit);

    return {
      tracked_marker_id: m.tracked_marker_id,
      marker_name: m.marker_name,
      unitsMatch,
      points: m.points.map((p, i) => {
        const n = numericValues[i]!;
        const pct = !Number.isFinite(n) || finiteValues.length <= 1 ? 50 : ((n - min) / span) * 100;
        return { date: p.as_of_date, value: n, raw: p.value, unit: p.unit, pct };
      }),
    };
  });
}
