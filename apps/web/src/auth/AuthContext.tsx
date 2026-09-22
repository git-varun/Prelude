import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { UserRole } from "@opd/shared";
import { api, ApiError, type SessionUser } from "../api/client";

interface AuthState {
  user: SessionUser | null;
  loading: boolean;
  // m1-backlog B7: distinguishes "not logged in" (show Login screen) from
  // "API unreachable / errored" (show a connectivity error) instead of
  // collapsing every GET /auth/me failure into "logged out".
  connectivityError: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [connectivityError, setConnectivityError] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((u) => {
        setUser(u);
        setConnectivityError(false);
      })
      .catch((err) => {
        setUser(null);
        // A 401 means "not authenticated" — expected, not an error. Anything
        // else (network failure, 5xx) means we couldn't actually tell.
        setConnectivityError(!(err instanceof ApiError && err.status === 401));
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const sessionUser = await api.login(email, password);
    setUser(sessionUser);
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, connectivityError, login, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/**
 * Role-aware UI shell primitive (docs/02 M1 checklist). Wraps any
 * oncologist-only action (sign-off, resolve, delete, reopen — none built yet
 * as of M1; those land in M3/M7) so staff accounts never see it rendered,
 * not just disabled. Usage: <RoleGate roles={["oncologist"]}><Button/></RoleGate>
 */
export function RoleGate({ roles, children }: { roles: UserRole[]; children: ReactNode }) {
  const { user } = useAuth();
  if (!user || !roles.includes(user.role)) return null;
  return <>{children}</>;
}
