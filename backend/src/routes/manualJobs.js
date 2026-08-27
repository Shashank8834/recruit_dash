const express = require('express');

const router = express.Router();
const manualJobsRepo = require('../repo/manualJobs');
const talentMatch = require('../services/talentMatch');
const { toCsv, filename } = require('../csv');
const notesRepo = require('../repo/notes');
const meetingsRepo = require('../repo/meetings');
const { notesRouter } = require('./notes');
const jdDocument = require('../services/jdDocument');

/**
 * Roles a recruiter writes by hand, and the candidate suggestions for them.
 *
 * Separate from /api/jds, which serves job descriptions the WhatsApp pipeline
 * parsed out of messages. The two never share a table or a screen. They meet
 * only in the suggestion flow, which by request draws on both candidate pools
 * — and every suggestion records which pool it came from.
 */

const SUGGEST_COLUMNS = [
  { key: 'candidate_ref', label: 'ID' },
  { key: 'source', label: 'Source' },
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'current_company', label: 'Current company' },
  { key: 'current_designation', label: 'Current designation' },
  { key: 'location', label: 'Location' },
  { key: 'experience_years', label: 'Total experience (years)' },
  { key: 'verdict', label: 'Match' },
  { key: 'confidence', label: 'Confidence' },
  { key: 'reason', label: 'Reason' },
  // The CANDIDATE's notes, not the role's. This sheet is a list of people to
  // work through, and what someone recorded about them is the part a
  // spreadsheet cannot reconstruct.
  { key: 'notes', label: 'Candidate notes' },
];

/** The stages a role can sit at, so the UI does not hard-code its own copy. */
router.get('/stages', (_req, res) => res.json(manualJobsRepo.STAGES));

router.post('/', async (req, res) => {
  try {
    const { title } = req.body || {};
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'A title is required.' });
    }
    const job = await manualJobsRepo.create(req.body);
    res.status(201).json(job);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    res.json(await manualJobsRepo.list({ status: req.query.status }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const job = await manualJobsRepo.findByExternalId(req.params.id);
    if (!job) return res.status(404).json({ error: 'Role not found' });
    const [suggestions, notes, meetings] = await Promise.all([
      manualJobsRepo.suggestionsFor(job.id),
      notesRepo.list('role', job.id),
      meetingsRepo.list({ manualJobId: job.id }),
    ]);
    res.json({ ...job, suggestions, notes, meetings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    // Checked here so a bad stage is a 400 saying which values are allowed,
    // rather than the CHECK constraint surfacing as an opaque 500.
    const { status } = req.body || {};
    if (status !== undefined && !manualJobsRepo.STAGES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of ${manualJobsRepo.STAGES.join(', ')}`,
      });
    }
    const updated = await manualJobsRepo.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Role not found' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const removed = await manualJobsRepo.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Role not found' });
    res.json({ deleted: req.params.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Finds and scores candidates for this role.
 *
 * Synchronous on purpose. It is one model call after a SQL shortlist, so it
 * returns in seconds — and a recruiter who clicks "suggest" wants the list,
 * not a job id to poll. If the shortlist ever grows past what one call can
 * hold, this is the handler that should become a queued job.
 */
router.post('/:id/suggest', async (req, res) => {
  try {
    const job = await manualJobsRepo.findByExternalId(req.params.id);
    if (!job) return res.status(404).json({ error: 'Role not found' });

    // Both pools by default. `?pool=manual` restricts to uploaded CVs, for
    // when someone wants to search only what they curated themselves.
    const includeWhatsapp = req.query.pool !== 'manual';
    const candidates = await talentMatch.shortlist(job, {
      limit: parseInt(req.query.limit || String(talentMatch.SHORTLIST_SIZE), 10),
      includeWhatsapp,
    });

    if (candidates.length === 0) {
      return res.json({
        job: job.external_id,
        considered: 0,
        suggestions: [],
        note: 'No candidates matched on keywords. Upload CVs, or broaden the requirements.',
      });
    }

    const scored = await talentMatch.score(job, candidates);

    // Recorded one at a time, tolerating individual failures. The model call is
    // already paid for by this point, so letting one unwritable row abort the
    // loop would throw away every other verdict in the batch and charge for the
    // whole thing again on retry.
    let recorded = 0;
    const writeErrors = [];
    for (const result of scored) {
      try {
        await manualJobsRepo.recordSuggestion({
          manualJobId: job.id,
          source: result.source,
          candidateId: result.candidateId,
          submissionId: result.submissionId,
          verdict: result.verdict,
          confidence: result.confidence,
          reason: result.reason,
          evidence: [],
          model: result.model,
          promptVersion: talentMatch.PROMPT_VERSION,
        });
        recorded += 1;
      } catch (err) {
        console.error(`[roles] could not record ${result.key}: ${err.message}`);
        writeErrors.push({ candidate: result.key, error: err.message });
      }
    }

    res.json({
      job: job.external_id,
      considered: candidates.length,
      recorded,
      // Surfaced rather than logged only: a suggestion list that is quietly
      // short looks complete, and nobody goes looking for the missing rows.
      ...(writeErrors.length ? { errors: writeErrors } : {}),
      suggestions: await manualJobsRepo.suggestionsFor(job.id),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Notes on the role — what was agreed with the client, why the brief changed.
// Mounted from the shared router; only the id lookup is specific to roles.
router.use('/:id/notes', notesRouter('role', (id) => manualJobsRepo.findByExternalId(id)));

/**
 * The role as a document, to send on.
 *
 * Separate from export.csv, which is the list of candidates matched to it. This
 * is the role itself — the thing a client or a candidate is sent, and the
 * version the matcher actually scored against, so what people receive cannot
 * drift from what the tool ranked on.
 */
router.get('/:id/jd.txt', async (req, res) => {
  try {
    const job = await manualJobsRepo.findByExternalId(req.params.id);
    if (!job) return res.status(404).json({ error: 'Role not found' });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${jdDocument.fileNameFor(job.title, job.external_id)}"`
    );
    res.send(jdDocument.forRole(job));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/export.csv', async (req, res) => {
  try {
    const job = await manualJobsRepo.findByExternalId(req.params.id);
    if (!job) return res.status(404).json({ error: 'Role not found' });

    const rows = await manualJobsRepo.suggestionsFor(job.id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename(`matches-${job.external_id}`)}"`
    );
    res.send(toCsv(SUGGEST_COLUMNS, rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
