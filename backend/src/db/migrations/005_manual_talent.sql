-- The manual side of the product: CVs a recruiter uploads and roles they write
-- by hand, kept deliberately apart from anything WhatsApp produced.
--
-- Separate TABLES rather than a source column on the existing ones. A column
-- would put the burden on every query to remember a filter, and the one that
-- forgets is the one that shows a recruiter's curated upload next to an
-- unreviewed WhatsApp fragment. The two sides have genuinely different shapes
-- as well: a WhatsApp candidate is a message thread that happens to imply a
-- person, while an uploaded CV is a person with structured fields. Forcing
-- both into one table would leave most columns null for one of them.
--
-- They meet in exactly one place, by request: job match suggestions can draw
-- on both pools, and every suggestion records which pool it came from.

-- --------------------------------------------------------------------------
-- Uploaded CVs
-- --------------------------------------------------------------------------
CREATE TABLE candidates (
  id                  BIGSERIAL PRIMARY KEY,
  external_id         TEXT UNIQUE NOT NULL,

  -- The file as received, so a re-extraction never needs the upload again.
  -- Parsing improves; the source document does not change.
  file_name           TEXT,
  file_size           INTEGER,
  mime_type           TEXT,
  raw_text            TEXT NOT NULL,

  -- Extracted fields. All nullable: a CV that omits a phone number is normal,
  -- and a NOT NULL here would mean either rejecting the upload or inventing a
  -- value. Absent must stay distinguishable from wrong.
  name                TEXT,
  email               TEXT,
  phone               TEXT,
  current_company     TEXT,
  current_designation TEXT,
  location            TEXT,
  age                 INTEGER,
  qualifications      JSONB NOT NULL DEFAULT '[]'::jsonb,
  experience_years    NUMERIC(4,1),

  -- What produced the fields above, so a bad extraction can be found and
  -- re-run by version rather than by hand.
  extraction_model    TEXT,
  extraction_version  TEXT,
  extraction_notes    TEXT,

  uploaded_by         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX candidates_created_idx ON candidates (created_at DESC);
CREATE INDEX candidates_experience_idx ON candidates (experience_years);
-- Cheap prefilter support: the suggestion flow narrows on text before it
-- spends a model call, and without these it would sequential-scan every CV.
CREATE INDEX candidates_designation_idx ON candidates (lower(current_designation));
CREATE INDEX candidates_location_idx ON candidates (lower(location));

-- --------------------------------------------------------------------------
-- Hand-written roles
-- --------------------------------------------------------------------------
CREATE TABLE manual_jobs (
  id            BIGSERIAL PRIMARY KEY,
  external_id   TEXT UNIQUE NOT NULL,
  title         TEXT NOT NULL,
  company       TEXT,
  location      TEXT,
  description   TEXT NOT NULL DEFAULT '',
  requirements  JSONB NOT NULL DEFAULT '[]'::jsonb,
  min_experience_years NUMERIC(4,1),
  status        TEXT NOT NULL DEFAULT 'open',
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT manual_jobs_status_chk CHECK (status IN ('open', 'closed'))
);
CREATE INDEX manual_jobs_created_idx ON manual_jobs (created_at DESC);

-- --------------------------------------------------------------------------
-- Suggested matches for a hand-written role
-- --------------------------------------------------------------------------
-- Two nullable references with a check, rather than one polymorphic id. It
-- costs a constraint and buys real foreign keys in both directions: a deleted
-- candidate cannot leave a suggestion pointing at nothing.
CREATE TABLE job_match_suggestions (
  id             BIGSERIAL PRIMARY KEY,
  manual_job_id  BIGINT NOT NULL REFERENCES manual_jobs(id) ON DELETE CASCADE,

  source         TEXT NOT NULL,
  candidate_id   BIGINT REFERENCES candidates(id) ON DELETE CASCADE,
  submission_id  BIGINT REFERENCES submissions(id) ON DELETE CASCADE,

  verdict        TEXT NOT NULL,
  confidence     NUMERIC(4,3),
  reason         TEXT,
  evidence       JSONB NOT NULL DEFAULT '[]'::jsonb,
  model          TEXT,
  prompt_version TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT job_match_source_chk CHECK (source IN ('manual', 'whatsapp')),
  CONSTRAINT job_match_verdict_chk
    CHECK (verdict IN ('STRONG', 'PARTIAL', 'WEAK', 'NONE', 'NEEDS_REVIEW')),
  -- Exactly one target, matching the declared source.
  CONSTRAINT job_match_target_chk CHECK (
    (source = 'manual'   AND candidate_id IS NOT NULL AND submission_id IS NULL) OR
    (source = 'whatsapp' AND submission_id IS NOT NULL AND candidate_id IS NULL)
  )
);
CREATE INDEX job_match_job_idx ON job_match_suggestions (manual_job_id, created_at DESC);

-- One live suggestion per (job, candidate). Re-running a suggestion should
-- update the verdict, not accumulate a row per run.
CREATE UNIQUE INDEX job_match_unique_manual_idx
  ON job_match_suggestions (manual_job_id, candidate_id)
  WHERE candidate_id IS NOT NULL;
CREATE UNIQUE INDEX job_match_unique_wa_idx
  ON job_match_suggestions (manual_job_id, submission_id)
  WHERE submission_id IS NOT NULL;
