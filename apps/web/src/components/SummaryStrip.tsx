import { useEffect, useState } from "react";
import { api, type PatientSummary, type SummaryItem } from "../api/client";
import { latestItem } from "../lib/latestItem";
import { navigate } from "../router";
import { NOT_EXTRACTED_TEXT, NOT_FOUND_TEXT, SourceLink, sourceLine } from "./SummaryBits";

function Cell({ label, item, date }: { label: string; item: SummaryItem | null; date?: string | null }) {
  return (
    <div>
      <h6 className="muted">{label}</h6>
      {item ? (
        <>
          <div>{item.text}</div>
          <div className="summary-row__source">
            {date ? `${date} · ` : ""}
            {sourceLine(item)} <SourceLink item={item} />
          </div>
        </>
      ) : (
        <div className="muted">{NOT_FOUND_TEXT}</div>
      )}
    </div>
  );
}

// Best-effort strip: a failure to load just hides it (the Snapshot itself must never depend on it).
export function SummaryStrip({ patientId }: { patientId: string }) {
  const [data, setData] = useState<PatientSummary | null>(null);

  useEffect(() => {
    let current = true;
    setData(null);
    api
      .getPatientSummary(patientId)
      .then((r) => {
        if (current) setData(r);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [patientId]);

  if (!data) return null;
  const prescription = data.prescriptions[0];

  return (
    <section className="card summary-strip" aria-label="Patient summary" data-testid="summary-strip">
      <div className="page-heading" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Patient summary</h2>
        <a
          className="btn btn--ghost"
          href={`#/patients/${patientId}/summary`}
          onClick={(e) => {
            e.preventDefault();
            navigate(`/patients/${patientId}/summary`);
          }}
        >
          Full summary →
        </a>
      </div>
      <div className="summary-strip__cells">
        <Cell label="Diagnosis" item={latestItem(data.disease_history.diagnosis)} />
        <Cell label="Surgery" item={latestItem(data.procedures)} />
        <Cell label="Last prescription" item={latestItem(prescription?.regimens ?? [])} date={prescription?.date} />
        <div>
          <h6 className="muted">Other history</h6>
          <div className="muted">{NOT_EXTRACTED_TEXT}</div>
        </div>
      </div>
    </section>
  );
}
