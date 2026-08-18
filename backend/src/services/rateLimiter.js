const { pool } = require('../db');

/**
 * A request budget shared by every process that talks to the model provider.
 *
 * An in-process limiter cannot work here. The API server, the batch worker and
 * each one-shot script (eval, backfill) are separate processes sharing one API
 * key, and a script re-run seconds after the last one starts with its counter
 * at zero — so it fires immediately into a window the previous run already
 * spent. Postgres is the one thing all of them share, so the budget lives
 * there: a log of recent calls, plus a note of any provider-imposed backoff so
 * one process hitting a 429 slows the others down too.
 *
 * Correctness comes from a transaction-scoped advisory lock: reserving a slot
 * is read-then-write, and without the lock two processes both read "4 used" and
 * both proceed.
 */

// Any stable arbitrary key; scopes the advisory lock to this concern.
const LOCK_KEY = 4711001;
const WINDOW_MS = 60000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Blocks until a request may be sent, then records it.
 *
 * Two ceilings, because providers enforce both: requests per minute and tokens
 * per minute. For this workload tokens bind far sooner — a single
 * classification costs thousands of them — so a request budget alone lets
 * through bursts that are rejected on arrival.
 *
 * @param {number} maxRpm  Requests per rolling minute. 0 disables.
 * @param {object} [opts]
 * @param {number} [opts.maxTpm]           Tokens per rolling minute. 0 disables.
 * @param {number} [opts.estimatedTokens]  Cost of the request about to be sent.
 * @param {number} [opts.maxWaitMs]        Give up rather than wait this long.
 */
async function acquire(maxRpm, opts = {}) {
  const maxTpm = opts.maxTpm || 0;
  const tokens = Math.max(opts.estimatedTokens || 0, 0);
  if ((!maxRpm || maxRpm <= 0) && (!maxTpm || maxTpm <= 0)) return { waitedMs: 0 };

  // A request larger than the entire per-minute budget can never be admitted,
  // however long we wait — the window empties to zero and it still does not
  // fit. Waiting out the full ceiling to discover that wastes fifteen minutes
  // and then fails anyway. Say so immediately, using the same TOKEN_LIMIT
  // marker the provider's own rejection carries, so the caller's shrink path
  // handles it identically — except now it costs no API call at all.
  if (maxTpm > 0 && tokens > maxTpm) {
    throw new Error(
      `TOKEN_LIMIT estimated ${tokens} tokens for one request, above the ` +
      `${maxTpm}-token LLM_MAX_TPM ceiling`
    );
  }

  const maxWaitMs = opts.maxWaitMs || 15 * 60000;
  const startedAt = Date.now();

  for (;;) {
    const { waitMs, logId } = await tryReserve(maxRpm, maxTpm, tokens);
    if (waitMs === 0) return { waitedMs: Date.now() - startedAt, logId };

    if (Date.now() - startedAt + waitMs > maxWaitMs) {
      throw new Error(
        `rate limiter would wait ${Math.round(waitMs / 1000)}s, beyond the ` +
        `${Math.round(maxWaitMs / 1000)}s ceiling`
      );
    }
    await sleep(Math.min(waitMs, 5000));
  }
}

/**
 * One attempt to claim a slot.
 *
 * The reservation is made on an ESTIMATE of the request's cost, because the
 * true cost is only known once the provider replies — and by then the request
 * has already been sent. The returned logId lets the caller correct the row
 * afterwards (see recordActual), so a systematically wrong estimate does not
 * quietly desynchronise the window from what the provider actually counted.
 *
 * @returns {Promise<{waitMs: number, logId: ?number}>} waitMs 0 if claimed.
 */
async function tryReserve(maxRpm, maxTpm, tokens) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise the read-then-write against other processes.
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);

    const { rows: throttle } = await client.query(
      `SELECT blocked_until FROM llm_throttle WHERE id`
    );
    const blockedUntil = throttle[0] && throttle[0].blocked_until;
    if (blockedUntil && new Date(blockedUntil) > new Date()) {
      const waitMs = new Date(blockedUntil) - new Date();
      await client.query('COMMIT');
      return { waitMs: Math.max(waitMs, 250), logId: null };
    }

    await client.query(
      `DELETE FROM llm_call_log WHERE called_at < now() - make_interval(secs => $1)`,
      [WINDOW_MS / 1000]
    );

    const { rows } = await client.query(
      `SELECT count(*)::int              AS used_requests,
              COALESCE(sum(tokens),0)::int AS used_tokens,
              min(called_at)             AS oldest
         FROM llm_call_log`
    );
    const { used_requests: usedRequests, used_tokens: usedTokens, oldest } = rows[0];

    const requestsOk = !maxRpm || maxRpm <= 0 || usedRequests < maxRpm;
    // Reserve the request's own cost against the window before sending it.
    const tokensOk = !maxTpm || maxTpm <= 0 || usedTokens + tokens <= maxTpm;

    if (requestsOk && tokensOk) {
      const { rows: logged } = await client.query(
        'INSERT INTO llm_call_log (tokens) VALUES ($1) RETURNING id',
        [tokens]
      );
      await client.query('COMMIT');
      return { waitMs: 0, logId: logged[0].id };
    }

    // Wait for the oldest call to age out of the rolling window.
    const ageOutAt = new Date(new Date(oldest).getTime() + WINDOW_MS);
    const waitMs = Math.max(ageOutAt - new Date(), 250);
    await client.query('COMMIT');
    return { waitMs, logId: null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A limiter failure must not take the pipeline down with it. Falling back
    // to "allow" risks a 429, which is retried; failing closed would stall
    // every classification behind an unrelated database problem.
    console.warn(`[ratelimit] unavailable, proceeding unpaced: ${err.message}`);
    return { waitMs: 0, logId: null };
  } finally {
    client.release();
  }
}

/**
 * Replaces a reservation's estimated cost with what the provider actually
 * counted.
 *
 * Estimating from character count is close but never exact, and the error is
 * one-directional per provider — always a little high or always a little low.
 * Left uncorrected that bias compounds across a window: too low and we
 * overshoot the ceiling and earn a 429, too high and we idle below it. The
 * usage figure in the response is the provider's own accounting, so prefer it
 * whenever it arrives.
 */
async function recordActual(logId, tokens) {
  if (!logId || !tokens || tokens <= 0) return;
  try {
    await pool.query('UPDATE llm_call_log SET tokens = $2 WHERE id = $1', [
      logId,
      Math.round(tokens),
    ]);
  } catch (err) {
    console.warn(`[ratelimit] could not record actual usage: ${err.message}`);
  }
}

/**
 * Records a provider-imposed backoff so every process honours it, not just the
 * one that happened to receive the 429.
 */
async function recordBackoff(ms, reason) {
  if (!ms || ms <= 0) return;
  try {
    await pool.query(
      `UPDATE llm_throttle
          SET blocked_until = GREATEST(
                COALESCE(blocked_until, now()),
                now() + make_interval(secs => $1)
              ),
              reason = $2,
              updated_at = now()
        WHERE id`,
      [ms / 1000, (reason || '').slice(0, 200)]
    );
  } catch (err) {
    console.warn(`[ratelimit] could not record backoff: ${err.message}`);
  }
}

/** Diagnostics: what the budget looks like right now. */
async function status() {
  const { rows } = await pool.query(
    `SELECT (SELECT count(*)::int FROM llm_call_log
              WHERE called_at > now() - interval '60 seconds') AS used_last_minute,
            (SELECT COALESCE(sum(tokens),0)::int FROM llm_call_log
              WHERE called_at > now() - interval '60 seconds') AS tokens_last_minute,
            (SELECT blocked_until FROM llm_throttle WHERE id)  AS blocked_until,
            (SELECT reason FROM llm_throttle WHERE id)         AS reason`
  );
  return rows[0];
}

module.exports = { acquire, recordActual, recordBackoff, status, WINDOW_MS };
