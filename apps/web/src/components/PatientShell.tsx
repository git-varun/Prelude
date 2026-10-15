import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type PatientDetail } from "../api/client";
import { activeNav, demographicsLine, NAV_ITEMS } from "../lib/patientShell";
import { navigate } from "../router";
import { DocumentPane, type DocsState } from "./DocumentPane";
import { PaneProvider, usePane } from "./PaneContext";

// Layout of every patient screen (README section 2): sidebar, the screen, and the document pane. The pane starts
// collapsed to a rail. The sidebar's name is styled like an h4 but is not a heading element, so the screen's own
// patient heading stays the only one.
function ShellBody({ patientId, route, children }: { patientId: string; route: string; children: ReactNode }) {
  const pane = usePane()!;
  const [patient, setPatient] = useState<{ status: "loading" } | { status: "error" } | { status: "ready"; patient: PatientDetail }>({ status: "loading" });
  const [docs, setDocs] = useState<DocsState>({ status: "loading" });
  const latestDocs = useRef(0);

  const loadDocs = useCallback(async () => {
    const token = ++latestDocs.current;
    try {
      const { documents } = await api.listPatientDocuments(patientId);
      if (token === latestDocs.current) setDocs({ status: "ready", documents });
    } catch (err) {
      // Keep what was already listed when only a refresh fails.
      if (token === latestDocs.current) {
        setDocs((prev) => (prev.status === "ready" ? prev : { status: "error", message: err instanceof ApiError ? err.message : "Failed to load documents." }));
      }
    }
  }, [patientId]);

  const loadPatient = useCallback(() => {
    let live = true;
    api.getPatient(patientId)
      .then((p) => live && setPatient({ status: "ready", patient: p }))
      .catch(() => live && setPatient({ status: "error" }));
    return () => { live = false; };
  }, [patientId]);

  // The patient and the document list are re-read only when the patient changes or an upload / edit signals it
  // (pane.refreshKey) -- not on every route or query change.
  useEffect(() => {
    const stop = loadPatient();
    void loadDocs();
    return () => { stop(); latestDocs.current++; };
  }, [loadPatient, loadDocs, pane.refreshKey]);

  const current = activeNav(route);
  // The list API leaves out rejected documents; held ones (identity mismatch / awaiting the oncologist) are listed,
  // so they are counted here and marked in the pane.
  const count = docs.status === "ready" ? docs.documents.length : null;
  const loaded = patient.status === "ready" ? patient.patient : null;
  const demographics = loaded ? demographicsLine(loaded) : "";

  return (
    <div className="patient-shell">
      <nav className="patient-shell__side" aria-label="Patient">
        <div className="patient-shell__id">
          {patient.status === "error" ? (
            <div className="error-banner">
              Patient details could not be loaded.{" "}
              <button className="btn btn--ghost" type="button" onClick={() => { setPatient({ status: "loading" }); loadPatient(); }}>Retry</button>
            </div>
          ) : (
            <>
              <div className="patient-shell__name">{loaded?.name ?? ""}</div>
              {demographics && <div className="muted">{demographics}</div>}
              {loaded?.diagnosis_text && <div className="patient-shell__dx">{loaded.diagnosis_text}</div>}
            </>
          )}
        </div>
        {NAV_ITEMS.map((item) => {
          const path = `/patients/${patientId}/${item.path}`;
          const isCurrent = current === item.key;
          return (
            <Fragment key={item.key}>
              <a
                href={`#${path}`} className={`patient-shell__nav${isCurrent ? " patient-shell__nav--active" : ""}`}
                aria-current={isCurrent ? "page" : undefined}
                onClick={(e) => { e.preventDefault(); navigate(path); }}
              >
                {item.label}
              </a>
              {item.key === "history" && (
                <button className="patient-shell__nav" type="button" aria-expanded={pane.paneOpen} onClick={pane.openList}>
                  {count === null ? "Documents" : `Documents · ${count}`}
                </button>
              )}
            </Fragment>
          );
        })}
      </nav>
      <div className="patient-shell__main">{children}</div>
      <DocumentPane patientId={patientId} docs={docs} onRetry={() => { setDocs({ status: "loading" }); void loadDocs(); }} />
    </div>
  );
}

export function PatientShell(props: { patientId: string; route: string; children: ReactNode }) {
  return (
    <PaneProvider>
      <ShellBody {...props} />
    </PaneProvider>
  );
}
