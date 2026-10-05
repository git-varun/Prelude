import { useEffect, useState } from "react";
import { api, ApiError, type PatientSummary } from "../api/client";
import { navigate } from "../router";

export function PatientList() {
  const [patients, setPatients] = useState<PatientSummary[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => {
      api
        .listPatients(search || undefined)
        .then(setPatients)
        .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load patients."));
    }, 200);
    return () => clearTimeout(handle);
  }, [search]);

  return (
    <div>
      <div className="page-heading">
        <h1>Patients</h1>
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

      <div className="card">
        {patients === null && <p className="muted">Loading...</p>}
        {patients?.length === 0 && (
          <div className="empty-state">
            {search ? `No patients matching "${search}".` : "No patients yet — create the first one."}
          </div>
        )}
        {patients?.map((p) => (
          <a
            key={p.id}
            className="patient-row"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              navigate(`/patients/${p.id}/upload`);
            }}
          >
            <span className="patient-row__name">{p.name || "(unnamed patient)"}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="patient-row__meta">{p.cancer_type || "cancer type not set"}</span>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  navigate(`/patients/${p.id}/markers`);
                }}
              >
                Markers
              </button>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  navigate(`/patients/${p.id}/snapshot`);
                }}
              >
                Snapshot
              </button>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
