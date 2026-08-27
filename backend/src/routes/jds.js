const express = require('express');
const router = express.Router();
const notesRepo = require('../repo/notes');
const { notesRouter } = require('./notes');
const jdDocument = require('../services/jdDocument');
const jdsRepo = require('../repo/jds');
const applicantsRepo = require('../repo/applicants');
const sheetMirror = require('../services/sheetMirror');
const serialize = require('../serializers');
const { dateRange } = require('../dateRange');



router.get('/', async (req, res) => {
  try {
    const { start, end } = dateRange(req);
    const rows = await jdsRepo.listBetween({ start, end, status: req.query.status });
    res.json(rows.map(serialize.jd));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const jd = await jdsRepo.findByExternalId(req.params.id);
    if (!jd) return res.status(404).json({ error: 'JD not found' });

    const [matched, notes] = await Promise.all([
      applicantsRepo.listForJd(jd.id),
      notesRepo.list('posting', jd.id),
    ]);
    res.json({ ...serialize.jd(jd), applicants: matched.map(serialize.applicant), notes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['open', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'status must be "open" or "closed"' });
    }
    const updated = await jdsRepo.setStatus(req.params.id, status);
    if (!updated) return res.status(404).json({ error: 'JD not found' });
    await sheetMirror.enqueue('jd', updated.id, 'upsert');
    res.json(serialize.jd(updated));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await jdsRepo.remove(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'JD not found' });
    await sheetMirror.enqueue('jd', deleted.id, 'delete');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** The posting as a document, including the message it was parsed from. */
router.get('/:id/jd.txt', async (req, res) => {
  try {
    const jd = await jdsRepo.findByExternalId(req.params.id);
    if (!jd) return res.status(404).json({ error: 'JD not found' });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${jdDocument.fileNameFor(jd.title, jd.external_id)}"`
    );
    res.send(jdDocument.forPosting(jd));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Notes on a posting — what the poster clarified when asked, whether it is
// still live. Mounted from the shared router; only the id lookup differs.
router.use('/:id/notes', notesRouter('posting', (id) => jdsRepo.findByExternalId(id)));

module.exports = router;
