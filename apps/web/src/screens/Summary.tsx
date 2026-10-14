import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, type PatientSummary, type SummaryItem } from "../api/client";
import { ElsewhereTag, NOT_EXTRACTED_TEXT, NOT_FOUND_TEXT, SourceLink, sourceLine } from "../components/SummaryBits";
import { navigate } from "../router";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="summary-section" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function KeyedRows({ rows }: { rows: { key: string; items: SummaryItem[] | "not_extracted" }[] }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      {rows.map((r) => {
        if (r.items === "not_extracted" || r.items.length === 0) {
          return (
            <div className="summary-row summary-row--keyed" key={r.key}>
              <span className="summary-row__key">{r.key}</span>
              <span className="muted">{r.items === "not_extracted" ? NOT_EXTRACTED_TEXT : NOT_FOUND_TEXT}</span>
              <span />
            </div>
          );
        }
        return r.items.map((item, i) => (
          <div className={`summary-row summary-row--keyed${item.outside_encounter ? " is-elsewhere" : ""}`} key={item.fact_id}>
            <span className="summary-row__key">{i === 0 ? r.key : ""}</span>
            <span>
              {item.text}
              <span className="summary-row__source">{sourceLine(item)}</span>
            </span>
            <SourceLink item={item} />
          </div>
        ));
      })}
    </div>
  );
}

function PrescriptionLines({ label, items }: { label: string; items: SummaryItem[] }) {
  return (
    <div>
      <h6 className="muted">{label}</h6>
      {items.length === 0 ? (
        <span className="muted">{NOT_FOUND_TEXT}</span>
      ) : (
        items.map((item) => (
          <div key={item.fact_id} className={item.outside_encounter ? "is-elsewhere" : undefined}>
            {item.text}
            <span className="summary-row__source">{sourceLine(item)}</span> <SourceLink item={item} />
          </div>
        ))
      )}
    </div>
  );
}

export function Summary({ patientId }: { patientId: string }) {
  const [data, setData] = useState<PatientSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const token = ++latest.current;
    setLoading(true);
    setData(null);
    setFailed(false);
    try {
      const result = await api.getPatientSummary(patientId);
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

  if (loading) return <p className="muted">Loading...</p>;
  if (!data) {
    return (
      <div>
        <div className="error-banner">
          {failed ? "We couldn't load this summary right now. Please try again." : "Patient not found."}
        </div>
        <button className="btn btn--secondary" type="button" onClick={() => void load()}>
          Retry
        </button>{" "}
        <button className="btn btn--ghost" type="button" onClick={() => navigate("/patients")}>
          Back to patient list
        </button>
      </div>
    );
  }

  const { disease_history: dh } = data;
  const latestPrescription = data.prescriptions[0];

  return (
    <div>
      <div className="page-heading">
        <div>
          <h6 className="muted" style={{ margin: 0 }}>
            Patient summary · compiled from {data.documents_count} document{data.documents_count === 1 ? "" : "s"}
          </h6>
          <h1>{data.patient.name || "(unnamed patient)"}</h1>
        </div>
        <button className="btn btn--primary" type="button" onClick={() => navigate(`/patients/${patientId}/snapshot`)}>
          Open today&apos;s snapshot →
        </button>
      </div>

      <Section title="What happened · in order">
        {data.what_happened.length === 0 ? (
          <p className="muted">{NOT_FOUND_TEXT}</p>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            {data.what_happened.map((item) => (
              <div className={`summary-row summary-row--dated${item.outside_encounter ? " is-elsewhere" : ""}`} key={item.fact_id}>
                <span className="muted">{item.as_of_date}</span>
                <span>
                  {item.text}
                  <span className="summary-row__source">{sourceLine(item)}</span>
                </span>
                <SourceLink item={item} />
              </div>
            ))}
          </div>
        )}
        <p className="muted summary-footnote">
          Each line is a fact from a document, quoted as written. No line of therapy or response is computed.
        </p>
      </Section>

      <div className="summary-columns">
        <Section title="Disease history">
          <KeyedRows
            rows={[
              { key: "Diagnosis", items: dh.diagnosis },
              { key: "Histology / IHC", items: dh.histology_ihc },
              { key: "Stage", items: dh.stage },
            ]}
          />
        </Section>
        <Section title="Other medical history">
          <KeyedRows
            rows={[
              { key: "Comorbidities", items: "not_extracted" },
              { key: "Allergies", items: "not_extracted" },
              { key: "Family history", items: "not_extracted" },
              { key: "ECOG", items: "not_extracted" },
              { key: "Devices", items: "not_extracted" },
              { key: "BRCA", items: "not_extracted" },
            ]}
          />
        </Section>
      </div>

      <Section title="Procedures and surgeries">
        {data.procedures.length === 0 ? (
          <p className="muted">{NOT_FOUND_TEXT}</p>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            {data.procedures.map((item) => (
              <div className={`summary-row summary-row--procedure${item.outside_encounter ? " is-elsewhere" : ""}`} key={item.fact_id}>
                <span className="muted">{item.as_of_date ?? "No date"}</span>
                <span>{item.text}</span>
                <span className="muted">
                  {item.outside_encounter ? item.outside_encounter.facility : (item.facility ?? NOT_FOUND_TEXT)}{" "}
                  <ElsewhereTag encounter={item.outside_encounter} />
                </span>
                <span>
                  <span className="summary-row__source" style={{ marginRight: 8 }}>
                    {sourceLine(item)}
                  </span>
                  <SourceLink item={item} />
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Previous prescriptions · what was prescribed at each checkup">
        {data.prescriptions.length === 0 ? (
          <p className="muted">{NOT_FOUND_TEXT}</p>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            {data.prescriptions.map((p) => (
              <div className="summary-prescription" key={p.document_id}>
                <div className="summary-prescription__head">
                  <strong>{p.date ?? "No date"}</strong>
                </div>
                <div className="summary-prescription__grid">
                  <PrescriptionLines label="Treatment" items={p.regimens} />
                  <PrescriptionLines label="Tests advised" items={p.tests_advised} />
                  <PrescriptionLines label="Next review" items={p.next_reviews} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Medicines on the latest prescription">
        <div className="card">
          <span className="muted">{NOT_EXTRACTED_TEXT}</span>
          {latestPrescription && latestPrescription.date && (
            <span className="summary-row__source">latest prescription {latestPrescription.date}</span>
          )}
        </div>
        <p className="muted summary-footnote">As written on the prescription. Not a reconciled medication list.</p>
      </Section>
    </div>
  );
}
