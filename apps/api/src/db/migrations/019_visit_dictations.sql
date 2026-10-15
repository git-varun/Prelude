-- M3-13 (AM-02): oncologist dictation audio pilot. Audio only: no transcript, no extracted items.
CREATE TABLE IF NOT EXISTS visit_dictations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visit_id UUID NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id),
  recorded_by UUID NOT NULL REFERENCES users(id),
  file_ref TEXT NOT NULL,
  mime TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 1 AND 1800),
  size_bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visit_dictations_visit_id_idx ON visit_dictations (visit_id);

-- Every play (and the recording itself) is written here: who, when, which recording.
CREATE TABLE IF NOT EXISTS dictation_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dictation_id UUID NOT NULL REFERENCES visit_dictations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('play', 'record')),
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dictation_access_log_dictation_id_idx ON dictation_access_log (dictation_id);
