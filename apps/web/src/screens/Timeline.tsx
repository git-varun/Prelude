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
