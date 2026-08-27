-- A JD document on a hand-written role.
--
-- A role typed into the dashboard has a description field and nothing else.
-- The actual JD — the client's Word file, the signed spec — lived in somebody's
-- inbox, which meant the one artefact you need in front of you when you brief a
-- candidate was the one thing the role page could not give you.

-- --------------------------------------------------------------------------
-- Its own table, not four more columns on manual_jobs
-- --------------------------------------------------------------------------
-- manual_jobs is read with SELECT * in the list, the detail and the suggestion
-- queries. A BYTEA column on that table would be pulled into every one of them
-- — a list of forty roles would carry forty Word documents to render forty
-- titles — and the fix would be rewriting each of those queries to name their
-- columns and remembering forever after to keep the new one out.
--
-- A side table cannot be got wrong that way: nothing reads it unless it asks
-- for it, and SELECT * on manual_jobs stays exactly as cheap as it was. The
-- candidates table carries its bytes inline and documents the same hazard in
-- its FIELDS list; this is that lesson applied rather than repeated.
CREATE TABLE manual_job_files (
  -- One document per role, which is what makes re-uploading a replacement
  -- rather than a second file nobody can tell apart from the first. The
  -- primary key does that on its own: an upsert on conflict overwrites.
  manual_job_id BIGINT PRIMARY KEY REFERENCES manual_jobs(id) ON DELETE CASCADE,

  file_name     TEXT NOT NULL,
  file_size     BIGINT,
  -- What the uploading client claimed. Believed only far enough to decide
  -- whether the download is served inline, and never without nosniff — see the
  -- route, which serves anything that is not a PDF as an attachment.
  mime_type     TEXT,
  file_data     BYTEA NOT NULL,

  uploaded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT manual_job_files_name_chk CHECK (length(btrim(file_name)) > 0)
);

-- No index beyond the primary key: this table is only ever read by the id of
-- the role it hangs off, which the primary key already answers.
