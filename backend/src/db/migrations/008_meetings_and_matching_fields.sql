-- Two additions: meetings, and three candidate attributes the matcher was
-- guessing at.

-- --------------------------------------------------------------------------
-- Three more fields on a candidate
-- --------------------------------------------------------------------------
-- These are the attributes a recruiter screens on before anything else and the
-- matcher could not see at all, so it was ranking on title and skills while a
-- human was rejecting on money and sector.

-- Salary in three columns rather than one, because a single one always loses
-- something that matters:
--
--   salary_text     what the CV actually says ("18 LPA", "₹22,00,000 + ESOPs")
--   salary_amount   the same figure as an annual number, for filtering
--   salary_currency what that number is denominated in
--
-- The verbatim text is kept because salary is the field where a wrong
-- normalisation is most expensive and least visible: "18" could be lakhs,
-- thousands, or an hourly rate, and a recruiter quoting a candidate the wrong
-- number finds out in front of the candidate. Keeping the source string means
-- the normalisation can always be checked, and re-done if the parsing improves.
--
-- NUMERIC(14,2) holds an annual figure in minor-unit-free terms — 2,200,000
-- rupees, not 22 lakhs — so amounts stay comparable across currencies.
ALTER TABLE candidates
  ADD COLUMN salary_text     TEXT,
  ADD COLUMN salary_amount   NUMERIC(14,2),
  ADD COLUMN salary_currency TEXT;

-- Sectors worked in, as an array: people genuinely span more than one, and a
-- single column forces a choice that loses the second. Same shape as
-- qualifications, which is already an array for the same reason.
ALTER TABLE candidates
  ADD COLUMN domain_expertise JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Whether the current employer is publicly listed. A three-state field where
-- NULL means "the CV did not say" — which is the common case and must stay
-- distinguishable from "we established it is unlisted".
ALTER TABLE candidates
  ADD COLUMN company_listing_status TEXT,
  ADD CONSTRAINT candidates_listing_status_chk
    CHECK (company_listing_status IN ('listed', 'unlisted'));

-- The shortlist prefilter ranks on text before it spends a model call. Domain
-- is the strongest of the three signals there — "BFSI", "manufacturing" — so
-- it wants an index like the designation and location ones from 005.
CREATE INDEX candidates_domain_idx ON candidates USING gin (domain_expertise);
CREATE INDEX candidates_salary_idx ON candidates (salary_amount);

-- --------------------------------------------------------------------------
-- Meetings
-- --------------------------------------------------------------------------
-- A meeting is its own record, not a note with a date. A note is something
-- that happened; a meeting is something that is arranged, happens, and then
-- has to be concluded — it has a date in the future, a state that changes, and
-- an outcome that does not exist yet when it is created. None of that fits a
-- free-text note, and putting it there means nobody can answer "who am I
-- seeing on Thursday" or "which conversations did I never close".
CREATE TABLE meetings (
  id            BIGSERIAL PRIMARY KEY,
  external_id   TEXT UNIQUE NOT NULL,

  -- Who came. The same two pools that suggestions draw on, and the same
  -- treatment: real references rather than one polymorphic id, so a deleted
  -- person cannot leave a meeting pointing at nobody.
  candidate_id  BIGINT REFERENCES candidates(id) ON DELETE CASCADE,
  contact_id    BIGINT REFERENCES contacts(id)   ON DELETE CASCADE,

  -- What it was about, when there is a role behind it. Optional, because plenty
  -- of meetings are a general conversation with someone worth knowing.
  --
  -- SET NULL rather than CASCADE: a role being closed and deleted must not
  -- erase the record that you met three people for it. The meeting outlives
  -- the vacancy.
  manual_job_id BIGINT REFERENCES manual_jobs(id) ON DELETE SET NULL,

  -- The date and time it is set for. In the future when created, in the past
  -- once it has happened — which is what makes "upcoming" and "overdue"
  -- answerable at all.
  scheduled_at  TIMESTAMPTZ NOT NULL,
  subject       TEXT NOT NULL,

  -- open until it is concluded. Closing is a deliberate act that records how it
  -- went; an outcome without a closed status, or the reverse, is a
  -- half-finished record, so the two move together.
  status        TEXT NOT NULL DEFAULT 'open',
  outcome       TEXT,
  closed_at     TIMESTAMPTZ,

  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT meetings_status_chk CHECK (status IN ('open', 'closed')),
  CONSTRAINT meetings_subject_chk CHECK (length(btrim(subject)) > 0),
  CONSTRAINT meetings_one_person_chk CHECK (
    (candidate_id IS NOT NULL)::int + (contact_id IS NOT NULL)::int = 1
  ),
  -- closed_at exists exactly when the meeting is closed. Without this, a
  -- reopened meeting keeps a closing date and every "how long was it open"
  -- question answers wrongly.
  CONSTRAINT meetings_closed_at_chk CHECK (
    (status = 'closed') = (closed_at IS NOT NULL)
  )
);

-- The timeline query: everything in date order, open ones first when it
-- matters. Both directions are read, so index the column plainly.
CREATE INDEX meetings_scheduled_idx ON meetings (scheduled_at DESC);
CREATE INDEX meetings_status_idx ON meetings (status, scheduled_at);
CREATE INDEX meetings_candidate_idx ON meetings (candidate_id, scheduled_at DESC) WHERE candidate_id IS NOT NULL;
CREATE INDEX meetings_contact_idx ON meetings (contact_id, scheduled_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX meetings_job_idx ON meetings (manual_job_id, scheduled_at DESC) WHERE manual_job_id IS NOT NULL;

-- --------------------------------------------------------------------------
-- Notes on a meeting
-- --------------------------------------------------------------------------
-- This is the timeline. A meeting's own fields say when it is and how it
-- ended; the notes are what happened in between — rescheduled twice, client
-- asked for a second round, candidate went quiet. Read in order, they are the
-- history of the conversation, which is the thing that gets lost when it lives
-- in someone's head.
ALTER TABLE notes ADD COLUMN meeting_id BIGINT REFERENCES meetings(id) ON DELETE CASCADE;

ALTER TABLE notes DROP CONSTRAINT notes_one_target_chk;
ALTER TABLE notes ADD CONSTRAINT notes_one_target_chk CHECK (
  (candidate_id  IS NOT NULL)::int +
  (manual_job_id IS NOT NULL)::int +
  (jd_id         IS NOT NULL)::int +
  (contact_id    IS NOT NULL)::int +
  (meeting_id    IS NOT NULL)::int = 1
);

CREATE INDEX notes_meeting_idx ON notes (meeting_id, created_at) WHERE meeting_id IS NOT NULL;
