-- Token-aware rate limiting.
--
-- Counting requests per minute is the wrong meter for this workload. Groq's
-- free tier allows 8000 tokens per minute, and a single classification costs
-- three to five thousand of them — so the real ceiling is roughly two requests
-- a minute, and a request-per-minute budget of 25 permits a burst that is
-- rejected on arrival.
ALTER TABLE llm_call_log ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
