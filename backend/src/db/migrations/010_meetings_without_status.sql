-- Meetings lose open/closed.
--
-- The status was doing two jobs and neither was wanted: it filtered the list
-- into five views nobody used, and it gated a "close the meeting" step that
-- turned every conversation into an item you had to go back and tick off. A
-- meeting is now what it looks like on a calendar — a date, a person, a
-- subject — and everything that happened in it lives in its notes, which is
-- where the rest of that record already was.

-- --------------------------------------------------------------------------
-- Keep the writing before dropping the column that held it
-- --------------------------------------------------------------------------
-- An outcome is not a status. The status is bookkeeping and is being deleted
-- on purpose; the outcome is a sentence somebody typed about a real
-- conversation — "Strong on the technical side, wants 30 LPA" — and deleting
-- that would throw away the only record of it.
--
-- So each one becomes a note on its own meeting, which is exactly the shape it
-- always was: dated, attributed, and read in order with everything else that
-- happened. Nothing is lost except the column.
--
-- created_at is the moment it was actually concluded where that is known, so
-- the note lands in the timeline where it belongs rather than at today's date.
-- updated_at matches it, because the UI reads a difference between the two as
-- "edited" and this note has never been edited.
INSERT INTO notes (meeting_id, body, author, created_at, updated_at)
SELECT id,
       'Outcome: ' || btrim(outcome),
       created_by,
       COALESCE(closed_at, updated_at),
       COALESCE(closed_at, updated_at)
  FROM meetings
 WHERE outcome IS NOT NULL AND btrim(outcome) <> '';

-- --------------------------------------------------------------------------
-- Then drop it
-- --------------------------------------------------------------------------
-- Constraints and the index first: both name the columns, and Postgres will
-- not drop a column an index still depends on without CASCADE — which would
-- silently take anything else hanging off it too.
DROP INDEX IF EXISTS meetings_status_idx;

ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_status_chk;
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_closed_at_chk;

ALTER TABLE meetings
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS closed_at;

-- The remaining index is the one the list actually reads by. It was already
-- there; it is restated here only because dropping meetings_status_idx removes
-- the covering it used to get for date-ordered scans.
-- (meetings_scheduled_idx on scheduled_at DESC survives from 008.)
