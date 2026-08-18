-- A third state for job descriptions: posted, but not yet a role worth matching
-- against.
--
-- Recruiters split a posting across messages — the description in one, "anyone
-- interested, send me your resume" in the next. The follow-up was becoming a
-- job description in its own right: no title, no requirements, one line of
-- text. Harmless-looking, but a role with no requirements is a role every
-- candidate satisfies, so the matcher preferred it over the real openings and
-- returned STRONG for people it had nothing to judge.
--
-- Drafts are excluded from the matcher's candidate set (jds.listOpen filters on
-- status = 'open') while remaining visible and promotable in the UI. Dropping
-- the fragment instead would lose a real message, and leaving it open would
-- keep poisoning the matches.
ALTER TABLE jds DROP CONSTRAINT jds_status_chk;
ALTER TABLE jds ADD CONSTRAINT jds_status_chk
  CHECK (status IN ('open', 'closed', 'draft'));
