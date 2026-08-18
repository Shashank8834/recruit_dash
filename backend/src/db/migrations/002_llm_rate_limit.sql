-- Cross-process rate limiting for the model provider.
--
-- The previous limiter kept its state in a module-level variable, so every
-- process started believing the full quota was available. The API, the worker
-- and each one-shot script are separate processes sharing one API key, and a
-- script re-run seconds later would immediately spend a window that was
-- already exhausted. Postgres is the one thing they all share, so the budget
-- lives here.

CREATE TABLE llm_call_log (
  id        BIGSERIAL PRIMARY KEY,
  called_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX llm_call_log_called_at_idx ON llm_call_log (called_at);

-- When the provider returns a 429 it tells us how long to wait. Recording that
-- centrally means every other process backs off too, instead of each one
-- discovering the same limit separately.
CREATE TABLE llm_throttle (
  id            BOOLEAN PRIMARY KEY DEFAULT true,
  blocked_until TIMESTAMPTZ,
  reason        TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT llm_throttle_singleton CHECK (id)
);

INSERT INTO llm_throttle (id, blocked_until) VALUES (true, NULL);
