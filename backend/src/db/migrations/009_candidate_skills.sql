-- Skills, as their own field.
--
-- Until now a skill was only findable if it happened to appear in the CV text,
-- which meant searching "Kubernetes" ranked whoever wrote the word most rather
-- than whoever can do it. A recruiter searching for a skill is asking a
-- question about the person, not about their document.
--
-- An array for the same reason qualifications and domains are: nobody has one
-- skill, and a single column would force a choice that loses the rest.
--
-- Distinct from domain_expertise on purpose. A domain is the sector someone has
-- worked in (BFSI, manufacturing); a skill is what they can do (Kubernetes,
-- IFRS, treasury management). Rolled together, a search for one returns the
-- other and both stop being useful.
ALTER TABLE candidates
  ADD COLUMN skills JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Searched directly, and by the shortlist prefilter before it spends a model
-- call, so it wants an index rather than a scan per query.
CREATE INDEX candidates_skills_idx ON candidates USING gin (skills);
