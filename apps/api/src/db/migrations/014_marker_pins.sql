-- M3-07: per-patient pins and staff pin suggestions (spec name patient_marker.* = tracked_markers.*).
-- Applied by hand (psql -f) and mounted in both compose files.
ALTER TABLE tracked_markers
  ADD COLUMN IF NOT EXISTS is_pinned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pinned_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suggested_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS suggested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suggested_note TEXT;
