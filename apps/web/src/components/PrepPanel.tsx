import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type VisitPrep } from "../api/client";

// M3-09: what is still open before this visit can be marked ready. Open conflicts are not listed: they do not block.
// `refreshKey` changes whenever the snapshot reloads, so the checklist follows the facts.
export function PrepPanel({ visitId, refreshKey }: { visitId: string; refreshKey: unknown }) {
  const [prep, setPrep] = useState<VisitPrep | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const result = await api.getVisitPrep(visitId);
      if (mine === seq.current) setPrep(result);
    } catch {
      if (mine === seq.current) setPrep(null);
    }
  }, [visitId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function change(ready: boolean) {
    setBusy(true);
    setError(null);
    try {
      seq.current++;
      setPrep(await api.setVisitPrep(visitId, ready));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "We couldn't save that. Please try again.");
      void load();
    } finally {
      setBusy(false);
    }
  }

  // A failed load shows no panel: the snapshot itself must never depend on it.
  if (!prep) return null;
  const ready = prep.prep_status === "ready";
  const blocked = prep.items.filter((i) => !i.ok);

  return (
    <section className="card prep-panel" aria-label="Visit preparation" data-testid="prep-panel">
      <div className="prep-panel__head">
        <strong>{ready ? "Ready for the oncologist" : "Preparing this visit"}</strong>
        {ready && prep.prep_set_by_name && <span className="muted"> · marked by {prep.prep_set_by_name}</span>}
      </div>
      <ul className="prep-panel__list">
        {prep.items.map((item) => (
          <li key={item.key} data-testid={`prep-item-${item.key}`} data-ok={item.ok}>
            <span role="img" aria-label={item.ok ? "Complete" : "Not complete"}>{item.ok ? "✓" : "○"}</span> {item.label}
            {item.reason && <span className="muted"> · {item.reason}</span>}
          </li>
        ))}
      </ul>
      {ready && prep.changed_since_ready.length > 0 && (
        <p className="muted" role="status" data-testid="prep-changed">
          Marked ready earlier. Since then: {blocked.map((i) => i.reason).join("; ")}.
        </p>
      )}
      {error && <div className="error-banner">{error}</div>}
      <div className="prep-panel__actions">
        {!ready && (
          <button className="btn btn--primary" type="button" disabled={busy || !prep.can_mark_ready} onClick={() => void change(true)}>
            Mark ready
          </button>
        )}
        {ready && (
          <button className="btn btn--secondary" type="button" disabled={busy} onClick={() => void change(false)}>
            Back to preparing
          </button>
        )}
        {!ready && !prep.can_mark_ready && <span className="muted">Mark ready needs every item above.</span>}
      </div>
    </section>
  );
}
