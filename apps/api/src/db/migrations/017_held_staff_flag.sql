-- M3-08 (B5): staff can only flag a held document; the oncologist confirms or rejects it.
-- 'awaiting_oncologist' is still HELD: every read that excludes 'mismatch' excludes it too.
-- ADD VALUE cannot run inside a transaction block on older servers: apply with `psql -f` (no --single-transaction).
ALTER TYPE identity_status ADD VALUE IF NOT EXISTS 'awaiting_oncologist';

ALTER TABLE documents
  ADD COLUMN IF NOT EXISTS staff_identity_assessment TEXT
    CHECK (staff_identity_assessment IN ('likely_same', 'likely_different', 'cannot_tell')),
  ADD COLUMN IF NOT EXISTS staff_identity_note TEXT,
  ADD COLUMN IF NOT EXISTS staff_identity_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS staff_identity_at TIMESTAMPTZ;
