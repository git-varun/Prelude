-- m2-backlog C4-C7. A candidate with no extractable as_of_date is now
-- persisted (never dropped, never given a fabricated date) with
-- as_of_date NULL and facts.needs_manual_date = true, for staff to supply a
-- date during review. documents.needs_manual_date (migration 002) remains as
-- a derived summary: true when any of the document's facts needs a date.
ALTER TABLE facts ALTER COLUMN as_of_date DROP NOT NULL;
ALTER TABLE facts ADD COLUMN needs_manual_date BOOLEAN NOT NULL DEFAULT false;

-- An undated fact can be reviewed and corrected but never signed off: the
-- as-of date is part of what the oncologist is attesting to.
ALTER TABLE facts ADD CONSTRAINT no_signoff_while_undated CHECK (
  verification_state != 'oncologist_signed_off' OR as_of_date IS NOT NULL
);

-- Outcome of the LLM extraction + FACT persistence pass, so "the pass failed"
-- is distinguishable from "nothing extractable" (both otherwise look like a
-- document with zero facts). 'pending' = extraction not run yet (including
-- documents whose OCR failed, and rows that predate this column — their
-- extraction outcome is unknown, not assumed).
CREATE TYPE extraction_status AS ENUM ('pending', 'done', 'failed');
ALTER TABLE documents ADD COLUMN extraction_status extraction_status NOT NULL DEFAULT 'pending';
