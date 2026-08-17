const express = require('express');
const router = express.Router();
const classifications = require('../repo/classifications');
const messages = require('../repo/messages');
const applicants = require('../repo/applicants');
const sheetMirror = require('../services/sheetMirror');
const { reclassify } = require('../services/pipeline');

const VALID_VERDICTS = ['STRONG', 'PARTIAL', 'WEAK', 'NONE', 'UNKNOWN'];

/** Everything the model wasn't confident enough to decide. */
router.get('/queue', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const [items, count] = await Promise.all([
      classifications.reviewQueue({ limit }),
      classifications.reviewQueueCount(),
    ]);
    res.json({ count, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/count', async (_req, res) => {
  try {
    res.json({ count: await classifications.reviewQueueCount() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** The chained messages behind one verdict, plus the full verdict history. */
router.get('/submissions/:id', async (req, res) => {
  try {
    const submissionId = parseInt(req.params.id, 10);
    const [thread, history] = await Promise.all([
      messages.forSubmission(submissionId),
      classifications.history(submissionId),
    ]);
    res.json({
      submissionId,
      messages: thread.map((m) => ({
        id: m.id,
        body: m.body,
        mediaType: m.media_type,
        mediaFilename: m.media_filename,
        sentAt: Math.floor(new Date(m.sent_at).getTime() / 1000),
      })),
      history,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** A human decision. Stored alongside the model verdict, never over it. */
router.post('/classifications/:id/override', async (req, res) => {
  try {
    const { verdict, reviewer, note } = req.body || {};
    if (!VALID_VERDICTS.includes(verdict)) {
      return res.status(400).json({
        error: `verdict must be one of ${VALID_VERDICTS.join(', ')}`,
      });
    }
    const classificationId = parseInt(req.params.id, 10);
    const existing = await classifications.findById(classificationId);
    if (!existing) return res.status(404).json({ error: 'Classification not found' });

    const override = await classifications.override({
      classificationId,
      verdict,
      reviewer,
      note,
    });
    await sheetMirror.enqueue('applicant', classificationId, 'upsert');
    res.json(override);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/classifications/:id/override', async (req, res) => {
  try {
    const classificationId = parseInt(req.params.id, 10);
    await classifications.clearOverride(classificationId);
    await sheetMirror.enqueue('applicant', classificationId, 'upsert');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** Re-run the current prompts over one submission. */
router.post('/submissions/:id/reclassify', async (req, res) => {
  try {
    const result = await reclassify(parseInt(req.params.id, 10));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
