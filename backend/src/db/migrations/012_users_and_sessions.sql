-- Who is allowed in, and who is currently in.
--
-- Until now there was no answer to either question: every route under /api was
-- reachable by anyone who knew the host and port, and the dashboard holds CVs,
-- phone numbers, salaries and private notes about named people. A login page
-- over an open API would only have hidden the screens, so the session this
-- table issues is what the API itself checks.

-- --------------------------------------------------------------------------
-- users
-- --------------------------------------------------------------------------
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,

  -- Stored lowercase and unique. Case-sensitive emails mean "Shashank@..." and
  -- "shashank@..." are two accounts, one of which nobody can log into because
  -- they typed it the other way. CITEXT would do this too but is an extension,
  -- and this stack should install on a bare Postgres.
  email         TEXT NOT NULL UNIQUE,

  -- What gets shown beside a note. Required, because the whole point of
  -- accounts here is that a note says who wrote it, and a null name would put
  -- an anonymous note back on the screen.
  name          TEXT NOT NULL,

  -- scrypt, salted per user, in the encoded form services/password.js writes.
  -- Never a plain password, and never reversible: this column is the one thing
  -- in the database that an attacker most wants and can least afford to get.
  password_hash TEXT NOT NULL,

  -- Revoking access without deleting the person. Deleting a user would take
  -- their name off every note they ever wrote, which is a record of what
  -- happened and should survive them leaving.
  disabled_at   TIMESTAMPTZ,

  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_email_chk CHECK (email = lower(btrim(email)) AND email LIKE '%_@_%'),
  CONSTRAINT users_name_chk  CHECK (length(btrim(name)) > 0)
);

-- --------------------------------------------------------------------------
-- sessions
-- --------------------------------------------------------------------------
-- A table rather than a signed stateless cookie (a JWT or similar). The
-- difference that matters here is revocation: a stateless token stays valid
-- until it expires no matter what you do, so "someone left, lock them out now"
-- is not something you can honour. A row can be deleted, and the next request
-- is refused.
CREATE TABLE sessions (
  -- The HASH of the cookie value, not the value itself. A session token is a
  -- bearer credential — whoever holds it IS the user, no password needed — so
  -- storing it verbatim would mean a single SELECT on this table, from a
  -- backup or a read-only leak, hands over every live login. Hashed, the table
  -- can only confirm a token someone already has.
  token_hash  TEXT PRIMARY KEY,

  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Absolute, set at issue. A session that never expires is a laptop left in a
  -- cafe that stays logged in forever.
  expires_at  TIMESTAMPTZ NOT NULL,

  -- Kept so a person can see their own logins and spot one they do not
  -- recognise. Deliberately not used for anything security-critical: both are
  -- client-supplied and neither is evidence of anything on its own.
  user_agent  TEXT,
  ip          TEXT,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Logging out everywhere, and clearing a disabled user's live sessions, both
-- select by user rather than by token.
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- The sweep of expired rows runs on this.
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
