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
 * @param {number} maxRpm  Requests permitted per rolling minute. 0 disables.
 * @param {object} [opts]
 * @param {number} [opts.maxWaitMs]  Give up rather than wait longer than this.
 */
async function acquire(maxRpm, opts = {}) {
  if (!maxRpm || maxRpm <= 0) return { waitedMs: 0 };

  const maxWaitMs = opts.maxWaitMs || 15 * 60000;
  const startedAt = Date.now();

  for (;;) {
    const waitMs = await tryReserve(maxRpm);
    if (waitMs === 0) return { waitedMs: Date.now() - startedAt };

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
 * @returns {Promise<number>} 0 if claimed, otherwise ms to wait before retrying.
 */
async function tryReserve(maxRpm) {
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
      return Math.max(waitMs, 250);
    }

    await client.query(
      `DELETE FROM llm_call_log WHERE called_at < now() - make_interval(secs => $1)`,
      [WINDOW_MS / 1000]
    );

    const { rows } = await client.query(
      `SELECT count(*)::int AS used,
              min(called_at)  AS oldest
         FROM llm_call_log`
    );
    const { used, oldest } = rows[0];

    if (used < maxRpm) {
      await client.query('INSERT INTO llm_call_log DEFAULT VALUES');
      await client.query('COMMIT');
      return 0;
    }

    // Full: wait until the oldest call ages out of the window.
    const ageOutAt = new Date(new Date(oldest).getTime() + WINDOW_MS);
    const waitMs = Math.max(ageOutAt - new Date(), 250);
    await client.query('COMMIT');
    return waitMs;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // A limiter failure must not take the pipeline down with it. Falling back
    // to "allow" risks a 429, which is retried; failing closed would stall
    // every classification behind an unrelated database problem.
    console.warn(`[ratelimit] unavailable, proceeding unpaced: ${err.message}`);
    return 0;
  } finally {
    client.release();
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
            (SELECT blocked_until FROM llm_throttle WHERE id)  AS blocked_until,
            (SELECT reason FROM llm_throttle WHERE id)         AS reason`
  );
  return rows[0];
}

module.exports = { acquire, recordBackoff, status, WINDOW_MS };
