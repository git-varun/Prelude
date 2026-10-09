import { test, expect } from "bun:test";
import { buildTrendChartModel, bandRangeForPoints, buildMultiSeriesModel, type TrendPoint, type MultiSeriesInput } from "./trendChart";

function point(overrides: Partial<TrendPoint> = {}): TrendPoint {
  return {
    fact_id: "f1", value: "4.2", unit: "ng/mL", reference_range: "0-5",
    as_of_date: "2026-01-01", visit_id: "v1", ...overrides,
  };
}

test("fewer than 2 points -> no chart", () => {
  expect(buildTrendChartModel([])).toEqual({ kind: "none" });
  expect(buildTrendChartModel([point()])).toEqual({ kind: "none" });
});

test("2+ points with the same unit (case/whitespace-tolerant) draw a single line", () => {
  const points = [
    point({ fact_id: "f1", value: "3.0", unit: "ng/mL", as_of_date: "2026-01-01" }),
    point({ fact_id: "f2", value: "5.0", unit: " NG/ML ", as_of_date: "2026-02-01" }),
  ];
  const model = buildTrendChartModel(points);
  expect(model.kind).toBe("line");
  if (model.kind === "line") {
    expect(model.unit).toBe("ng/mL");
    expect(model.points).toEqual([
      { date: "2026-01-01", value: 3.0 },
      { date: "2026-02-01", value: 5.0 },
    ]);
  }
});

test("mixed units never draw a single line — reports 'units differ' instead", () => {
  const points = [point({ unit: "ng/mL" }), point({ unit: "U/mL" })];
  const model = buildTrendChartModel(points);
  expect(model.kind).toBe("mixed_units");
});

test("a null unit counts as different from a non-null unit", () => {
  const points = [point({ unit: "ng/mL" }), point({ unit: null })];
  expect(buildTrendChartModel(points).kind).toBe("mixed_units");
});

test("bandRangeForPoints draws a band when every point's reference_range is identical and parses", () => {
  const points = [point({ reference_range: "0-5" }), point({ reference_range: " 0-5 " })];
  expect(bandRangeForPoints(points)).toEqual({ low: 0, high: 5, exclusive: false });
});

test("bandRangeForPoints returns null when reference ranges differ across points", () => {
  const points = [point({ reference_range: "0-5" }), point({ reference_range: "0-6" })];
  expect(bandRangeForPoints(points)).toBeNull();
});

test("bandRangeForPoints returns null when any point is missing a reference_range", () => {
  const points = [point({ reference_range: "0-5" }), point({ reference_range: null })];
  expect(bandRangeForPoints(points)).toBeNull();
});

test("bandRangeForPoints returns null when the shared range text doesn't parse", () => {
  const points = [point({ reference_range: "see report" }), point({ reference_range: "see report" })];
  expect(bandRangeForPoints(points)).toBeNull();
});

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
