-- Two additions to the talent pool: how a candidate is classified, and the
-- means to stop the same person being added twice.

-- --------------------------------------------------------------------------
-- Employee type
-- --------------------------------------------------------------------------
-- 'elite' or 'non_elite', with NULL meaning nobody has classified this person
-- yet. Three states rather than two, because every candidate already in the
-- pool predates the field and defaulting them all to one side would be a
-- classification nobody made — and an unclassified candidate must stay
-- distinguishable from one deliberately marked non-elite.
--
-- referred_by belongs to the non-elite side only. An elite candidate came in
-- on their own record; a non-elite one is here because somebody put them
-- forward, and that name is the first thing asked for when the placement is
-- discussed. The constraint keeps the pair honest: a referrer on an elite
-- candidate is a leftover from a reclassification, and reading it later would
-- credit a referral that no longer exists.
ALTER TABLE candidates
  ADD COLUMN employee_type TEXT,
  ADD COLUMN referred_by   TEXT,
  ADD CONSTRAINT candidates_employee_type_chk
    CHECK (employee_type IN ('elite', 'non_elite')),
  ADD CONSTRAINT candidates_referred_by_chk
    CHECK (referred_by IS NULL OR employee_type = 'non_elite');

-- Filtered on from the pool screen, and NULL is the common value, so the index
-- only carries the rows a filter can actually match.
CREATE INDEX candidates_employee_type_idx ON candidates (employee_type)
  WHERE employee_type IS NOT NULL;

-- --------------------------------------------------------------------------
-- Finding someone who is already here
-- --------------------------------------------------------------------------
-- The same person arriving twice — a CV uploaded again a month later, a
-- referral typed in by someone who did not know they were already in the pool
-- — used to become two rows, and the notes, meetings and match history then
-- split across both. Email and phone are what identify a person here; names
-- repeat and job titles change.
--
-- Indexes rather than unique constraints, deliberately. Any pool in use
-- already contains duplicates created before this existed, and a unique index
-- would refuse to be created at all — the migration would fail on exactly the
-- databases that most need the check. These make the lookup cheap; the routes
-- do the refusing, and the pairs already in the table stay readable and
-- mergeable by hand.
--
-- Phone is matched on its last ten digits so that formatting never decides
-- identity: '+91 98765 43210', '098765 43210' and '9876543210' are one person,
-- and no amount of punctuation in one of them makes a second record.
CREATE INDEX candidates_email_lookup_idx ON candidates (lower(btrim(email)))
  WHERE email IS NOT NULL;
CREATE INDEX candidates_phone_lookup_idx
  ON candidates (right(regexp_replace(phone, '\D', '', 'g'), 10))
  WHERE phone IS NOT NULL;
