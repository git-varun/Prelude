import { AuthProvider, useAuth } from "./auth/AuthContext";
import { Shell } from "./components/Shell";
import { Login } from "./screens/Login";
import { PatientList } from "./screens/PatientList";
import { PatientCreate } from "./screens/PatientCreate";
import { useHashRoute } from "./router";

function Routed() {
  const { user, loading } = useAuth();
  const route = useHashRoute();

  if (loading) return null;
  if (!user) return <Login />;

  return <Shell>{route === "/patients/new" ? <PatientCreate /> : <PatientList />}</Shell>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routed />
    </AuthProvider>
  );
}
