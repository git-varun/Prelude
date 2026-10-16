import { useState } from "react";
import { RoleGate } from "../auth/AuthContext";
import { api, ApiError, type WatchlistEntry, type PatientSnapshot } from "../api/client";
import { flagForRange, parseReferenceRange } from "../lib/referenceRange";
import { navigate } from "../router";
import { usePane } from "./PaneContext";
import { ElsewhereTag, elsewhereMark, elsewhereSuffix, trustLabel } from "./SummaryBits";

const W = 120;
const H = 32;
const PAD = 4;

const numeric = (v: string | null) => (v === null || v.trim() === "" ? NaN : Number(v.trim()));

// Neutral grey line and band; shape carries meaning, never colour: a hollow dot is an unsigned point,
// and the latest value's out-of-range state is a hollow emphasis dot. In an open conflict nothing is emphasised.
// The Today list reuses it with just the marker name, its points and the latest reference range.
export type SparklineEntry = Pick<WatchlistEntry, "marker_name" | "sparkline" | "conflict"> & {
  latest: { reference_range: string | null } | null;
};
export function Sparkline({ entry, outOfRange }: { entry: SparklineEntry; outOfRange: boolean }) {
  const pts = entry.sparkline
    .map((p) => ({ n: numeric(p.value), signed: p.verification_state === "oncologist_signed_off", date: p.as_of_date, enc: p.outside_encounter }))
    .filter((p) => Number.isFinite(p.n));
  if (pts.length === 0) return null;
  const nums = pts.map((p) => p.n);
  const range = parseReferenceRange(entry.latest?.reference_range ?? null);
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const span = hi - lo || 1;
  const y = (v: number) => H - PAD - ((Math.min(Math.max(v, lo), hi) - lo) / span) * (H - 2 * PAD);
  const x = (i: number) => (nums.length === 1 ? W / 2 : PAD + (i / (nums.length - 1)) * (W - 2 * PAD));
  const bandTop = range?.high != null ? y(range.high) : 0;
  const bandBottom = range?.low != null ? y(range.low) : H;
  const last = nums.length - 1;
  const stroke = "var(--color-chart-line)";
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${entry.marker_name} last ${nums.length} values`}>
      {range && <rect x={0} y={bandTop} width={W} height={Math.max(bandBottom - bandTop, 0)} fill="#ddd9cc" />}
      {nums.length > 1 && <polyline fill="none" stroke={stroke} strokeWidth={1.5} points={nums.map((n, i) => `${x(i)},${y(n)}`).join(" ")} />}
      {pts.map((p, i) => {
        const emphasis = i === last && !entry.conflict;
        const hollow = !p.signed || (emphasis && outOfRange);
        return (
          <circle key={i} cx={x(i)} cy={y(p.n)} r={emphasis ? 3 : 2} strokeWidth={1.5} stroke={stroke}
            fill={hollow ? "var(--color-surface)" : stroke} {...(p.enc ? elsewhereMark(p.enc, stroke) : {})}>
            <title>{`${p.date}: ${p.n}${elsewhereSuffix(p.enc)}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

// A focusable div (so block children are valid) that opens the document pane at the fact on Enter or Space. A cell
// with no document opens the pane too, which then says so in plain words.
function CellLink({ factId, documentId, children }: { factId: string; documentId: string | null; children: React.ReactNode }) {
  const pane = usePane();
  const open = () => {
    if (pane) pane.openAtFact(factId, documentId);
    else if (documentId) navigate(`/documents/${documentId}/source?fact=${factId}`);
  };
  return (
    <div
      className="watch-cell watch-cell--link" data-testid="watch-cell" role="button" tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
    >
      {children}
    </div>
  );
}

const NO_DOCUMENT = "No document available for this value";

function Cell({ entry }: { entry: WatchlistEntry }) {
  const latest = entry.latest;
  if (entry.missing || !latest) {
    const seen = entry.last_seen;
    const body = (
      <>
        <h6>{entry.marker_name}</h6>
        <div className="watch-cell__value watch-cell__value--missing">—</div>
        <div className="muted">
          Not in this visit ·{" "}
          {seen ? `last ${seen.value}${seen.unit ? ` ${seen.unit}` : ""} on ${seen.as_of_date}` : "no earlier value"}
        </div>
        {seen?.outside_encounter && <div><ElsewhereTag encounter={seen.outside_encounter} /></div>}
        {seen && !seen.document_id && <div className="muted">{NO_DOCUMENT}</div>}
      </>
    );
    return seen
      ? <CellLink factId={seen.fact_id} documentId={seen.document_id ?? null}>{body}</CellLink>
      : <div className="watch-cell" data-testid="watch-cell">{body}</div>;
  }
  const flag = entry.conflict || !Number.isFinite(numeric(latest.value)) ? null : flagForRange(latest.value, latest.reference_range);
  const meta = [
    latest.unit,
    latest.reference_range ? `ref ${latest.reference_range}` : null,
    flag ? `${flag} reference range` : null,
    latest.was ? `was ${latest.was.value ?? "—"}${latest.was.unit ? ` ${latest.was.unit}` : ""}` : null,
    latest.verification_state ? trustLabel(latest.verification_state) : null,
    entry.unit_changed ? "unit changed — earlier values not plotted" : null,
  ].filter(Boolean);
  const body = (
    <>
      <h6>{entry.marker_name}</h6>
      {entry.conflict ? (
        <div>
          <span className="tag tag--range-flag">Sources disagree</span>
          {entry.conflict_id && (
            <button
              className="tag tag--range-flag" type="button" style={{ marginLeft: 8, cursor: "pointer" }}
              onClick={() => navigate(`/conflicts/${entry.conflict_id}`)}
            >
              Conflicting sources — review
            </button>
          )}
        </div>
      ) : (
        <div className="watch-cell__value">{latest.value ?? "—"}</div>
      )}
      <Sparkline entry={entry} outOfRange={flag !== null} />
      <div className="muted">{meta.join(" · ")}</div>
      {latest.outside_encounter && <div><ElsewhereTag encounter={latest.outside_encounter} /></div>}
      {!latest.document_id && !entry.conflict && <div className="muted">{NO_DOCUMENT}</div>}
    </>
  );
  // Same target as a fact's "View uploaded document" link. A conflict cell has its own review link instead.
  return !entry.conflict
    ? <CellLink factId={latest.fact_id} documentId={latest.document_id ?? null}>{body}</CellLink>
    : <div className="watch-cell" data-testid="watch-cell">{body}</div>;
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
        <p className="muted">No pinned markers. Tracked markers are listed under Markers; use Edit pins to watch some of them here.</p>
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
