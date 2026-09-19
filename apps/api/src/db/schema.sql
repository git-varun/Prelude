-- OPD AI Snapshot Tool — schema
-- Implements the frozen MVP Specification v1.1 (docs/01) as corrected by
-- docs/03-implementation-invariants.md, which is authoritative over
-- docs/02-implementation-blueprint.md wherever the two disagree.
--
-- Correction applied here: coverage_status is a 5-value enum. The Blueprint's
-- DDL included a 6th value, not_found_in_document_set, as a stored value.
-- Per Invariants §1, that state is never stored — it is synthesized at
-- snapshot-read time for tracked fields with no FACT row in the current
-- visit's document set. Storing it would violate the "no evidence yet" vs.
-- "evidence found and says nothing's there" distinction the Invariants doc
-- describes as the reason the sixth value must not be a real column value.

CREATE TYPE user_role AS ENUM ('staff', 'oncologist');
CREATE TYPE document_type AS ENUM ('prescription', 'blood', 'radiology');
CREATE TYPE source_origin AS ENUM ('own_hospital', 'outside_paper', 'outside_cd', 'whatsapp_pdf');
CREATE TYPE ocr_status AS ENUM ('pending', 'done', 'failed');
CREATE TYPE field_type AS ENUM ('marker_value', 'reference_range', 'treatment_regimen', 'radiology_impression', 'disease_status_trend');
CREATE TYPE coverage_status AS ENUM ('value_found', 'not_assessed', 'not_applicable', 'extraction_uncertain', 'conflicting_sources');
CREATE TYPE verification_state AS ENUM ('unverified', 'staff_corrected', 'oncologist_signed_off', 'reopened_by_oncologist');
CREATE TYPE delta_status AS ENUM ('new', 'changed', 'unchanged', 'not_observed_in_current_document_set');
CREATE TYPE conflict_status AS ENUM ('open', 'annotated', 'resolved');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE patients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT,
  cancer_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NOT NULL REFERENCES users(id)
);

CREATE TABLE visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  visit_date DATE NOT NULL DEFAULT current_date
);

CREATE TABLE tracked_markers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  marker_name TEXT NOT NULL,
  is_custom BOOLEAN NOT NULL DEFAULT false,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by UUID NOT NULL REFERENCES users(id)
);

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  visit_id UUID NOT NULL REFERENCES visits(id),
  file_ref TEXT NOT NULL,
  document_type document_type NOT NULL,
  source_origin source_origin NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES users(id),
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ocr_status ocr_status NOT NULL DEFAULT 'pending',
  ocr_text_ref TEXT
);

CREATE TABLE facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  visit_id UUID NOT NULL REFERENCES visits(id),
  document_id UUID NOT NULL REFERENCES documents(id),
  tracked_marker_id UUID REFERENCES tracked_markers(id),
  field_type field_type NOT NULL,
  value TEXT,
  unit TEXT,
  reference_range TEXT,
  as_of_date DATE NOT NULL,
  coverage_status coverage_status NOT NULL DEFAULT 'not_assessed',
  verification_state verification_state NOT NULL DEFAULT 'unverified',
  delta_status delta_status,
  source_page INTEGER,
  source_location TEXT,       -- OCR line/char range or bounding box, nullable
  source_snippet TEXT,        -- nullable
  corrected_by UUID REFERENCES users(id),
  signed_off_by UUID REFERENCES users(id),
  signed_off_at TIMESTAMPTZ,
  reopened_by UUID REFERENCES users(id),
  reopened_at TIMESTAMPTZ,
  CONSTRAINT signed_off_requires_oncologist CHECK (
    verification_state != 'oncologist_signed_off' OR signed_off_by IS NOT NULL
  )
);

-- CONFLICT is pairwise (Invariants §3): three-plus disagreeing documents
-- produce one CONFLICT row per disagreeing pair, not one N-way record.
CREATE TABLE conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id_a UUID NOT NULL REFERENCES facts(id),
  fact_id_b UUID NOT NULL REFERENCES facts(id),
  status conflict_status NOT NULL DEFAULT 'open',
  authoritative_fact_id UUID REFERENCES facts(id),
  resolution_note TEXT,
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,        -- 'upload' | 'correct' | 'sign_off' | 'reopen' | 'resolve_conflict' | 'delete'
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  before_value JSONB,
  after_value JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
