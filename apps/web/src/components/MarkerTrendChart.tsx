import { useEffect, useState } from "react";
import { api, ApiError, type MarkerTrendPoint } from "../api/client";
import { buildTrendChartModel, bandRangeForPoints } from "../lib/trendChart";

const WIDTH = 240;
const HEIGHT = 80;
const PAD_X = 10;
const PAD_TOP = 14;
const PAD_BOTTOM = 14; // plot-area padding; the date-label row below is separate
const DATE_LABEL_Y = HEIGHT - 4;
const PLOT_BOTTOM = HEIGHT - PAD_BOTTOM - 12; // leaves room for the date-label row

// Display only: no interpretive text, no trend/status language, and never the app's
// terracotta accent, red, or success-green — a value's trajectory carries no good/bad
// judgment here (Decisions Log's "never a clinical alarm" rule). The only axis labels
// are the first/last as_of_date and the min/max value+unit — no gridlines. A neutral
// band shows the reference range only when every plotted point agrees on the exact
// same range text and it parses; never a band stitched from differing ranges.
export function MarkerTrendChart({
  patientId,
  trackedMarkerId,
}: {
  patientId: string;
  trackedMarkerId: string;
}) {
  const [points, setPoints] = useState<MarkerTrendPoint[] | null>(null);

  useEffect(() => {
    let live = true;
    api
      .getMarkerTrend(patientId, trackedMarkerId)
      .then((trend) => {
        if (live) setPoints(trend.points);
      })
      .catch((err) => {
        if (live && err instanceof ApiError) setPoints([]);
      });
    return () => {
      live = false;
    };
  }, [patientId, trackedMarkerId]);

  if (points === null) return null;

  const model = buildTrendChartModel(points);
  if (model.kind === "none") return null;
  if (model.kind === "mixed_units") {
    return <p className="field-hint">Units differ across these values — chart not shown.</p>;
  }

  const values = model.points.map((p) => p.value);
  const dates = model.points.map((p) => new Date(p.date).getTime());
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const valueSpan = maxValue - minValue || 1;
  const minDate = Math.min(...dates);
  const maxDate = Math.max(...dates);
  const dateSpan = maxDate - minDate || 1;

  const x = (d: number) => PAD_X + ((d - minDate) / dateSpan) * (WIDTH - 2 * PAD_X);
  const y = (v: number) => PLOT_BOTTOM - ((v - minValue) / valueSpan) * (PLOT_BOTTOM - PAD_TOP);

  const band = bandRangeForPoints(points);
  const bandLow = band?.low ?? null;
  const bandHigh = band?.high ?? null;
  const unitSuffix = model.unit ? ` ${model.unit}` : "";

  return (
    <svg
      width={WIDTH}
      height={HEIGHT}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`Trend chart, ${model.points.length} values from ${model.points[0]!.date} to ${model.points.at(-1)!.date}`}
    >
      {(bandLow !== null || bandHigh !== null) && (
        <rect
          x={PAD_X}
          y={y(Math.min(bandHigh ?? maxValue, maxValue))}
          width={WIDTH - 2 * PAD_X}
          height={Math.max(0, y(Math.max(bandLow ?? minValue, minValue)) - y(Math.min(bandHigh ?? maxValue, maxValue)))}
          fill="var(--color-surface-sunken)"
        />
      )}
      <polyline
        points={model.points.map((p) => `${x(new Date(p.date).getTime())},${y(p.value)}`).join(" ")}
        fill="none"
        stroke="var(--color-chart-line)"
        strokeWidth={2}
      />
      {model.points.map((p) => (
        <circle key={p.date} cx={x(new Date(p.date).getTime())} cy={y(p.value)} r={3} fill="var(--color-chart-line)">
          <title>
            {p.date}: {p.value}
            {unitSuffix}
          </title>
        </circle>
      ))}

      {/* y-axis: min/max value + unit, no gridlines */}
      <text x={PAD_X} y={PAD_TOP - 4} fontSize="9" fill="var(--color-text-muted)">
        {maxValue}
        {unitSuffix}
      </text>
      <text x={PAD_X} y={PLOT_BOTTOM + 10} fontSize="9" fill="var(--color-text-muted)">
        {minValue}
        {unitSuffix}
      </text>

      {/* x-axis: first/last as_of_date */}
      <text x={PAD_X} y={DATE_LABEL_Y} fontSize="9" fill="var(--color-text-muted)">
        {model.points[0]!.date}
      </text>
      <text x={WIDTH - PAD_X} y={DATE_LABEL_Y} fontSize="9" fill="var(--color-text-muted)" textAnchor="end">
        {model.points.at(-1)!.date}
      </text>
    </svg>
  );
}
