const { withTransaction } = require('../db');
const { normalize, describeIgnore } = require('./evolution');
const contacts = require('../repo/contacts');
const messages = require('../repo/messages');
const batches = require('../repo/batches');

const QUIET_SECONDS = parseInt(process.env.BATCH_QUIET_SECONDS || '60', 10);
const MAX_WINDOW_SECONDS = parseInt(process.env.BATCH_MAX_WINDOW_SECONDS || '600', 10);

/**
 * Chats we ingest from. Evolution delivers every inbound message on the
 * instance — group traffic, DMs, everything — so without a filter a single
 * personal DM becomes a candidate row. Empty means allow all.
 *
 * Entries are full JIDs: "120363...@g.us" for a group, "9198...@s.whatsapp.net"
 * for a direct chat.
 */
const ALLOWED_CHATS = new Set(
  (process.env.INGEST_ALLOWED_CHATS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function isAllowedChat(chatId) {
  return ALLOWED_CHATS.size === 0 || ALLOWED_CHATS.has(chatId);
}

/**
 * Webhook entry point: store the message, then slide this chat's flush
 * deadline forward. Deliberately does no classification — the webhook must
 * return fast, and the decision of when the sender has finished talking
 * belongs to the worker.
 */
async function ingest(payload) {
  const norm = normalize(payload);
  if (!norm) {
    // Set WEBHOOK_DEBUG=1 while wiring Evolution up: a bare "ignored" tells you
    // nothing about which of a dozen reasons applied.
    const reason = describeIgnore(payload);
    if (process.env.WEBHOOK_DEBUG === '1') {
      console.log(`[ingest] ignored: ${reason}`);
      console.log(`[ingest] payload: ${JSON.stringify(payload).slice(0, 1500)}`);
    }
    return { status: 'ignored', reason };
  }

  if (!isAllowedChat(norm.chatId)) {
    const reason = `chat ${norm.chatId} is not in INGEST_ALLOWED_CHATS`;
    if (process.env.WEBHOOK_DEBUG === '1') console.log(`[ingest] ignored: ${reason}`);
    return { status: 'ignored', reason };
  }

  return withTransaction(async (client) => {
    let contact = null;
    if (norm.phone) {
      contact = await contacts.upsertByPhone(
        { phone: norm.phone, waJid: norm.senderJid, pushName: norm.pushName },
        client
      );
    }

    const stored = await messages.insert(
      { ...norm, contactId: contact ? contact.id : null },
      client
    );

    // Evolution retries deliveries; a repeat must not restart the quiet window.
    if (!stored) return { status: 'duplicate', waMessageId: norm.waMessageId };

    const batch = await batches.touch(
      {
        chatId: norm.chatId,
        contactId: contact ? contact.id : null,
        quietSeconds: QUIET_SECONDS,
        maxWindowSeconds: MAX_WINDOW_SECONDS,
      },
      client
    );

    return {
      status: 'queued',
      messageId: stored.id,
      chatId: norm.chatId,
      flushAt: batch.flush_at,
      pendingCount: batch.message_count,
    };
  });
}

module.exports = { ingest, isAllowedChat, QUIET_SECONDS, MAX_WINDOW_SECONDS };
