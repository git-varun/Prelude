-- M3-06 (AM-03): visits elsewhere. A row exists only when staff confirmed the date and facility at upload;
-- it is never inferred. No sign-off at this level: only facts are signed off.
-- Applied by hand (psql -f) and mounted in both compose files.
CREATE TABLE IF NOT EXISTS outside_encounters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  encounter_date DATE NOT NULL,
  facility TEXT NOT NULL CHECK (length(btrim(facility)) > 0),
  confirmed_by UUID NOT NULL REFERENCES users(id),
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS outside_encounters_patient_date_facility
  ON outside_encounters (patient_id, encounter_date, lower(facility));

ALTER TABLE documents ADD COLUMN IF NOT EXISTS outside_encounter_id UUID REFERENCES outside_encounters(id);
ALTER TABLE facts ADD COLUMN IF NOT EXISTS outside_encounter_id UUID REFERENCES outside_encounters(id);
