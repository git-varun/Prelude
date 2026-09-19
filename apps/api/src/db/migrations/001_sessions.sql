-- Sessions table for email/password + session-based auth (confirmed choice,
-- not in the Blueprint's schema.sql because that doc didn't specify how auth
-- state is persisted — this is required infrastructure for the "email/password
-- with sessions" decision, not a spec addition).

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
