import { useState, type FormEvent } from "react";
import { CONTROLLED_MARKERS, DISEASE_SITES, DISEASE_SITE_PANELS, FALLBACK_MARKER_SET } from "@prelude/shared";
import { api, ApiError, SEX_OPTIONS, STAGE_OPTIONS, PATIENT_ORIGIN_OPTIONS, type Sex, type Stage, type PatientOrigin } from "../api/client";
import { navigate } from "../router";

const PATIENT_ORIGIN_LABELS: Record<PatientOrigin, string> = {
  own_hospital: "Own patient",
  referral: "Referral",
};

export function PatientCreate() {
  const [name, setName] = useState("");
  const [cancerType, setCancerType] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [sex, setSex] = useState<Sex | "">("");
  const [mrn, setMrn] = useState("");
  const [diagnosisDate, setDiagnosisDate] = useState("");
  const [stage, setStage] = useState<Stage | "">("");
  const [referringPhysician, setReferringPhysician] = useState("");
  const [patientOrigin, setPatientOrigin] = useState<PatientOrigin>("own_hospital");
  const [selectedSites, setSelectedSites] = useState<Set<string>>(new Set());
  // The checked set is derived, not stored directly: `auto` (the union of selected
  // sites' panels, or the fallback set when none is selected) with `manualOn`/
  // `manualOff` layered on top, so a deliberate check/uncheck survives a later site
  // toggle instead of being silently overwritten by the new auto set.
  const [manualOn, setManualOn] = useState<Set<string>>(new Set());
  const [manualOff, setManualOff] = useState<Set<string>>(new Set());
  const [customMarker, setCustomMarker] = useState("");
  const [customMarkers, setCustomMarkers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const autoMarkers =
    selectedSites.size === 0 ? FALLBACK_MARKER_SET : [...selectedSites].flatMap((s) => DISEASE_SITE_PANELS[s]!);
  const selectedMarkers = new Set(
    [...autoMarkers, ...manualOn].filter((marker) => !manualOff.has(marker)),
  );

  function toggleMarker(marker: string) {
    if (selectedMarkers.has(marker)) {
      setManualOff((prev) => new Set(prev).add(marker));
      setManualOn((prev) => {
        const next = new Set(prev);
        next.delete(marker);
        return next;
      });
    } else {
      setManualOn((prev) => new Set(prev).add(marker));
      setManualOff((prev) => {
        const next = new Set(prev);
        next.delete(marker);
        return next;
      });
    }
  }

  function toggleSite(site: string) {
    setSelectedSites((prev) => {
      const next = new Set(prev);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });
  }

  function addCustomMarker() {
    const trimmed = customMarker.trim();
    if (!trimmed || customMarkers.includes(trimmed)) return;
    setCustomMarkers((prev) => [...prev, trimmed]);
    setCustomMarker("");
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const markers = [...selectedMarkers, ...customMarkers].map((marker_name) => ({ marker_name }));
      const patient = await api.createPatient({
        name,
        cancer_type: cancerType,
        markers,
        date_of_birth: dateOfBirth || undefined,
        sex: sex || undefined,
        mrn: mrn || undefined,
        diagnosis_date: diagnosisDate || undefined,
        stage: stage || undefined,
        referring_physician: referringPhysician || undefined,
        patient_origin: patientOrigin,
      });
      navigate(`/patients/${patient.id}/upload`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create patient.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="page-heading">
        <h1>New patient</h1>
        <button className="btn btn--ghost" onClick={() => navigate("/patients")}>
          Cancel
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <form onSubmit={handleSubmit}>
        <div className="card">
          <div className="field">
            <label htmlFor="name">Patient name</label>
            <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="cancer-type">Cancer type</label>
            <input id="cancer-type" value={cancerType} onChange={(e) => setCancerType(e.target.value)} required />
          </div>
        </div>

        <div className="card">
          <h2>Patient details</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div className="field">
              <label htmlFor="dob">Date of birth</label>
              <input id="dob" type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="sex">Sex</label>
              <select id="sex" value={sex} onChange={(e) => setSex(e.target.value as Sex | "")}>
                <option value="">Not specified</option>
                {SEX_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="mrn">MRN</label>
              <input id="mrn" value={mrn} onChange={(e) => setMrn(e.target.value)} placeholder="Medical record number" />
            </div>
            <div className="field">
              <label htmlFor="patient-origin">Patient type</label>
              <select id="patient-origin" value={patientOrigin} onChange={(e) => setPatientOrigin(e.target.value as PatientOrigin)}>
                {PATIENT_ORIGIN_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    {PATIENT_ORIGIN_LABELS[o]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="diagnosis-date">Diagnosis date</label>
              <input id="diagnosis-date" type="date" value={diagnosisDate} onChange={(e) => setDiagnosisDate(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="stage">Stage</label>
              <select id="stage" value={stage} onChange={(e) => setStage(e.target.value as Stage | "")}>
                <option value="">Not specified</option>
                {STAGE_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    Stage {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ gridColumn: "1 / -1" }}>
              <label htmlFor="referring-physician">Referring physician</label>
              <input
                id="referring-physician"
                value={referringPhysician}
                onChange={(e) => setReferringPhysician(e.target.value)}
                placeholder="Only relevant for a referral"
              />
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Primary disease site</h2>
          <p className="field-hint" style={{ marginBottom: 16 }}>
            Selecting a site pre-checks its default marker panel below. No site selected uses the generic fallback
            panel. Select multiple sites to union their panels.
          </p>

          {DISEASE_SITES.map((site) => (
            <label key={site} className="checkbox-row">
              <input type="checkbox" checked={selectedSites.has(site)} onChange={() => toggleSite(site)} />
              {site}
            </label>
          ))}
        </div>

        <div className="card">
          <h2>Tracked markers</h2>
          <p className="field-hint" style={{ marginBottom: 16 }}>
            Select from the controlled list, or add a custom marker below (custom markers have no trend-matching
            guarantee against differently-named markers).
          </p>

          {CONTROLLED_MARKERS.map((marker) => (
            <label key={marker} className="checkbox-row">
              <input
                type="checkbox"
                checked={selectedMarkers.has(marker)}
                onChange={() => toggleMarker(marker)}
              />
              {marker}
            </label>
          ))}

          <div className="field" style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="custom-marker">Add custom marker</label>
              <input
                id="custom-marker"
                value={customMarker}
                onChange={(e) => setCustomMarker(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomMarker();
                  }
                }}
                placeholder="e.g. LDH"
              />
            </div>
            <button type="button" className="btn btn--secondary" onClick={addCustomMarker}>
              Add
            </button>
          </div>

          {customMarkers.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              {customMarkers.map((marker) => (
                <span key={marker} className="tag tag--custom">
                  {marker}
                </span>
              ))}
            </div>
          )}
        </div>

        <button className="btn btn--primary" type="submit" disabled={submitting} style={{ marginTop: 16 }}>
          {submitting ? "Creating..." : "Create patient"}
        </button>
      </form>
    </div>
  );
}
