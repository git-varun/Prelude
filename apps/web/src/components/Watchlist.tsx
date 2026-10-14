import { useState } from "react";
import { RoleGate } from "../auth/AuthContext";
import { api, ApiError, type WatchlistEntry, type PatientSnapshot } from "../api/client";
import { flagForRange, parseReferenceRange } from "../lib/referenceRange";
import { navigate } from "../router";

const W = 120;
const H = 32;
const PAD = 4;

// Neutral grey line and band; an out-of-range latest value is a hollow marker, never a colour.
function Sparkline({ entry, outOfRange }: { entry: WatchlistEntry; outOfRange: boolean }) {
  const nums = entry.sparkline.map((p) => Number(p.value.trim()));
  if (nums.length === 0 || nums.some((n) => !Number.isFinite(n))) return null;
  const range = parseReferenceRange(entry.latest?.reference_range ?? null);
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const y = (v: number) => H - PAD - ((Math.min(Math.max(v, lo), hi) - lo) / span) * (H - 2 * PAD);
  const x = (i: number) => (nums.length === 1 ? W / 2 : PAD + (i / (nums.length - 1)) * (W - 2 * PAD));
  const bandTop = range?.high != null ? y(range.high) : 0;
  const bandBottom = range?.low != null ? y(range.low) : H;
  const last = nums.length - 1;
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${entry.marker_name} last ${nums.length} values`}>
      {range && <rect x={0} y={bandTop} width={W} height={Math.max(bandBottom - bandTop, 0)} fill="#ddd9cc" />}
      {nums.length > 1 && (
        <polyline fill="none" stroke="var(--color-chart-line)" strokeWidth={1.5} points={nums.map((n, i) => `${x(i)},${y(n)}`).join(" ")} />
      )}
      <circle
        cx={x(last)} cy={y(nums[last]!)} r={3} strokeWidth={1.5} stroke="var(--color-chart-line)"
        fill={outOfRange ? "var(--color-surface)" : "var(--color-chart-line)"}
      />
    </svg>
  );
}

function Cell({ entry }: { entry: WatchlistEntry }) {
  const latest = entry.latest;
  if (entry.missing || !latest) {
    const seen = entry.last_seen;
    return (
      <div className="watch-cell" data-testid="watch-cell">
        <h6>{entry.marker_name}</h6>
        <div className="watch-cell__value watch-cell__value--missing">—</div>
        <div className="muted">
          Not in this visit ·{" "}
          {seen ? `last ${seen.value}${seen.unit ? ` ${seen.unit}` : ""} on ${seen.as_of_date}` : "no earlier value"}
        </div>
      </div>
    );
  }
  const flag = flagForRange(latest.value, latest.reference_range);
  const meta = [
    latest.unit,
    latest.reference_range ? `ref ${latest.reference_range}` : null,
    flag ? `${flag} reference range` : null,
    latest.was ? `was ${latest.was.value ?? "—"}${latest.was.unit ? ` ${latest.was.unit}` : ""}` : null,
  ].filter(Boolean);
  const body = (
    <>
      <h6>{entry.marker_name}</h6>
      <div className="watch-cell__value">{latest.value ?? "—"}</div>
      <Sparkline entry={entry} outOfRange={flag !== null} />
      <div className="muted">{meta.join(" · ")}</div>
    </>
  );
  // Same target as a fact's "View uploaded document" link; no link when the fact has no document.
  return latest.document_id ? (
    <button
      type="button" className="watch-cell watch-cell--link" data-testid="watch-cell"
      onClick={() => navigate(`/documents/${latest.document_id}/source?fact=${latest.fact_id}`)}
    >
      {body}
    </button>
  ) : (
    <div className="watch-cell" data-testid="watch-cell">{body}</div>
  );
}

export function Watchlist({ data, onChanged }: { data: PatientSnapshot; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [suggesting, setSuggesting] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { watchlist, suggested_pins: suggested, pin_options: options } = data;
  if (options.length === 0) return null;

  const pinners = [...new Set(watchlist.map((w) => w.pinned_by_name).filter(Boolean))].join(", ");
  const suggesters = [...new Set(suggested.map((s) => s.suggested_by_name))].join(", ");

  async function run(action: () => Promise<unknown>, fail: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setSuggesting(null);
      setNote("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fail);
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <section aria-labelledby="section-watchlist" style={{ marginBottom: 32 }}>
      <div className="page-heading" style={{ marginBottom: 8 }}>
        <h6 id="section-watchlist" style={{ margin: 0 }}>
          Watchlist{pinners ? ` · pinned by ${pinners}` : ""}
        </h6>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {suggested.length > 0 && (
            <span className="tag" data-testid="suggested-pin-tag">
              {suggested.length} suggested pin{suggested.length === 1 ? "" : "s"} from {suggesters}
            </span>
          )}
          <button className="btn btn--ghost" type="button" onClick={() => setEditing((e) => !e)}>
            {editing ? "Close pins" : "Edit pins"}
          </button>
        </span>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <RoleGate roles={["oncologist"]}>
        {suggested.length > 0 && (
          <div className="card" role="status" data-testid="suggested-pin-banner">
            {suggested.map((s) => (
              <div key={s.tracked_marker_id} className="watch-suggestion">
                <span>
                  <strong>{s.marker_name}</strong> · suggested by {s.suggested_by_name}
                  {s.note ? ` · “${s.note}”` : ""}
                </span>
                <span style={{ display: "flex", gap: 8 }}>
                  <button className="btn btn--primary" type="button" disabled={busy}
                    onClick={() => void run(() => api.setMarkerPin(s.tracked_marker_id, true), "Failed to pin.")}>
                    Accept
                  </button>
                  <button className="btn btn--secondary" type="button" disabled={busy}
                    onClick={() => void run(() => api.dismissPinSuggestion(s.tracked_marker_id), "Failed to dismiss.")}>
                    Dismiss
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </RoleGate>

      {watchlist.length === 0 ? (
        <p className="muted">No pinned markers.</p>
      ) : (
        <div className="watch-grid">
          {watchlist.map((w) => <Cell key={w.tracked_marker_id} entry={w} />)}
        </div>
      )}

      {editing && (
        <div className="card" data-testid="edit-pins">
          {options.map((o) => (
            <div key={o.tracked_marker_id} className="watch-suggestion">
              <span>
                {o.marker_name} {o.is_pinned && <span className="tag">Pinned</span>}{" "}
                {!o.is_pinned && o.suggested && <span className="tag">Suggested pin</span>}
              </span>
              <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <RoleGate roles={["oncologist"]}>
                  <button className="btn btn--secondary" type="button" disabled={busy}
                    onClick={() => void run(() => api.setMarkerPin(o.tracked_marker_id, !o.is_pinned), "Failed to update pin.")}>
                    {o.is_pinned ? "Unpin" : "Pin"}
                  </button>
                </RoleGate>
                <RoleGate roles={["staff"]}>
                  {!o.is_pinned && suggesting !== o.tracked_marker_id && (
                    <button className="btn btn--secondary" type="button" disabled={busy}
                      onClick={() => { setSuggesting(o.tracked_marker_id); setNote(""); }}>
                      Suggest pin
                    </button>
                  )}
                  {suggesting === o.tracked_marker_id && (
                    <>
                      <input aria-label={`Note for ${o.marker_name} (optional)`} placeholder="Note (optional)" value={note}
                        maxLength={500} onChange={(e) => setNote(e.target.value)} />
                      <button className="btn btn--primary" type="button" disabled={busy}
                        onClick={() => void run(() => api.suggestMarkerPin(o.tracked_marker_id, note), "Failed to send suggestion.")}>
                        Send suggestion
                      </button>
                    </>
                  )}
                </RoleGate>
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
