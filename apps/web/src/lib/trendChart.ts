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
