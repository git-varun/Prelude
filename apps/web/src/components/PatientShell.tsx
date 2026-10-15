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
  const [patient, setPatient] = useState<PatientDetail | null>(null);
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

  // The patient and the document list are re-read when the screen changes (an upload or an edit may have changed them).
  useEffect(() => {
    let live = true;
    api.getPatient(patientId).then((p) => live && setPatient(p)).catch(() => {});
    void loadDocs();
    return () => { live = false; latestDocs.current++; };
  }, [patientId, route, loadDocs]);

  const current = activeNav(route);
  const count = docs.status === "ready" ? docs.documents.length : null;
  const demographics = patient ? demographicsLine(patient) : "";

  return (
    <div className="patient-shell">
      <nav className="patient-shell__side" aria-label="Patient">
        <div className="patient-shell__id">
          <div className="patient-shell__name">{patient?.name || (patient ? "(unnamed patient)" : "")}</div>
          {demographics && <div className="muted">{demographics}</div>}
          {patient?.diagnosis_text && <div className="patient-shell__dx">{patient.diagnosis_text}</div>}
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
      <DocumentPane docs={docs} onRetry={() => { setDocs({ status: "loading" }); void loadDocs(); }} />
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
