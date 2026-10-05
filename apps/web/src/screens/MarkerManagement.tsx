import { useCallback, useEffect, useState } from "react";
import { CONTROLLED_MARKERS } from "@prelude/shared";
import { api, ApiError, type PatientDetail } from "../api/client";
import { navigate } from "../router";

export function MarkerManagement({ patientId }: { patientId: string }) {
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState("");
  const [customName, setCustomName] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setPatient(await api.getPatient(patientId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load patient.");
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  async function addFromControlledList(e: React.FormEvent) {
    e.preventDefault();
    if (!picked) return;
    setBusy(true);
    try {
      await api.addMarker(patientId, picked);
      setPicked("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add marker.");
    } finally {
      setBusy(false);
    }
  }

  async function addCustom(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = customName.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await api.addMarker(patientId, trimmed);
      setCustomName("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to add marker.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className="muted">Loading...</p>;
  if (!patient) return <div className="error-banner">{error ?? "Patient not found."}</div>;

  const trackedNames = new Set(patient.tracked_markers.map((m) => m.marker_name));
  const available = CONTROLLED_MARKERS.filter((m) => !trackedNames.has(m));

  return (
    <div>
      <div className="page-heading">
        <h1>Tracked markers — {patient.name || "(unnamed patient)"}</h1>
        <button className="btn btn--ghost" onClick={() => navigate(`/patients/${patientId}/snapshot`)}>
          Back to snapshot
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="card">
        <h2>Currently tracked</h2>
        {patient.tracked_markers.length === 0 ? (
          <p className="muted">No markers tracked yet.</p>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {patient.tracked_markers.map((m) => (
              <span key={m.id} className={`tag ${m.is_custom ? "tag--custom" : ""}`}>
                {m.marker_name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2>Add a marker</h2>
        <form className="field" onSubmit={addFromControlledList} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="controlled-marker">From the controlled list</label>
            <select id="controlled-marker" value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">Select a marker...</option>
              {available.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn--secondary" type="submit" disabled={busy || !picked}>
            Add
          </button>
        </form>

        <form className="field" onSubmit={addCustom} style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="custom-marker-name">Or add a custom marker</label>
            <input
              id="custom-marker-name"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="e.g. LDH"
            />
          </div>
          <button className="btn btn--secondary" type="submit" disabled={busy || customName.trim() === ""}>
            Add
          </button>
        </form>
      </div>
    </div>
  );
}
