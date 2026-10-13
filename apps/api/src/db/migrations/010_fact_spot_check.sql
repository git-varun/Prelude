-- Fact spot-check (docs/superpowers/specs/2026-10-13-fact-spot-check-design.md): a per-fact "I checked this
-- against the source" mark, separate from verification_state. Applied by hand (psql -f) and mounted in both
-- compose files. NOT added to schema.sql (schema.sql predates 006-009; migrations layer on top of it).
CREATE TYPE check_state AS ENUM ('unchecked', 'correct', 'incorrect');
CREATE TYPE check_error_type AS ENUM ('value', 'unit', 'marker', 'date', 'range', 'not_in_document', 'wrong_patient');

ALTER TABLE facts
  ADD COLUMN check_state check_state NOT NULL DEFAULT 'unchecked',
  ADD COLUMN checked_by UUID REFERENCES users(id),
  ADD COLUMN checked_at TIMESTAMPTZ,
  ADD COLUMN error_type check_error_type,
  ADD COLUMN excluded_at TIMESTAMPTZ,
  ADD CONSTRAINT facts_error_type_matches_state CHECK (
    (check_state = 'incorrect' AND error_type IS NOT NULL) OR (check_state != 'incorrect' AND error_type IS NULL)
  ),
  ADD CONSTRAINT facts_excluded_matches_error_type CHECK (
    COALESCE(error_type IN ('not_in_document', 'wrong_patient'), false) = (excluded_at IS NOT NULL)
  );

-- Backfill: already-signed-off facts count as checked. checked_by stays NULL = "backfilled" (a user mark always sets it).
UPDATE facts SET check_state = 'correct', checked_at = signed_off_at WHERE verification_state = 'oncologist_signed_off';

-- Roll-ups and the unchecked badge scan by document.
CREATE INDEX facts_document_check_idx ON facts (document_id, check_state);
