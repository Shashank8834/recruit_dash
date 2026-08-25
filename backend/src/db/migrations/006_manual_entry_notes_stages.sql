-- Second pass over the manual side, from recruiter feedback:
--   * candidates typed in by hand, with no CV to parse
--   * notes on a candidate, added over time and carried into the export
--   * the original CV kept viewable and downloadable, not just its text
--   * roles that move through stages rather than flipping open/closed

-- --------------------------------------------------------------------------
-- Candidates entered by hand
-- --------------------------------------------------------------------------
-- Not every candidate arrives as a document. A referral or a phone screen is a
-- name and a number someone types in, and refusing to store that would push it
-- into a private spreadsheet where the matcher can never see it.
--
-- One column rather than a separate table: a hand-typed candidate and a parsed
-- one hold exactly the same fields. The only real difference is provenance,
-- and provenance is what this column records — so a recruiter reading a profile
-- knows whether a blank designation means "the CV didn't say" or "nobody typed
-- it in yet".
ALTER TABLE candidates
  ADD COLUMN entry_mode TEXT NOT NULL DEFAULT 'upload',
  ADD CONSTRAINT candidates_entry_mode_chk CHECK (entry_mode IN ('upload', 'manual'));

-- Hand-entered candidates have no document behind them, so the source text is
-- legitimately empty. It stays NOT NULL — absent text is '', never unknown.
ALTER TABLE candidates ALTER COLUMN raw_text SET DEFAULT '';

-- --------------------------------------------------------------------------
-- The CV as a file
-- --------------------------------------------------------------------------
-- Extraction reduces a CV to the fields we thought to ask for, and a recruiter
-- reading a profile routinely wants the half we didn't: the project list, the
-- formatting, the gap between two jobs. Keeping the bytes means the document
-- can be opened and sent on without going back to whoever supplied it.
--
-- BYTEA rather than a directory or a bucket: there is no object store in this
-- deployment, and a file on the API container's disk is lost on the next
-- deploy while the row that points at it survives — a link to nothing is worse
-- than no link. Uploads are capped at CV_UPLOAD_MAX_MB (15MB by default), so
-- the rows stay within what Postgres stores comfortably out of line.
ALTER TABLE candidates ADD COLUMN file_data BYTEA;

-- --------------------------------------------------------------------------
-- Notes on a candidate
-- --------------------------------------------------------------------------
-- A table, not a text column. "As and when required" means notes accumulate:
-- a screening call today, a salary expectation next week. A single column
-- forces each new note to be pasted onto the end of the last one, and the first
-- careless edit takes the earlier note with it. Rows also give each note a time
-- and an author, which is most of what makes an old note worth reading.
CREATE TABLE candidate_notes (
  id           BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  author       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT candidate_notes_body_chk CHECK (length(btrim(body)) > 0)
);
-- Oldest first is how they are read, so index in that direction.
CREATE INDEX candidate_notes_candidate_idx ON candidate_notes (candidate_id, created_at);

-- --------------------------------------------------------------------------
-- Role stages
-- --------------------------------------------------------------------------
-- open → reviewing → placed → closed. The two extra stages are the ones that
-- carry information: "reviewing" says candidates are already in play, and
-- "placed" says the role ended in a hire rather than being abandoned. Collapsed
-- into open/closed, a filled role and a cancelled one look identical.
--
-- Existing rows are all 'open' or 'closed' and stay valid, so no backfill.
ALTER TABLE manual_jobs DROP CONSTRAINT manual_jobs_status_chk;
ALTER TABLE manual_jobs ADD CONSTRAINT manual_jobs_status_chk
  CHECK (status IN ('open', 'reviewing', 'placed', 'closed'));
