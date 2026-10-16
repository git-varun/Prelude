import type { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import { navigate } from "../router";

export function Shell({ children, wide }: { children: ReactNode; wide?: boolean }) {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="app-header__brand" href="#/patients" onClick={(e) => { e.preventDefault(); navigate("/patients"); }}>
          <span className="app-header__brand-mark">Prelude</span>
        </a>
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
      <main className={`app-main${wide ? " app-main--wide" : ""}`}>{children}</main>
    </div>
  );
}
