import { useEffect, useState } from "react";
import { api, type SummaryItem } from "../api/client";
import { navigate } from "../router";
import { sourceHref, sourceLine } from "./SummaryBits";

/** Visits | Trends: the two views of a patient's history (design handoff, section 8). */
export function HistoryTabs({ patientId, active }: { patientId: string; active: "visits" | "trends" }) {
  return (
    <div className="seg" role="tablist" aria-label="History view">
      <button className="seg__opt" type="button" role="tab" aria-selected={active === "visits"} onClick={() => navigate(`/patients/${patientId}/history`)}>
        Visits
      </button>
      <button className="seg__opt" type="button" role="tab" aria-selected={active === "trends"} onClick={() => navigate(`/patients/${patientId}/timeline`)}>
        Trends
      </button>
    </div>
  );
}

const JOURNEY_CELLS = 5;

// Evenly spaced picks across the dated lines, always including the first and the last. Nothing is summarised or ranked.
function pickMilestones(items: SummaryItem[]): SummaryItem[] {
  const dated = items.filter((i) => i.as_of_date).sort((a, b) => (a.as_of_date! < b.as_of_date! ? -1 : a.as_of_date! > b.as_of_date! ? 1 : 0));
  if (dated.length <= JOURNEY_CELLS) return dated;
  return Array.from({ length: JOURNEY_CELLS }, (_, i) => dated[Math.round((i * (dated.length - 1)) / (JOURNEY_CELLS - 1))]!);
}

/** Dated milestones quoted from the documents, as written. Best effort: without them the strip is simply absent. */
export function JourneyStrip({ patientId }: { patientId: string }) {
  const [items, setItems] = useState<SummaryItem[] | null>(null);
  useEffect(() => {
    let live = true;
    setItems(null);
    api.getPatientSummary(patientId).then((r) => live && setItems(r.what_happened)).catch(() => {});
    return () => { live = false; };
  }, [patientId]);
  if (!items) return null;
  const cells = pickMilestones(items);
  if (cells.length === 0) return null;
  return (
    <div className="journey" aria-label="Milestones from the documents" data-testid="journey-strip">
      {cells.map((i) => (
        <div className="journey__cell" key={i.fact_id}>
          <div className="journey__date">{i.as_of_date}{i.outside_encounter ? " · elsewhere" : ""}</div>
          <p className="journey__text">“{i.text}”</p>
          <a className="summary-row__source" href={`#${sourceHref(i)}`}>{sourceLine(i)}</a>
        </div>
      ))}
    </div>
  );
}
