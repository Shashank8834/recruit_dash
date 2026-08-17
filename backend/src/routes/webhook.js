const express = require('express');
const router = express.Router();
const { ingest } = require('../services/ingest');

/**
 * Optional shared-secret check. Evolution API can be configured to send a
 * custom header with each webhook; set EVOLUTION_WEBHOOK_TOKEN to require it.
 */
function authorize(req, res, next) {
  const expected = process.env.EVOLUTION_WEBHOOK_TOKEN;
  if (!expected) return next();

  const provided =
    req.get('x-webhook-token') ||
    req.get('apikey') ||
    (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

  if (provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}

/**
 * Evolution allows exactly one webhook URL per instance, so during migration
 * you cannot have it deliver to both the old n8n flow and this one. Setting
 * WEBHOOK_FORWARD_URL makes this endpoint relay a verbatim copy onward, which
 * lets both pipelines run on identical live traffic for a comparison period.
 *
 * Fire-and-forget by design: the forward must never delay our response or fail
 * our ingest. If the old stack is down, that is not our problem to surface.
 */
function forwardCopy(body) {
  const target = process.env.WEBHOOK_FORWARD_URL;
  if (!target) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  fetch(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .catch((err) => console.warn(`[webhook] forward to ${target} failed: ${err.message}`))
    .finally(() => clearTimeout(timeout));
}

/**
 * Evolution posts here on every inbound message. Responds immediately — the
 * webhook's only job is to durably record the message and slide the chat's
 * flush deadline. Classification happens in the worker.
 */
router.post('/whatsapp', authorize, async (req, res) => {
  forwardCopy(req.body);
  try {
    const result = await ingest(req.body);
    res.status(200).json(result);
  } catch (err) {
    console.error('[webhook] ingest failed:', err);
    // A 500 tells Evolution to retry, which is what we want — the message is
    // not yet safely stored.
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
