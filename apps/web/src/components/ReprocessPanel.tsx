import { useState } from "react";
import { api, ApiError, type DocumentRecord } from "../api/client";
import { canReprocess, failedStepLabel } from "../lib/reprocess";

/**
 * Offered whenever OCR or extraction failed: re-runs the failed step(s) from the file already on record, so nothing is
 * uploaded again. Renders nothing for a document that cannot be reprocessed.
 */
export function ReprocessPanel({ document, onDone, compact }: { document: DocumentRecord; onDone: (updated: DocumentRecord) => void; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!canReprocess(document)) return null;

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const updated = await api.reprocessDocument(document.id);
      if (!canReprocess(updated)) setMessage(null);
      else setMessage("It failed again. Check the OCR and extraction settings, then try again.");
      onDone(updated);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Reprocessing could not be started.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className={compact ? "reprocess reprocess--compact" : "reprocess"} data-testid="reprocess-panel">
      {!compact && <span className="muted">{failedStepLabel(document)} failed. The file is still on record.</span>}
      <button className="btn btn--secondary" type="button" disabled={busy} onClick={() => void run()}>
        {busy ? "Reprocessing…" : "Reprocess from stored file"}
      </button>
      {message && <span role="status" className="reprocess__message">{message}</span>}
    </span>
  );
}
