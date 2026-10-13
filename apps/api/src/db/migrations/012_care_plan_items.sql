-- M3-03 (B3): care plan items. Created from oncologist-signed-off tests_advised / procedures_planned /
-- next_review_date facts, or added by hand. Status is derived at read time and never stored; a report match is
-- only ever set by staff (matched_document_id + match_confirmed_*), never automatically.
CREATE TABLE IF NOT EXISTS care_plan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id UUID NOT NULL REFERENCES patients(id),
  type TEXT NOT NULL CHECK (type IN ('test', 'procedure', 'review')),
  text TEXT NOT NULL,
  advised_at DATE NOT NULL,
  source_fact_id UUID UNIQUE REFERENCES facts(id),
  matched_document_id UUID REFERENCES documents(id),
  match_confirmed_by UUID REFERENCES users(id),
  match_confirmed_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS care_plan_items_patient_idx ON care_plan_items (patient_id);
