import { useState, type FormEvent } from "react";
import { CONTROLLED_MARKERS } from "@opd/shared";
import { api, ApiError } from "../api/client";
import { navigate } from "../router";

export function PatientCreate() {
  const [name, setName] = useState("");
  const [cancerType, setCancerType] = useState("");
  const [selectedMarkers, setSelectedMarkers] = useState<Set<string>>(new Set());
  const [customMarker, setCustomMarker] = useState("");
  const [customMarkers, setCustomMarkers] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function toggleMarker(marker: string) {
    setSelectedMarkers((prev) => {
      const next = new Set(prev);
      if (next.has(marker)) next.delete(marker);
      else next.add(marker);
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
      const patient = await api.createPatient({ name, cancer_type: cancerType, markers });
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
