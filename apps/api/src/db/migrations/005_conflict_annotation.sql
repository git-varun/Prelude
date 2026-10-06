-- M7 conflict resolution workflow. The Blueprint's conflicts DDL (docs/02)
-- never shipped an annotation_note column; this adds it. Distinct from
-- resolution_note: annotation_note is set by the open->annotated step
-- (staff or oncologist flagging what they found), resolution_note by the
-- ->resolved step (oncologist-only). Both are free text, independently
-- nullable, and never overwrite each other.
ALTER TABLE conflicts ADD COLUMN IF NOT EXISTS annotation_note TEXT;
