const express = require('express');
const router = express.Router();
const notesRepo = require('../repo/notes');
const meetingsRepo = require('../repo/meetings');
const { notesRouter } = require('./notes');
const applicantsRepo = require('../repo/applicants');
const messagesRepo = require('../repo/messages');
const classificationsRepo = require('../repo/classifications');
const sheetMirror = require('../services/sheetMirror');
const serialize = require('../serializers');
const { dateRange } = require('../dateRange');



router.get('/', async (req, res) => {
  try {
    const { start, end } = dateRange(req);
    const rows = await applicantsRepo.listBetween({
      start,
      end,
      result: req.query.result,
    });
    res.json(rows.map(serialize.applicant));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const row = await applicantsRepo.findByExternalId(req.params.id);
    if (!row) return res.status(404).json({ error: 'Applicant not found' });

    // The message thread is the point of chaining — show what actually arrived,
    // in order, rather than only the joined block the classifier saw.
    const [thread, history, allMatches, notes, meetings] = await Promise.all([
      messagesRepo.forSubmission(row.submission_id),
      classificationsRepo.history(row.submission_id),
      row.contact_id ? applicantsRepo.allForContact(row.contact_id) : [],
      // Notes hang off the person, not this verdict, so they show on every
      // application the same person makes.
      row.contact_id ? notesRepo.list('applicant', row.contact_id) : [],
      row.contact_id ? meetingsRepo.list({ contactId: row.contact_id }) : [],
    ]);

    res.json({
      ...serialize.applicant(row),
      notes,
      meetings,
      matches: allMatches.filter((m) => m.jd_id).map(serialize.match),
      thread: thread.map((m) => ({
        id: m.id,
        body: m.body,
        mediaType: m.media_type,
        mediaFilename: m.media_filename,
        sentAt: serialize.unix(m.sent_at),
      })),
      history: history.map((h) => ({
        id: h.id,
        verdict: h.verdict,
        confidence: h.confidence === null ? null : Number(h.confidence),
        reason: h.reason,
        model: h.model,
        promptVersion: h.prompt_version,
        isCurrent: h.is_current,
        overrideVerdict: h.override_verdict || null,
        reviewer: h.reviewer || null,
        note: h.note || null,
        createdAt: serialize.unix(h.created_at),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await applicantsRepo.removeByExternalId(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Applicant not found' });
    await sheetMirror.enqueue('applicant', deleted.id, 'delete');
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Notes on an applicant.
 *
 * Attached to the CONTACT the id resolves to, not to the classification named
 * in the URL. A classification is one verdict against one posting; "called,
 * not interested" is about the person, and anchored to the verdict it would be
 * invisible the next time they applied to something else.
 *
 * A row with no contact — the pipeline could not identify a sender — has
 * nothing to hang a note on, and 404s rather than silently dropping it.
 */
router.use('/:id/notes', notesRouter('applicant', async (id) => {
  const row = await applicantsRepo.findByExternalId(id);
  return row && row.contact_id ? { id: row.contact_id } : null;
}));

module.exports = router;
