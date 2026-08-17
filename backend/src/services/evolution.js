/**
 * Normalizes Evolution API webhook payloads into a flat shape the rest of the
 * pipeline understands. This is the only file that knows Evolution's wire
 * format — swapping to Baileys or the WhatsApp Cloud API means rewriting this
 * file and nothing else.
 */

const TEXT_EXTRACTORS = [
  (m) => m.conversation,
  (m) => m.extendedTextMessage && m.extendedTextMessage.text,
  (m) => m.imageMessage && m.imageMessage.caption,
  (m) => m.videoMessage && m.videoMessage.caption,
  (m) => m.documentMessage && m.documentMessage.caption,
  (m) => m.documentWithCaptionMessage &&
         m.documentWithCaptionMessage.message &&
         m.documentWithCaptionMessage.message.documentMessage &&
         m.documentWithCaptionMessage.message.documentMessage.caption,
  (m) => m.buttonsResponseMessage && m.buttonsResponseMessage.selectedDisplayText,
  (m) => m.listResponseMessage && m.listResponseMessage.title,
];

function extractText(message) {
  if (!message) return '';
  for (const fn of TEXT_EXTRACTORS) {
    const value = fn(message);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function extractMedia(message) {
  if (!message) return null;

  const doc =
    message.documentMessage ||
    (message.documentWithCaptionMessage &&
      message.documentWithCaptionMessage.message &&
      message.documentWithCaptionMessage.message.documentMessage);

  if (doc) {
    return {
      type: 'document',
      mime: doc.mimetype || null,
      filename: doc.fileName || null,
      url: doc.url || null,
    };
  }
  if (message.imageMessage) {
    return {
      type: 'image',
      mime: message.imageMessage.mimetype || null,
      filename: null,
      url: message.imageMessage.url || null,
    };
  }
  if (message.audioMessage) {
    return {
      type: 'audio',
      mime: message.audioMessage.mimetype || null,
      filename: null,
      url: message.audioMessage.url || null,
    };
  }
  if (message.videoMessage) {
    return {
      type: 'video',
      mime: message.videoMessage.mimetype || null,
      filename: null,
      url: message.videoMessage.url || null,
    };
  }
  return null;
}

/** Strips the WhatsApp JID suffix down to a bare phone number. */
function phoneFromJid(jid) {
  if (!jid) return null;
  const bare = String(jid).split('@')[0].split(':')[0];
  const digits = bare.replace(/\D/g, '');
  return digits ? `+${digits}` : null;
}

function isGroup(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

/**
 * Evolution spells the event name differently depending on version and on
 * whether byEvents routing is on: "messages.upsert", "MESSAGES_UPSERT",
 * "messages-upsert". Normalize before comparing.
 */
function eventName(payload) {
  const raw = payload.event || payload.type || '';
  return String(raw).toLowerCase().replace(/[-_]/g, '.');
}

/**
 * @returns {null|object} null when the payload is not an inbound message we
 *   should ingest (wrong event, outbound, status broadcast, empty).
 */
function normalize(payload) {
  if (!payload || typeof payload !== 'object') return null;

  const event = eventName(payload);
  if (event && !event.startsWith('messages.upsert')) return null;

  // Evolution sends `data` as an object, or an array when batching.
  const data = Array.isArray(payload.data) ? payload.data[0] : payload.data;
  if (!data || !data.key) return null;

  const key = data.key;
  if (key.fromMe) return null;
  if (key.remoteJid === 'status@broadcast') return null;

  const body = extractText(data.message);
  const media = extractMedia(data.message);
  if (!body && !media) return null;

  const timestamp = Number(data.messageTimestamp || data.messageTimestampMs || 0);
  const sentAt = timestamp
    ? new Date(timestamp > 1e12 ? timestamp : timestamp * 1000)
    : new Date();

  // In a group the chat is the group, but the author is the participant.
  const senderJid = isGroup(key.remoteJid)
    ? key.participant || data.participant || key.remoteJid
    : key.remoteJid;

  return {
    waMessageId: key.id,
    chatId: key.remoteJid,
    senderJid,
    phone: phoneFromJid(senderJid),
    pushName: data.pushName || null,
    body,
    mediaType: media ? media.type : null,
    mediaMime: media ? media.mime : null,
    mediaFilename: media ? media.filename : null,
    mediaUrl: media ? media.url : null,
    sentAt,
    raw: payload,
  };
}

/**
 * Explains why a payload was ignored. Used by the webhook's debug mode — when
 * you're first wiring Evolution up, "ignored" with no reason is the least
 * useful thing the server can tell you.
 */
function describeIgnore(payload) {
  if (!payload || typeof payload !== 'object') return 'body is not a JSON object';

  const event = eventName(payload);
  if (event && !event.startsWith('messages.upsert')) {
    return `event "${payload.event || payload.type}" is not messages.upsert`;
  }

  const data = Array.isArray(payload.data) ? payload.data[0] : payload.data;
  if (!data) return 'payload has no "data" property';
  if (!data.key) return 'data has no "key" property';
  if (data.key.fromMe) return 'message is outbound (fromMe)';
  if (data.key.remoteJid === 'status@broadcast') return 'status broadcast';
  if (!extractText(data.message) && !extractMedia(data.message)) {
    return `no text or media found in message (messageType=${data.messageType || 'unknown'})`;
  }
  return 'unknown';
}

module.exports = { normalize, phoneFromJid, isGroup, extractText, describeIgnore };
