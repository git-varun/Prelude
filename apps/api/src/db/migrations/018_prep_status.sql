-- M3-09 (B6): prep status on the visit, and the interim "find report" request on a plan item.
ALTER TABLE visits
  ADD COLUMN IF NOT EXISTS prep_status TEXT NOT NULL DEFAULT 'preparing' CHECK (prep_status IN ('preparing', 'ready')),
  ADD COLUMN IF NOT EXISTS prep_set_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS prep_set_at TIMESTAMPTZ;

ALTER TABLE care_plan_items
  ADD COLUMN IF NOT EXISTS report_requested_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS report_requested_at TIMESTAMPTZ;
