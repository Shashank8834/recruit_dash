const { query } = require('../db');

/**
 * Slides the flush deadline forward on every new message, so a batch only
 * closes after the sender has gone quiet for `quietSeconds`.
 *
 * `maxWindowSeconds` caps the total window: someone typing a message every
 * 30 seconds for an hour would otherwise defer classification indefinitely.
 * Once the cap is hit the deadline stops moving and the batch flushes.
 */
async function touch({ chatId, contactId, quietSeconds, maxWindowSeconds }, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `INSERT INTO pending_batches
       (chat_id, contact_id, first_message_at, last_message_at, flush_at, message_count)
     VALUES ($1, $2, now(), now(), now() + make_interval(secs => $3), 1)
     ON CONFLICT (chat_id) DO UPDATE
       SET last_message_at = now(),
           contact_id      = COALESCE(EXCLUDED.contact_id, pending_batches.contact_id),
           message_count   = pending_batches.message_count + 1,
           flush_at        = LEAST(
             now() + make_interval(secs => $3),
             pending_batches.first_message_at + make_interval(secs => $4)
           )
     RETURNING *`,
    [chatId, contactId, quietSeconds, maxWindowSeconds]
  );
  return rows[0];
}

/**
 * Claims batches whose quiet period has elapsed. SKIP LOCKED means several
 * worker processes can run concurrently without handing the same batch twice.
 *
 * `staleSeconds` re-claims batches whose worker died mid-flush.
 */
async function claimDue({ workerId, limit = 10, staleSeconds = 300 }, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `UPDATE pending_batches p
        SET claimed_at = now(), claimed_by = $1
      WHERE p.chat_id IN (
        SELECT chat_id
          FROM pending_batches
         WHERE flush_at <= now()
           AND (claimed_at IS NULL
                OR claimed_at < now() - make_interval(secs => $3))
         ORDER BY flush_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING p.*`,
    [workerId, limit, staleSeconds]
  );
  return rows;
}

async function remove(chatId, client) {
  const run = client ? client.query.bind(client) : query;
  await run('DELETE FROM pending_batches WHERE chat_id = $1', [chatId]);
}

/** Puts a failed batch back with a retry delay instead of dropping it. */
async function releaseWithBackoff(chatId, delaySeconds, client) {
  const run = client ? client.query.bind(client) : query;
  await run(
    `UPDATE pending_batches
        SET claimed_at = NULL,
            claimed_by = NULL,
            flush_at   = now() + make_interval(secs => $2)
      WHERE chat_id = $1`,
    [chatId, delaySeconds]
  );
}

module.exports = { touch, claimDue, remove, releaseWithBackoff };
