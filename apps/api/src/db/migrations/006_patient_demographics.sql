-- Patient demographics, grounded in standard oncology intake fields (overall
-- AJCC stage 0-IV, not full TNM -- that's disease-site-specific and needs
-- real clinical input to scope correctly). patient_origin distinguishes
-- "own hospital" vs "referral" patients, separate from documents.source_origin
-- (which tracks where each individual uploaded file came from).
ALTER TABLE patients
  ADD COLUMN date_of_birth DATE,
  ADD COLUMN sex TEXT CHECK (sex IN ('male', 'female', 'other', 'unknown')),
  ADD COLUMN mrn TEXT,
  ADD COLUMN diagnosis_date DATE,
  ADD COLUMN stage TEXT CHECK (stage IN ('0', 'I', 'II', 'III', 'IV')),
  ADD COLUMN referring_physician TEXT,
  ADD COLUMN patient_origin TEXT NOT NULL DEFAULT 'own_hospital' CHECK (patient_origin IN ('own_hospital', 'referral'));
