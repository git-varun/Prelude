import { useState } from "react";
import { RoleGate } from "../auth/AuthContext";
import { api, type PlanItem } from "../api/client";

const withTitle = (name: string | null) => (name ? (/^dr\b\.?/i.test(name) ? name : `Dr. ${name}`) : "the oncologist");

// M3-09 interim for the B7 work queues: staff see what the oncologist asked them to find, per patient, and clear it.
export function ReportRequestBanner({ items, onChanged }: { items: PlanItem[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const requested = items.filter((i) => i.report_request);
  if (requested.length === 0) return null;

  async function clear(id: string) {
    setError(null);
    try {
      await api.clearPlanItemReportRequest(id);
      onChanged();
    } catch {
      setError("We couldn't clear that request. Please try again.");
    }
  }

  return (
    <RoleGate roles={["staff"]}>
      {requested.map((item) => (
        <div className="card report-request" role="status" data-testid="report-request-banner" key={item.id}>
          <span>
            Requested by {withTitle(item.report_request!.by_name)}: find report for &quot;{item.text}&quot;
          </span>
          <button className="btn btn--secondary" type="button" onClick={() => void clear(item.id)}>
            Mark found / clear
          </button>
        </div>
      ))}
      {error && <div className="error-banner">{error}</div>}
    </RoleGate>
  );
}
