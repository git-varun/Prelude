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
  matchPatientMarkers,
  matchPatientEdit,
  matchPatientHistory,
  matchPatientTimeline,
  matchDocumentSource,
  matchConflict,
} from "./router";
import { ExtractionReview } from "./screens/ExtractionReview";
import { Snapshot } from "./screens/Snapshot";
import { Timeline } from "./screens/Timeline";
import { MarkerManagement } from "./screens/MarkerManagement";
import { PatientEdit } from "./screens/PatientEdit";
import { VisitHistory } from "./screens/VisitHistory";
import { SourceView } from "./screens/SourceView";
import { ConflictResolution } from "./screens/ConflictResolution";

function Routed() {
  const { user, loading, connectivityError } = useAuth();
  const route = useHashRoute();

  if (loading) return null;
  if (!user) return <Login connectivityError={connectivityError} />;

  const uploadPatientId = matchPatientUpload(route);
  const reviewDocumentId = matchDocumentReview(route);
  const snapshotPatientId = matchPatientSnapshot(route);
  const markersPatientId = matchPatientMarkers(route);
  const editPatientId = matchPatientEdit(route);
  const historyPatientId = matchPatientHistory(route);
  const timelinePatientId = matchPatientTimeline(route);
  const source = matchDocumentSource(route);
  const conflictId = matchConflict(route);

  let screen: ReactNode;
  if (uploadPatientId) {
    screen = <Upload patientId={uploadPatientId} />;
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
