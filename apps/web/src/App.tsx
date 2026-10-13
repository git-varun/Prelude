import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Shell } from "./components/Shell";
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
  if (uploadPatientId) {
    screen = <Upload patientId={uploadPatientId} />;
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
  } else if (historyPatientId) {
    screen = <VisitHistory patientId={historyPatientId} />;
  } else if (timelinePatientId) {
    screen = <Timeline patientId={timelinePatientId} />;
  } else if (planPatientId) {
    screen = <Plan patientId={planPatientId} />;
  } else if (summaryPatientId) {
    screen = <Summary patientId={summaryPatientId} />;
  } else if (snapshotPatientId) {
    screen = <Snapshot patientId={snapshotPatientId} />;
  } else if (markersPatientId) {
    screen = <MarkerManagement patientId={markersPatientId} />;
  } else if (route === "/patients/new") {
    screen = <PatientCreate />;
  } else {
    screen = <PatientList />;
  }

  return <Shell>{screen}</Shell>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routed />
    </AuthProvider>
  );
}
