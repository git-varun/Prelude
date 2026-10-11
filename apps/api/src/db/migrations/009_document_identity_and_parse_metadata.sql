-- Phase 2 (identity/safety): structured header fields parsed by the
-- deterministic pipeline (header.ts), the patient-identity match result
-- (identity.ts), and a content hash for OCR reuse across re-uploads of the
-- same file. 'confirmed'/'rejected' are staff's resolution of a 'mismatch'
-- hold; LIVE_FACT_FILTER (services/delta.ts) excludes 'mismatch' and
-- 'rejected' from every snapshot/timeline/trend read. NULL means "not
-- assessed" (every document before this migration, and every non-blood
-- document today) -- never held.
CREATE TYPE identity_status AS ENUM ('matched', 'partial', 'mismatch', 'unknown', 'confirmed', 'rejected');

ALTER TABLE documents
  ADD COLUMN lab_name TEXT,
  ADD COLUMN collected_on DATE,
  ADD COLUMN received_on DATE,
  ADD COLUMN reported_on DATE,
  ADD COLUMN patient_name_on_report TEXT,
  ADD COLUMN lab_patient_ref TEXT,
  ADD COLUMN identity_status identity_status,
  ADD COLUMN file_sha256 TEXT;

-- OCR reuse lookup (routes/documents.ts runOcr): same patient, same file content.
CREATE INDEX documents_patient_file_sha256_idx ON documents (patient_id, file_sha256);

-- Per-row free-check diagnostics from validate.ts; NULL for a fact from an LLM pass.
ALTER TABLE facts
  ADD COLUMN printed_flag TEXT,
  ADD COLUMN parse_checks JSONB;
