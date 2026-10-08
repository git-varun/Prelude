import { useEffect, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  SEX_OPTIONS,
  STAGE_OPTIONS,
  PATIENT_ORIGIN_OPTIONS,
  type PatientDetail,
  type Sex,
  type Stage,
  type PatientOrigin,
} from "../api/client";
import { navigate } from "../router";

const PATIENT_ORIGIN_LABELS: Record<PatientOrigin, string> = {
  own_hospital: "Own patient",
  referral: "Referral",
};

export function PatientEdit({ patientId }: { patientId: string }) {
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [cancerType, setCancerType] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [sex, setSex] = useState<Sex | "">("");
  const [mrn, setMrn] = useState("");
  const [diagnosisDate, setDiagnosisDate] = useState("");
  const [stage, setStage] = useState<Stage | "">("");
  const [referringPhysician, setReferringPhysician] = useState("");
  const [patientOrigin, setPatientOrigin] = useState<PatientOrigin>("own_hospital");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    api
      .getPatient(patientId)
      .then((p) => {
        if (!current) return;
        setPatient(p);
        setName(p.name ?? "");
        setCancerType(p.cancer_type ?? "");
        setDateOfBirth(p.date_of_birth ?? "");
        setSex(p.sex ?? "");
        setMrn(p.mrn ?? "");
        setDiagnosisDate(p.diagnosis_date ?? "");
        setStage(p.stage ?? "");
        setReferringPhysician(p.referring_physician ?? "");
        setPatientOrigin(p.patient_origin);
      })
      .catch((err) => {
        if (current) setLoadError(err instanceof ApiError ? err.message : "Failed to load patient.");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [patientId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaving(true);
    try {
      await api.updatePatient(patientId, {
        name,
        cancer_type: cancerType,
        date_of_birth: dateOfBirth || undefined,
        sex: sex || undefined,
        mrn: mrn || undefined,
        diagnosis_date: diagnosisDate || undefined,
        stage: stage || undefined,
        referring_physician: referringPhysician || undefined,
        patient_origin: patientOrigin,
      });
      navigate(`/patients/${patientId}/snapshot`);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Failed to save patient.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="muted">Loading...</p>;
  if (!patient) return <div className="error-banner">{loadError ?? "Patient not found."}</div>;

  return (
    <div>
      <div className="page-heading">
        <h1>Edit patient</h1>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${patientId}/snapshot`)}>
          Cancel
        </button>
      </div>

      {saveError && <div className="error-banner">{saveError}</div>}

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

        <button className="btn btn--primary" type="submit" disabled={saving} style={{ marginTop: 16 }}>
          {saving ? "Saving..." : "Save changes"}
        </button>
      </form>
    </div>
  );
}
