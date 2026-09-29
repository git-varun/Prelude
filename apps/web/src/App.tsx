import type { ReactNode } from "react";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Shell } from "./components/Shell";
import { Login } from "./screens/Login";
import { PatientList } from "./screens/PatientList";
import { PatientCreate } from "./screens/PatientCreate";
import { Upload } from "./screens/Upload";
import { useHashRoute, matchPatientUpload, matchDocumentReview, matchPatientSnapshot } from "./router";
import { ExtractionReview } from "./screens/ExtractionReview";
import { Snapshot } from "./screens/Snapshot";

function Routed() {
  const { user, loading, connectivityError } = useAuth();
  const route = useHashRoute();

  if (loading) return null;
  if (!user) return <Login connectivityError={connectivityError} />;

  const uploadPatientId = matchPatientUpload(route);
  const reviewDocumentId = matchDocumentReview(route);
  const snapshotPatientId = matchPatientSnapshot(route);

  let screen: ReactNode;
  if (uploadPatientId) {
    screen = <Upload patientId={uploadPatientId} />;
  } else if (reviewDocumentId) {
    screen = <ExtractionReview documentId={reviewDocumentId} />;
  } else if (snapshotPatientId) {
    screen = <Snapshot patientId={snapshotPatientId} />;
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
