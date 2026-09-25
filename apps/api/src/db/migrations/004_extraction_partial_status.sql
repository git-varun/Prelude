-- A field-type extraction call can fail while others succeed. 'partial' =
-- some facts were extracted but at least one field type's call failed, so the
-- document is incompletely analyzed (distinct from 'done' and from 'failed').
-- Note: ADD VALUE cannot be used in the same transaction that adds it; apply
-- this file on its own (psql -f), not inside a wrapping BEGIN.
ALTER TYPE extraction_status ADD VALUE 'partial';

-- Short human-readable summary (which field types, the error message) set
-- whenever extraction_status is 'partial' or 'failed'; NULL otherwise.
ALTER TABLE documents ADD COLUMN extraction_error TEXT;
