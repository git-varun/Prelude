import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Shell } from "./components/Shell";
import { PatientShell } from "./components/PatientShell";
import { Login } from "./screens/Login";
import { PatientList } from "./screens/PatientList";
import { PatientCreate } from "./screens/PatientCreate";
import { Upload } from "./screens/Upload";
import {
  useHashRoute,
  matchPatientUpload,
  matchDocumentReview,
  matchPatientSnapshot,
  matchPatientSummary,
  matchPatientPlan,
  matchPatientMarkers,
  matchPatientEdit,
  matchPatientHistory,
  matchPatientTimeline,
  matchDocumentSource,
  matchConflict,
  matchPatientHeld,
} from "./router";
import { ExtractionReview } from "./screens/ExtractionReview";
import { Snapshot } from "./screens/Snapshot";
import { Summary } from "./screens/Summary";
import { Plan } from "./screens/Plan";
import { Timeline } from "./screens/Timeline";
import { MarkerManagement } from "./screens/MarkerManagement";
import { PatientEdit } from "./screens/PatientEdit";
import { VisitHistory } from "./screens/VisitHistory";
import { SourceView } from "./screens/SourceView";
import { ConflictResolution } from "./screens/ConflictResolution";
import { HeldDocuments } from "./screens/HeldDocuments";

function Routed() {
  const { user, loading, connectivityError } = useAuth();
  const route = useHashRoute();

  if (loading) return null;
  if (!user) return <Login connectivityError={connectivityError} />;

  const uploadPatientId = matchPatientUpload(route);
  const reviewDocumentId = matchDocumentReview(route);
  const snapshotPatientId = matchPatientSnapshot(route);
  const summaryPatientId = matchPatientSummary(route);
  const planPatientId = matchPatientPlan(route);
  const markersPatientId = matchPatientMarkers(route);
  const editPatientId = matchPatientEdit(route);
  const historyPatientId = matchPatientHistory(route);
  const timelinePatientId = matchPatientTimeline(route);
  const source = matchDocumentSource(route);
  const conflictId = matchConflict(route);
  const heldPatientId = matchPatientHeld(route);

  let screen: ReactNode;
  // Patient screens live inside the patient shell (sidebar + document pane); the rest stay full width.
  let shellPatientId: string | null = null;
  let listScreen = false;
  if (uploadPatientId) {
    screen = <Upload patientId={uploadPatientId} />;
    shellPatientId = uploadPatientId;
  } else if (heldPatientId) {
    screen = <HeldDocuments patientId={heldPatientId} />;
  } else if (conflictId) {
    screen = <ConflictResolution conflictId={conflictId} />;
  } else if (source) {
    screen = <SourceView documentId={source.documentId} factId={source.factId} />;
  } else if (reviewDocumentId) {
    screen = <ExtractionReview documentId={reviewDocumentId} />;
  } else if (editPatientId) {
    screen = <PatientEdit patientId={editPatientId} />;
    shellPatientId = editPatientId;
  } else if (historyPatientId) {
    screen = <VisitHistory patientId={historyPatientId} />;
    shellPatientId = historyPatientId;
  } else if (timelinePatientId) {
    screen = <Timeline patientId={timelinePatientId} />;
    shellPatientId = timelinePatientId;
  } else if (planPatientId) {
    screen = <Plan patientId={planPatientId} />;
    shellPatientId = planPatientId;
  } else if (summaryPatientId) {
    screen = <Summary patientId={summaryPatientId} />;
    shellPatientId = summaryPatientId;
  } else if (snapshotPatientId) {
    screen = <Snapshot patientId={snapshotPatientId} />;
    shellPatientId = snapshotPatientId;
  } else if (markersPatientId) {
    screen = <MarkerManagement patientId={markersPatientId} />;
    shellPatientId = markersPatientId;
  } else if (route === "/patients/new") {
    screen = <PatientCreate />;
  } else {
    screen = <PatientList />;
    // Today uses the 1200px column of the design handoff (its own max-width), not the 880px form column.
    listScreen = true;
  }

  if (shellPatientId) {
    return (
      <Shell wide>
        <PatientShell key={shellPatientId} patientId={shellPatientId} route={route}>{screen}</PatientShell>
      </Shell>
    );
  }
  return <Shell wide={listScreen}>{screen}</Shell>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routed />
    </AuthProvider>
  );
}
