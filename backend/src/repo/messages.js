const { query } = require('../db');

/**
 * Inserts an inbound message. Returns null when the message has already been
 * stored — Evolution retries webhook deliveries, so the wa_message_id unique
 * constraint is what makes ingestion idempotent.
 */
async function insert(msg, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `INSERT INTO messages (
       wa_message_id, chat_id, contact_id, from_me, body,
       media_type, media_url, media_mime, media_filename, sent_at, raw
     )
     VALUES ($1,$2,$3,false,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING *`,
    [
      msg.waMessageId,
      msg.chatId,
      msg.contactId,
      msg.body,
      msg.mediaType,
      msg.mediaUrl,
      msg.mediaMime,
      msg.mediaFilename,
      msg.sentAt,
      msg.raw ? JSON.stringify(msg.raw) : null,
    ]
  );
  return rows[0] || null;
}

/** Messages in a chat not yet attached to any submission, oldest first. */
async function unbatchedForChat(chatId, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `SELECT m.*
       FROM messages m
      WHERE m.chat_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM submission_messages sm WHERE sm.message_id = m.id
        )
      ORDER BY m.sent_at ASC, m.id ASC`,
    [chatId]
  );
  return rows;
}

/** Recent chat history for classifier context, oldest first. */
async function recentForChat(chatId, limit = 12, beforeId = null) {
  const { rows } = await query(
    `SELECT * FROM (
       SELECT m.*
         FROM messages m
        WHERE m.chat_id = $1
          AND ($3::bigint IS NULL OR m.id < $3)
        ORDER BY m.sent_at DESC, m.id DESC
        LIMIT $2
     ) t
     ORDER BY t.sent_at ASC, t.id ASC`,
    [chatId, limit, beforeId]
  );
  return rows;
}

async function forSubmission(submissionId) {
  const { rows } = await query(
    `SELECT m.*
       FROM submission_messages sm
       JOIN messages m ON m.id = sm.message_id
      WHERE sm.submission_id = $1
      ORDER BY sm.position ASC`,
    [submissionId]
  );
  return rows;
}

async function setMediaText(id, text) {
  await query('UPDATE messages SET media_text = $2 WHERE id = $1', [id, text]);
}

module.exports = {
  insert,
  unbatchedForChat,
  recentForChat,
  forSubmission,
  setMediaText,
};
