-- createOrOpenVisit's "check existing, else insert" was two separate
-- statements with nothing preventing two concurrent requests from both
-- missing the SELECT and both INSERTing -- fragmenting one consult's
-- documents across two visit rows, exactly what that function exists to
-- prevent. A unique constraint lets the insert itself be atomic (ON CONFLICT
-- DO UPDATE ... RETURNING) instead of relying on an unenforced invariant.
ALTER TABLE visits ADD CONSTRAINT visits_patient_id_visit_date_key UNIQUE (patient_id, visit_date);
