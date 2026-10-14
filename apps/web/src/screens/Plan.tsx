import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type PatientPlan, type PlanItem, type PlanItemType } from "../api/client";
import { navigate } from "../router";

const TYPE_LABELS: Record<PlanItemType, string> = { test: "Test", procedure: "Procedure", review: "Review" };

// "27 Oct" (or "27 Oct 2026"), from a YYYY-MM-DD string; never shifted by the viewer's time zone.
function shortDate(iso: string, withYear = false): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC",
  });
}

// The date the item is due: one written in the text, else the approximate one (marked ≈), else none.
export function dueLabel(item: PlanItem, withYear = false): string | null {
  if (item.stated_date) return shortDate(item.stated_date, true);
  return item.approx_date ? `≈${shortDate(item.approx_date, withYear)}` : null;
}

// Only the four allowed status wordings; the date appears here and nowhere else in the row.
function statusText(item: PlanItem): string {
  switch (item.status) {
    case "report_seen":
      return `Report seen · ${item.matched_document?.label ?? ""}`;
    case "report_suggested":
      return `Report seen · ${item.suggested_document?.label ?? ""} · confirm match`;
    case "past_advised":
      return dueLabel(item) ? `Past advised date · ${dueLabel(item)} · no report seen` : "Past advised date · no report seen";
    default:
      return dueLabel(item) ? `Planned · ${dueLabel(item)}` : "Planned";
  }
}

function SourceLink({ item }: { item: PlanItem }) {
  if (!item.source_fact_id || !item.source_document_id) return null;
  const href = `/documents/${item.source_document_id}/source?fact=${item.source_fact_id}`;
  return (
    <a
      className="source-link"
      href={`#${href}`}
      onClick={(e) => {
        e.preventDefault();
        navigate(href);
      }}
    >
      Source
    </a>
  );
}

function AddForm({ patientId, onAdded }: { patientId: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<PlanItemType>("test");
  const [text, setText] = useState("");
  const [advisedAt, setAdvisedAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button className="btn btn--secondary" type="button" onClick={() => setOpen(true)}>
        + Add plan item
      </button>
    );
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.addPlanItem(patientId, { type, text: text.trim(), advised_at: advisedAt });
      setText("");
      setAdvisedAt("");
      setOpen(false);
      onAdded();
    } catch {
      setError("We couldn't add this plan item. Check the text and date, then try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card plan-form" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor="plan-type">Type</label>
        <select id="plan-type" value={type} onChange={(e) => setType(e.target.value as PlanItemType)}>
          <option value="test">Test</option>
          <option value="procedure">Procedure</option>
          <option value="review">Review</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="plan-text">As written</label>
        <input id="plan-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. CT chest within 2 weeks" />
      </div>
      <div className="field">
        <label htmlFor="plan-date">Advised on</label>
        <input id="plan-date" type="date" value={advisedAt} onChange={(e) => setAdvisedAt(e.target.value)} />
      </div>
      {error && <div className="error-banner">{error}</div>}
      <button className="btn btn--primary" type="submit" disabled={saving || text.trim() === "" || advisedAt === ""}>
        Add
      </button>{" "}
      <button className="btn btn--ghost" type="button" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

export function Plan({ patientId }: { patientId: string }) {
  const [data, setData] = useState<PatientPlan | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const token = ++latest.current;
    setLoading(true);
    setData(null);
    setFailed(false);
    try {
      const result = await api.getPatientPlan(patientId);
      if (token !== latest.current) return;
      setData(result);
    } catch {
      if (token !== latest.current) return;
      setFailed(true);
    } finally {
      if (token === latest.current) setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void load();
    return () => {
      latest.current++;
    };
  }, [load]);

  const setMatch = async (itemId: string, documentId: string | null) => {
    setActionError(null);
    try {
      await api.setPlanItemMatch(itemId, documentId);
      await load();
    } catch {
      setActionError("We couldn't save that match. Please try again.");
    }
  };

  if (loading) return <p className="muted">Loading...</p>;
  if (!data) {
    return (
      <div>
        <div className="error-banner">{failed ? "We couldn't load this plan right now. Please try again." : "Patient not found."}</div>
        <button className="btn btn--secondary" type="button" onClick={() => void load()}>
          Retry
        </button>{" "}
        <button className="btn btn--ghost" type="button" onClick={() => navigate("/patients")}>
          Back to patient list
        </button>
      </div>
    );
  }

  const review = data.next_review;

  return (
    <div>
      <div className="page-heading">
        <div>
          <h6 className="muted" style={{ margin: 0 }}>Plan</h6>
          <h1>
            {review
              ? `Next review ${review.text}${dueLabel(review, true) ? ` · ${dueLabel(review, true)}` : ""}`
              : "No next review found in documents"}
          </h1>
          {review && <span className="summary-row__source">advised {shortDate(review.advised_at, true)}</span>}
          {review && <SourceLink item={review} />}
        </div>
        <button className="btn btn--ghost" type="button" onClick={() => navigate(`/patients/${patientId}/snapshot`)}>
          Open today&apos;s snapshot →
        </button>
      </div>

      {actionError && <div className="error-banner">{actionError}</div>}

      <section className="summary-section" aria-label="Plan items">
        <h2>Plan items</h2>
        {data.items.length === 0 ? (
          <p className="muted">Not found in documents</p>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            {data.items.map((item) => (
              <div className="plan-row" key={item.id} data-testid="plan-row">
                <span className="tag">{TYPE_LABELS[item.type]}</span>
                <span>
                  {item.text}
                  <span className="summary-row__source">advised {shortDate(item.advised_at, true)}</span>
                </span>
                <span className="plan-row__actions">
                  <span className="tag">{statusText(item)}</span>
                  {item.status === "report_suggested" && item.suggested_document && (
                    <button className="btn btn--secondary" type="button" onClick={() => void setMatch(item.id, item.suggested_document!.id)}>
                      Confirm match
                    </button>
                  )}
                  {item.status === "report_seen" && (
                    <button className="btn btn--ghost" type="button" onClick={() => void setMatch(item.id, null)}>
                      Remove match
                    </button>
                  )}
                  <SourceLink item={item} />
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <AddForm patientId={patientId} onAdded={() => void load()} />
    </div>
  );
}
