import { useEffect, useMemo, useState } from "react";
import { api, ApiError, type PatientSummary } from "../api/client";
import { navigate } from "../router";
import { Sparkline } from "../components/Watchlist";
import { ageOn, changeSummaryLine, groupPatients, localToday, PATIENT_FETCH_LIMIT, TODAY_GROUPS, truncationNote, type TodayGroup } from "../lib/todayGroups";

const SEX_LETTER: Record<string, string> = { male: "M", female: "F", other: "O" };

// Tolerates a payload without the M3-09 fields (an older API) by treating them as empty.
function withToday(p: PatientSummary): PatientSummary {
  return {
    ...p,
    prep_status: p.prep_status ?? null,
    changed_since_ready: p.changed_since_ready ?? false,
    current_visit_document_count: p.current_visit_document_count ?? 0,
    sign_off_count: p.sign_off_count ?? 0,
    change_summary_items: p.change_summary_items ?? [],
    first_pinned_sparkline: p.first_pinned_sparkline ?? null,
    held_document_count: p.held_document_count ?? 0,
    unchecked_fact_count: p.unchecked_fact_count ?? 0,
    needs_attention_count: p.needs_attention_count ?? 0,
    has_plan_items_expected: p.has_plan_items_expected ?? false,
  };
}

// "N to sign off", else the prep state. Never a rank.
function rowTag(p: PatientSummary, group: TodayGroup): string | null {
  if (group === "expected") return p.change_summary_items.some((i) => i.kind === "plan_past") ? "Past advised date" : "Planned";
  if (group === "preparing" && p.prep_status === "ready" && p.changed_since_ready) return "Changed since marked ready";
  if (p.sign_off_count > 0) return `${p.sign_off_count} to sign off`;
  if (group === "ready") return "Ready";
  if (group === "preparing") return "Preparing";
  return null;
}

function PatientRow({ p, group, today }: { p: PatientSummary; group: TodayGroup; today: string }) {
  const age = ageOn(p.date_of_birth, today);
  const sex = p.sex ? SEX_LETTER[p.sex] : undefined;
  const who = [`${age ?? ""}${sex ?? ""}`, p.diagnosis_text && `"${p.diagnosis_text}"`, p.regimen_text && `"${p.regimen_text}"`]
    .filter(Boolean)
    .join(" · ");
  const line = changeSummaryLine(p.change_summary_items);
  const spark = p.first_pinned_sparkline;
  const tag = rowTag(p, group);
  // Staff-facing counts sit quietly under the change summary; the right-hand tag stays the one status.
  const counts = [
    p.needs_attention_count > 0 ? `${p.needs_attention_count} need${p.needs_attention_count === 1 ? "s" : ""} review` : null,
    p.unchecked_fact_count > 0 ? `${p.unchecked_fact_count} to check` : null,
  ].filter(Boolean).join(" · ");
  return (
    <a
      className="today-row"
      href="#"
      data-testid="today-row"
      onClick={(e) => {
        e.preventDefault();
        navigate(`/patients/${p.id}/snapshot`);
      }}
    >
      <span className="today-row__main">
        <span className="today-row__who">
          <span className="today-row__name">{p.name || "(unnamed patient)"}</span>
          {who && <span className="today-row__meta">{who}</span>}
          {p.patient_origin === "referral" && <span className="tag">Referral</span>}
          {p.stage && <span className="tag">Stage {p.stage}</span>}
          {p.held_document_count > 0 && (
            <button
              type="button"
              className="tag tag--range-flag"
              aria-label={`${p.held_document_count} held document${p.held_document_count === 1 ? "" : "s"}, review`}
              style={{ cursor: "pointer", font: "inherit", fontSize: 12 }}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                navigate(`/patients/${p.id}/held`);
              }}
            >
              {p.held_document_count} held
            </button>
          )}
        </span>
        <span className="today-row__summary" data-testid="change-summary">
          {line || (p.last_visit_date ? `Last visit ${p.last_visit_date}` : "No visits yet")}
        </span>
        {counts && <span className="today-row__counts">{counts}</span>}
      </span>
      <span className="today-row__spark">
        {spark && (
          <>
            <Sparkline
              entry={{ marker_name: spark.marker_name, sparkline: spark.points, conflict: false, latest: { reference_range: spark.reference_range } }}
              outOfRange={false}
            />
            <span className="today-row__meta">{spark.marker_name}</span>
          </>
        )}
      </span>
      <span className="today-row__tag">{tag && <span className="tag">{tag}</span>}</span>
    </a>
  );
}

export function PatientList() {
  const [patients, setPatients] = useState<PatientSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const today = useMemo(() => localToday(), []);

  useEffect(() => {
    const handle = setTimeout(() => {
      api
        .listPatients(search || undefined, PATIENT_FETCH_LIMIT)
        .then((list) => setPatients(list.map(withToday)))
        .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load patients."));
    }, 200);
    return () => clearTimeout(handle);
  }, [search]);

  const groups = useMemo(() => (patients ? groupPatients(patients) : null), [patients]);

  return (
    <div className="today">
      <div className="page-heading">
        <div>
          <h6 className="muted" style={{ margin: 0 }}>
            {new Date(`${today}T00:00:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
            {patients ? ` · ${patients.length} ${patients.length === 1 ? "patient" : "patients"}` : ""}
          </h6>
          <h1>Patients</h1>
        </div>
        <button className="btn btn--primary" onClick={() => navigate("/patients/new")}>
          New patient
        </button>
      </div>

      <div className="field" style={{ maxWidth: 320 }}>
        <input
          type="search"
          placeholder="Search by name..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {error && <div className="error-banner">{error}</div>}
      {patients && truncationNote(patients.length) && <p className="muted" role="status">{truncationNote(patients.length)}</p>}

      {patients === null && <p className="muted">Loading...</p>}
      {patients?.length === 0 && (
        <div className="card empty-state">
          {search ? `No patients matching "${search}".` : "No patients yet — create the first one."}
        </div>
      )}
      {groups &&
        TODAY_GROUPS.filter((g) => groups[g.key].length > 0).map((g) => (
          <section key={g.key} className="today-group" aria-label={g.title}>
            <h6 className="today-group__title">
              {g.title} · {groups[g.key].length}
            </h6>
            {groups[g.key].map((p) => (
              <PatientRow key={p.id} p={p} group={g.key} today={today} />
            ))}
          </section>
        ))}
    </div>
  );
}
