import { test, expect } from "bun:test";
import { buildTrendChartModel, bandRangeForPoints, type TrendPoint } from "./trendChart";

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
