-- Supports the M2 extraction-persistence pipeline (documents.ts's
-- persistExtractedFacts): tracked_marker_id is only set on a confident match
-- against the patient's existing TRACKED_MARKER rows; raw_marker_label holds
-- the extraction pass's raw marker name whenever it doesn't, so staff can
-- see what to map it to.

ALTER TABLE facts ADD COLUMN raw_marker_label TEXT;

-- Set when a document's extraction produced facts with no extractable
-- as_of_date anywhere, so those candidates are held rather than persisted
-- with a fabricated date. Surfaced to the (future) Extraction Review screen
-- for manual date entry.
ALTER TABLE documents ADD COLUMN needs_manual_date BOOLEAN NOT NULL DEFAULT false;
