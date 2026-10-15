-- M3-13 review: the dictation access log must outlive recordings. Deleting a dictation (or a visit that has
-- dictations) is blocked while log rows exist; an operator decides on retention before anything is removed.
ALTER TABLE dictation_access_log DROP CONSTRAINT IF EXISTS dictation_access_log_dictation_id_fkey;
ALTER TABLE dictation_access_log
  ADD CONSTRAINT dictation_access_log_dictation_id_fkey FOREIGN KEY (dictation_id) REFERENCES visit_dictations(id) ON DELETE RESTRICT;

ALTER TABLE visit_dictations DROP CONSTRAINT IF EXISTS visit_dictations_visit_id_fkey;
ALTER TABLE visit_dictations
  ADD CONSTRAINT visit_dictations_visit_id_fkey FOREIGN KEY (visit_id) REFERENCES visits(id) ON DELETE RESTRICT;
COMMENT ON COLUMN visit_dictations.visit_id IS
  'Deleting a visit that has dictations is intentionally blocked (RESTRICT) until an operator decides on retention of the recordings and their access log.';
