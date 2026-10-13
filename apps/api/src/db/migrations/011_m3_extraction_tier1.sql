-- M3-01 (AM-04): tier 1 field types and the two document types they mostly live in.
-- "As written" fields store the source text verbatim in facts.value; nothing is normalised or computed.
-- facility is set only for surgery_procedure facts (AM-04: text, date, facility).
-- ADD VALUE cannot run inside a transaction block on older servers: apply with `psql -f` (no --single-transaction).
ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'diagnosis';
ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'histology_ihc';
ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'stage';
ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'surgery_procedure';
ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'next_review_date';
ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'tests_advised';
ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'procedures_planned';
ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'lesion_size';

ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'pathology';
ALTER TYPE document_type ADD VALUE IF NOT EXISTS 'discharge';

ALTER TABLE facts ADD COLUMN IF NOT EXISTS facility TEXT;
