-- Notes on anything, not just a talent-pool candidate.
--
-- The first pass gave notes to uploaded CVs, and the request that followed was
-- immediate: the same thing on roles, on postings and on WhatsApp applicants.
-- That is the normal shape of this feature — wherever a record is looked at, a
-- person eventually needs to record something about it that no field holds.
--
-- ONE table with four nullable references, rather than four tables or a
-- polymorphic (entity_type, entity_id) pair.
--
--   * Four tables would mean four copies of the same repo, route and component,
--     drifting the first time one of them gains an author or an edited flag.
--   * A polymorphic pair would mean no foreign keys at all: deleting a role
--     would silently leave its notes behind, pointing at an id that a later
--     role will eventually reuse — so old notes would resurface attached to
--     something they were never written about.
--
-- Real references cost a CHECK constraint and buy ON DELETE CASCADE in every
-- direction. This mirrors job_match_suggestions in 005, which chose the same
-- trade for the same reason.

CREATE TABLE notes (
  id            BIGSERIAL PRIMARY KEY,

  -- Exactly one of these is set. Which one it is says what the note is about.
  candidate_id  BIGINT REFERENCES candidates(id)   ON DELETE CASCADE,
  manual_job_id BIGINT REFERENCES manual_jobs(id)  ON DELETE CASCADE,
  jd_id         BIGINT REFERENCES jds(id)          ON DELETE CASCADE,
  -- Applicants attach to the CONTACT, not to the classification that was on
  -- screen. A classification is one verdict against one posting; the person is
  -- what a note is actually about. Anchored to the verdict, "called, not
  -- interested" would be invisible the next time they applied to something
  -- else — which is precisely when someone needs to read it.
  contact_id    BIGINT REFERENCES contacts(id)     ON DELETE CASCADE,

  body          TEXT NOT NULL,
  author        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT notes_body_chk CHECK (length(btrim(body)) > 0),
  CONSTRAINT notes_one_target_chk CHECK (
    (candidate_id  IS NOT NULL)::int +
    (manual_job_id IS NOT NULL)::int +
    (jd_id         IS NOT NULL)::int +
    (contact_id    IS NOT NULL)::int = 1
  )
);

-- One index per target, partial so each covers only the rows it can serve.
-- Oldest first is how notes are read, so they are indexed in that direction.
CREATE INDEX notes_candidate_idx  ON notes (candidate_id, created_at)  WHERE candidate_id  IS NOT NULL;
CREATE INDEX notes_manual_job_idx ON notes (manual_job_id, created_at) WHERE manual_job_id IS NOT NULL;
CREATE INDEX notes_jd_idx         ON notes (jd_id, created_at)         WHERE jd_id         IS NOT NULL;
CREATE INDEX notes_contact_idx    ON notes (contact_id, created_at)    WHERE contact_id    IS NOT NULL;

-- Carry over what 006 already collected. Ids are not preserved — nothing links
-- to a note by id except the note's own row — but timestamps are, because the
-- date is half of what makes an old note worth reading.
INSERT INTO notes (candidate_id, body, author, created_at, updated_at)
SELECT candidate_id, body, author, created_at, updated_at FROM candidate_notes;

DROP TABLE candidate_notes;
