const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const messagesRepo = require('../repo/messages');

/**
 * Resume attachments.
 *
 * Evolution delivers webhooks with webhookBase64=false, so the payload carries
 * only metadata — the bytes have to be fetched back by message id. Without
 * this, a candidate who sends "here's my CV" plus a PDF reaches the classifier
 * as "[document: resume.pdf]" with no content, and correctly ends up in the
 * review queue. Extracting the text is what makes those applications gradeable.
 *
 * This runs in the worker, not the webhook: the debounce window gives us
 * ~60 seconds of slack, and the webhook must stay fast.
 */

const MAX_BYTES = parseFloat(process.env.MEDIA_MAX_MB || '15') * 1024 * 1024;
const MAX_CHARS = parseInt(process.env.MEDIA_MAX_CHARS || '20000', 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.MEDIA_TIMEOUT_MS || '30000', 10);

function isConfigured() {
  return Boolean(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.EVOLUTION_INSTANCE);
}

/** Extensions we can read, when the mimetype is missing or generic. */
const EXT_KIND = { pdf: 'pdf', docx: 'docx', doc: 'docx', txt: 'text', md: 'text', rtf: 'text' };

function kindFor(mime, filename) {
  const m = (mime || '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('wordprocessingml') || m.includes('msword')) return 'docx';
  if (m.startsWith('text/')) return 'text';

  const ext = (filename || '').split('.').pop().toLowerCase();
  return EXT_KIND[ext] || null;
}

async function fetchBase64(waMessageId) {
  const base = process.env.EVOLUTION_API_URL.replace(/\/+$/, '');
  const url = `${base}/chat/getBase64FromMediaMessage/${process.env.EVOLUTION_INSTANCE}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.EVOLUTION_API_KEY,
      },
      body: JSON.stringify({
        message: { key: { id: waMessageId } },
        convertToMp4: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Evolution returned ${response.status} ${await response.text().catch(() => '')}`.trim());
    }
    const data = await response.json();
    if (!data || !data.base64) throw new Error('response contained no base64 payload');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalize(text) {
  if (!text) return null;
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_CHARS
    ? `${cleaned.slice(0, MAX_CHARS)}\n\n[truncated at ${MAX_CHARS} characters]`
    : cleaned;
}

/** @returns {Promise<string|null>} extracted text, or null if unreadable. */
async function extractText(buffer, mime, filename) {
  const kind = kindFor(mime, filename);
  if (!kind) return null;

  if (kind === 'pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return normalize(result && result.text);
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return normalize(result && result.value);
  }

  return normalize(buffer.toString('utf8'));
}

/**
 * Fills in media_text for any message in the batch that carries a readable
 * attachment. Mutates the given rows so the caller's combined text picks the
 * content up immediately.
 *
 * A failure here never fails the batch: an unreadable resume should degrade to
 * "no text extracted", which routes the candidate to human review — not lose
 * the message entirely.
 */
async function hydrate(messages) {
  if (!isConfigured()) return messages;

  for (const message of messages) {
    if (!message.media_type || message.media_text) continue;
    if (kindFor(message.media_mime, message.media_filename) === null) continue;

    try {
      const media = await fetchBase64(message.wa_message_id);
      const buffer = Buffer.from(media.base64, 'base64');

      if (buffer.length > MAX_BYTES) {
        console.warn(
          `[media] ${message.wa_message_id} is ${(buffer.length / 1048576).toFixed(1)}MB, over the ${MAX_BYTES / 1048576}MB limit — skipping`
        );
        continue;
      }

      const text = await extractText(
        buffer,
        media.mimetype || message.media_mime,
        media.fileName || message.media_filename
      );

      if (!text) {
        console.warn(`[media] no text extracted from ${message.media_filename || message.media_type}`);
        continue;
      }

      await messagesRepo.setMediaText(message.id, text);
      message.media_text = text;
      console.log(`[media] extracted ${text.length} chars from ${media.fileName || message.media_type}`);
    } catch (err) {
      console.warn(`[media] extraction failed for ${message.wa_message_id}: ${err.message}`);
    }
  }
  return messages;
}

module.exports = { hydrate, extractText, kindFor, isConfigured, fetchBase64 };
