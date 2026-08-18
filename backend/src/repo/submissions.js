const { query } = require('../db');

/** Builds the text the classifier sees from a chained group of messages. */
function buildCombinedText(messages) {
  return messages
    .map((m) => {
      const parts = [];
      if (m.body) parts.push(m.body);
      if (m.media_text) parts.push(m.media_text);
      else if (m.media_type) {
        parts.push(`[${m.media_type}${m.media_filename ? `: ${m.media_filename}` : ''}]`);
      }
      return parts.join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
}

async function create({ chatId, contactId, messages }, client) {
  const run = client ? client.query.bind(client) : query;
  const combined = buildCombinedText(messages);
  const windowStart = messages[0].sent_at;
  const windowEnd = messages[messages.length - 1].sent_at;

  const { rows } = await run(
    `INSERT INTO submissions
       (chat_id, contact_id, combined_text, window_start, window_end)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [chatId, contactId, combined, windowStart, windowEnd]
  );
  const submission = rows[0];

  for (let i = 0; i < messages.length; i += 1) {
    await run(
      `INSERT INTO submission_messages (submission_id, message_id, position)
       VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [submission.id, messages[i].id, i]
    );
  }
  return submission;
}

async function markClassified(id, { kind, kindConfidence, continuesSubmissionId }, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `UPDATE submissions
        SET status = 'classified',
            kind = $2,
            kind_confidence = $3,
            continues_submission_id = $4,
            classified_at = now(),
            error = NULL
      WHERE id = $1
      RETURNING *`,
    [id, kind, kindConfidence, continuesSubmissionId || null]
  );
  return rows[0];
}

async function markFailed(id, message, client) {
  const run = client ? client.query.bind(client) : query;
  await run(
    `UPDATE submissions SET status = 'failed', error = $2 WHERE id = $1`,
    [id, String(message).slice(0, 2000)]
  );
}

/** Used when a retried attachment extraction adds text the original run lacked. */
async function updateCombinedText(id, combinedText, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    'UPDATE submissions SET combined_text = $2 WHERE id = $1 RETURNING *',
    [id, combinedText]
  );
  return rows[0];
}

async function findById(id) {
  const { rows } = await query('SELECT * FROM submissions WHERE id = $1', [id]);
  return rows[0] || null;
}

/**
 * The most recent classified application from this chat, used to decide
 * whether a new submission is a continuation of an earlier one rather than a
 * fresh application.
 */
async function latestApplicationForChat(chatId, excludeId) {
  const { rows } = await query(
    `SELECT * FROM submissions
      WHERE chat_id = $1
        AND kind = 'application'
        AND status = 'classified'
        AND ($2::bigint IS NULL OR id <> $2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [chatId, excludeId || null]
  );
  return rows[0] || null;
}

/**
 * The posting this chat was most recently working on, so a follow-up message
 * can be attached to it rather than becoming a role of its own.
 *
 * Window-limited on purpose. A recruiter's "send me your resume" belongs to the
 * description they posted a minute ago, not to one from last Tuesday, and
 * without a bound every stray fragment would be folded into whatever posting
 * happened to be newest in the chat.
 */
async function latestJobPostingForChat(chatId, excludeId, withinMinutes = 30) {
  const { rows } = await query(
    `SELECT * FROM submissions
      WHERE chat_id = $1
        AND kind = 'job_posting'
        AND status = 'classified'
        AND ($2::bigint IS NULL OR id <> $2)
        AND created_at > now() - make_interval(mins => $3)
      ORDER BY created_at DESC
      LIMIT 1`,
    [chatId, excludeId || null, withinMinutes]
  );
  return rows[0] || null;
}

module.exports = {
  create,
  updateCombinedText,
  markClassified,
  markFailed,
  findById,
  latestApplicationForChat,
  latestJobPostingForChat,
  buildCombinedText,
};
