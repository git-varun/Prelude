-- M3-10 (B8): an 'Other' document type. Stored and viewable, never extracted in M3 (its fields are deferred), so it
-- gets its own extraction_status rather than a misleading 'pending' or 'done'.
-- ADD VALUE cannot run inside a transaction block on older servers: apply with `psql -f` (no --single-transaction).
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'other';
ALTER TYPE extraction_status ADD VALUE IF NOT EXISTS 'not_extracted';
