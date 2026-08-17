-- Core principle: raw inbound data is immutable; every decision about it is
-- append-only and attributable. Nothing in this schema overwrites a verdict.

CREATE TABLE contacts (
  id           BIGSERIAL PRIMARY KEY,
  phone        TEXT UNIQUE NOT NULL,
  wa_jid       TEXT UNIQUE,
  push_name    TEXT,
  name         TEXT,
  email        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every inbound WhatsApp message, exactly as received. Never mutated.
CREATE TABLE messages (
  id              BIGSERIAL PRIMARY KEY,
  wa_message_id   TEXT UNIQUE NOT NULL,
  chat_id         TEXT NOT NULL,
  contact_id      BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  from_me         BOOLEAN NOT NULL DEFAULT false,
  body            TEXT NOT NULL DEFAULT '',
  media_type      TEXT,
  media_url       TEXT,
  media_mime      TEXT,
  media_filename  TEXT,
  media_text      TEXT,
  sent_at         TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw             JSONB
);
CREATE INDEX messages_chat_sent_idx ON messages (chat_id, sent_at DESC);
CREATE INDEX messages_contact_idx ON messages (contact_id);

-- The debounce window. One open batch per chat; flush_at slides forward on
-- every new message. Lives in Postgres so a restart can't lose a pending batch.
CREATE TABLE pending_batches (
  chat_id           TEXT PRIMARY KEY,
  contact_id        BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  first_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_message_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  flush_at          TIMESTAMPTZ NOT NULL,
  message_count     INTEGER NOT NULL DEFAULT 0,
  claimed_at        TIMESTAMPTZ,
  claimed_by        TEXT
);
CREATE INDEX pending_batches_flush_idx ON pending_batches (flush_at);

-- A chained group of messages treated as one logical unit of work.
CREATE TABLE submissions (
  id                       BIGSERIAL PRIMARY KEY,
  chat_id                  TEXT NOT NULL,
  contact_id               BIGINT REFERENCES contacts(id) ON DELETE SET NULL,
  combined_text            TEXT NOT NULL,
  kind                     TEXT,
  kind_confidence          NUMERIC(3,2),
  continues_submission_id  BIGINT REFERENCES submissions(id) ON DELETE SET NULL,
  status                   TEXT NOT NULL DEFAULT 'pending',
  error                    TEXT,
  window_start             TIMESTAMPTZ NOT NULL,
  window_end               TIMESTAMPTZ NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  classified_at            TIMESTAMPTZ,
  CONSTRAINT submissions_status_chk
    CHECK (status IN ('pending','classified','failed'))
);
CREATE INDEX submissions_chat_idx ON submissions (chat_id, created_at DESC);
CREATE INDEX submissions_status_idx ON submissions (status);

CREATE TABLE submission_messages (
  submission_id BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  message_id    BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  PRIMARY KEY (submission_id, message_id)
);

CREATE TABLE jds (
  id             BIGSERIAL PRIMARY KEY,
  external_id    TEXT UNIQUE NOT NULL,
  submission_id  BIGINT REFERENCES submissions(id) ON DELETE SET NULL,
  title          TEXT,
  posted_by      TEXT,
  jd_text        TEXT NOT NULL,
  requirements   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status         TEXT NOT NULL DEFAULT 'open',
  posted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT jds_status_chk CHECK (status IN ('open','closed'))
);
CREATE INDEX jds_posted_idx ON jds (posted_at DESC);

-- Append-only. A re-run inserts a new row and demotes the old one; it never
-- destroys the previous verdict. This is what makes reclassification safe.
CREATE TABLE classifications (
  id              BIGSERIAL PRIMARY KEY,
  submission_id   BIGINT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  jd_id           BIGINT REFERENCES jds(id) ON DELETE SET NULL,
  verdict         TEXT NOT NULL,
  confidence      NUMERIC(3,2),
  reason          TEXT,
  evidence        JSONB NOT NULL DEFAULT '[]'::jsonb,
  model           TEXT,
  prompt_version  TEXT,
  is_current      BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT classifications_verdict_chk
    CHECK (verdict IN ('STRONG','PARTIAL','WEAK','NONE','NEEDS_REVIEW','UNKNOWN'))
);
-- At most one live verdict per (submission, jd). COALESCE handles the
-- "matched no JD" case, where jd_id is NULL.
CREATE UNIQUE INDEX classifications_current_uniq
  ON classifications (submission_id, COALESCE(jd_id, 0))
  WHERE is_current;
CREATE INDEX classifications_jd_idx ON classifications (jd_id) WHERE is_current;
CREATE INDEX classifications_verdict_idx ON classifications (verdict) WHERE is_current;

-- A human decision always outranks the model. Stored separately so re-running
-- the classifier can never clobber a review.
CREATE TABLE human_overrides (
  id                 BIGSERIAL PRIMARY KEY,
  classification_id  BIGINT NOT NULL UNIQUE
                       REFERENCES classifications(id) ON DELETE CASCADE,
  verdict            TEXT NOT NULL,
  reviewer           TEXT,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT human_overrides_verdict_chk
    CHECK (verdict IN ('STRONG','PARTIAL','WEAK','NONE','UNKNOWN'))
);

-- Hand-labelled cases. Without these you can't tell whether a prompt change
-- helped or just moved the errors around.
CREATE TABLE golden_labels (
  id                BIGSERIAL PRIMARY KEY,
  label             TEXT NOT NULL,
  input_text        TEXT NOT NULL,
  expected_kind     TEXT,
  expected_verdict  TEXT,
  jd_external_id    TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Postgres is the source of truth; the sheet is a mirror fed from this queue.
CREATE TABLE sheet_sync_queue (
  id          BIGSERIAL PRIMARY KEY,
  entity      TEXT NOT NULL,
  entity_id   BIGINT NOT NULL,
  op          TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at   TIMESTAMPTZ,
  CONSTRAINT sheet_sync_entity_chk CHECK (entity IN ('jd','applicant')),
  CONSTRAINT sheet_sync_op_chk CHECK (op IN ('upsert','delete'))
);
CREATE INDEX sheet_sync_pending_idx ON sheet_sync_queue (created_at)
  WHERE synced_at IS NULL;

-- The dashboard's read model: one row per candidate verdict, with the human
-- override already applied.
CREATE VIEW applicant_rows AS
SELECT
  c.id                                   AS classification_id,
  s.id                                   AS submission_id,
  'APP_' || c.id                         AS external_id,
  COALESCE(j.external_id, 'NONE')        AS jd_external_id,
  j.id                                   AS jd_id,
  ct.id                                  AS contact_id,
  ct.phone,
  ct.email,
  COALESCE(ct.name, ct.push_name)        AS name,
  COALESCE(ct.push_name, ct.phone)       AS sender,
  s.combined_text                        AS message,
  COALESCE(h.verdict, c.verdict)         AS result,
  c.verdict                              AS model_verdict,
  h.verdict                              AS override_verdict,
  h.reviewer                             AS override_reviewer,
  h.note                                 AS override_note,
  c.confidence,
  c.reason,
  c.evidence,
  c.model,
  c.prompt_version,
  s.created_at                           AS created_at,
  EXTRACT(EPOCH FROM s.created_at)::bigint AS ts
FROM classifications c
JOIN submissions s ON s.id = c.submission_id
LEFT JOIN jds j ON j.id = c.jd_id
LEFT JOIN contacts ct ON ct.id = s.contact_id
LEFT JOIN human_overrides h ON h.classification_id = c.id
WHERE c.is_current;
