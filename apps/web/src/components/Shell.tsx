import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { navigate } from "../router";

export function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand" onClick={() => navigate("/patients")} style={{ cursor: "pointer" }}>
          <span className="app-header__brand-mark">OPD</span> Snapshot
        </div>
        {user && (
          <div className="app-header__user">
            <span>{user.name}</span>
            <span className={`role-badge role-badge--${user.role}`}>{user.role}</span>
            <button className="btn btn--ghost" onClick={() => logout()}>
              Sign out
            </button>
          </div>
        )}
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
