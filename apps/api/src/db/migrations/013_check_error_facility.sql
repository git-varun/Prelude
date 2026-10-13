-- M3 reconcile: surgery_procedure facts can be wrong about their facility (packages/shared SPOT_CHECK_ERRORS_BY_FIELD_TYPE).
-- Applied by hand (psql -f) and mounted in both compose files. ADD VALUE cannot run inside a transaction block on
-- older Postgres, so keep this file to this one statement.
ALTER TYPE check_error_type ADD VALUE IF NOT EXISTS 'facility';
