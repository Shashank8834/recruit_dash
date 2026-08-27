const express = require('express');

const router = express.Router();
const meetingsRepo = require('../repo/meetings');
const candidatesRepo = require('../repo/candidates');
const applicantsRepo = require('../repo/applicants');
const manualJobsRepo = require('../repo/manualJobs');
const notesRepo = require('../repo/notes');
const { toCsv, filename } = require('../csv');
const { notesRouter } = require('./notes');

/**
 * Meetings, and the running account of how each one went.
 *
 * The person is tagged from either pool: a talent-pool candidate by their
 * CAND_ id, or a WhatsApp applicant by their APP_ id. The route resolves
 * whichever was given into the right column, so a caller never has to know
 * that the two live in different tables.
 */

const EXPORT_COLUMNS = [
  { key: 'external_id', label: 'ID' },
  { key: 'scheduled_at', label: 'When' },
  { key: 'person_name', label: 'Person' },
  // Which meeting with that person this was. In a spreadsheet sorted by name
  // this is what tells a first round from a fourth without reading the dates.
  { key: 'person_meeting_number', label: 'Meeting no.' },
  { key: 'person_meeting_total', label: 'Meetings with them' },
  { key: 'person_ref', label: 'Person ID' },
  { key: 'person_source', label: 'From',
    map: { candidate: 'Talent pool', applicant: 'WhatsApp' } },
  { key: 'person_phone', label: 'Phone' },
  { key: 'person_email', label: 'Email' },
  { key: 'job_title', label: 'Role' },
  { key: 'subject', label: 'About' },
  { key: 'created_at', label: 'Created' },
];

function text(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Reads a submitted date-time.
 *
 * Rejected rather than defaulted when unparseable: a meeting whose date
 * silently became "now" is worse than one that failed to save, because it
 * looks booked and is in the wrong place in the list.
 */
function when(value) {
  const raw = text(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Turns whichever person id was given into the column it belongs in.
 *
 * A CAND_ id is a talent-pool candidate; an APP_ id is a WhatsApp applicant,
 * whose meetings hang off the CONTACT rather than the classification — the
 * same anchoring as notes, and for the same reason: you meet a person, not a
 * verdict, and the record must still be there the next time they apply to
 * something else.
 */
async function resolvePerson(body) {
  const ref = text(body.personRef);
  if (!ref) return { error: 'Tag who the meeting is with.' };

  if (ref.startsWith('CAND_')) {
    const candidate = await candidatesRepo.findByExternalId(ref);
    if (!candidate) return { error: `No candidate ${ref}.` };
    return { candidateId: candidate.id };
  }

  if (ref.startsWith('APP_')) {
    const applicant = await applicantsRepo.findByExternalId(ref);
    if (!applicant) return { error: `No applicant ${ref}.` };
    if (!applicant.contact_id) {
      return { error: `${ref} has no contact details to attach a meeting to.` };
    }
    return { contactId: applicant.contact_id };
  }

  return { error: `${ref} is not a candidate (CAND_…) or applicant (APP_…) id.` };
}

async function resolveJob(body) {
  const ref = text(body.jobRef);
  if (!ref) return { manualJobId: null };
  const job = await manualJobsRepo.findByExternalId(ref);
  if (!job) return { error: `No role ${ref}.` };
  return { manualJobId: job.id };
}

function listFilters(req) {
  return {
    // Free text, matched against the person's name, email and phone as well as
    // the subject and the meeting id. Trimmed here so a box left holding a
    // space does not filter everything out.
    search: text(req.query.search),
    // The window, as instants rather than dates.
    //
    // The browser sends them, because only the browser knows what "last week"
    // means where the user is sitting. Computing the boundary here would use
    // the container's clock — which is UTC unless TZ says otherwise — and a
    // meeting at 09:00 IST on Monday would fall into the previous week for
    // anyone asking from India.
    //
    // Unparseable values are dropped rather than defaulted: a filter that
    // silently became "all time" looks like an empty week rather than a
    // broken input.
    from: when(req.query.from),
    to: when(req.query.to),
  };
}

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};

    const subject = text(body.subject);
    if (!subject) return res.status(400).json({ error: 'Say what the meeting is about.' });

    const scheduledAt = when(body.scheduledAt);
    if (!scheduledAt) {
      return res.status(400).json({ error: 'A valid date and time is required.' });
    }

    const person = await resolvePerson(body);
    if (person.error) return res.status(400).json({ error: person.error });

    const job = await resolveJob(body);
    if (job.error) return res.status(400).json({ error: job.error });

    res.status(201).json(
      await meetingsRepo.create({
        ...person,
        manualJobId: job.manualJobId,
        scheduledAt,
        subject,
        createdBy: text(body.createdBy),
      })
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Registered before /:id so the literal paths are not read as ids.
router.get('/export.csv', async (req, res) => {
  try {
    const rows = await meetingsRepo.list({ ...listFilters(req), limit: 10000 });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename('meetings')}"`);
    res.send(toCsv(EXPORT_COLUMNS, rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * What has already happened with one person, for the booking form.
 *
 * A second, third and fourth meeting with the same person is the normal shape
 * of a placement — first round, client round, offer conversation — so the form
 * has to make that easy AND has to say what came before it. Booking a "first
 * round" with somebody who was already screened twice is the mistake this
 * exists to prevent, and the only moment it can be prevented is while the form
 * is open.
 *
 * Registered above /:id so 'history' is not read as a meeting id.
 */
router.get('/history', async (req, res) => {
  try {
    const person = await resolvePerson({ personRef: req.query.personRef });
    if (person.error) return res.status(400).json({ error: person.error });
    res.json(await meetingsRepo.personHistory(person));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/summary', async (_req, res) => {
  try {
    res.json(await meetingsRepo.summary());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    res.json(await meetingsRepo.list(listFilters(req)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const meeting = await meetingsRepo.findByExternalId(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    res.json({ ...meeting, notes: await notesRepo.list('meeting', meeting.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** Edits a meeting: what it is about, when it is, and which role it is for. */
router.patch('/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const fields = {};

    if (body.subject !== undefined) {
      const subject = text(body.subject);
      if (!subject) return res.status(400).json({ error: 'A meeting needs a subject.' });
      fields.subject = subject;
    }

    if (body.scheduledAt !== undefined) {
      const scheduledAt = when(body.scheduledAt);
      if (!scheduledAt) {
        return res.status(400).json({ error: 'A valid date and time is required.' });
      }
      fields.scheduledAt = scheduledAt;
    }

    if (body.jobRef !== undefined) {
      const job = await resolveJob(body);
      if (job.error) return res.status(400).json({ error: job.error });
      fields.manualJobId = job.manualJobId;
    }

    const updated = await meetingsRepo.update(req.params.id, fields);
    if (!updated) return res.status(404).json({ error: 'Meeting not found' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const removed = await meetingsRepo.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Meeting not found' });
    res.json({ deleted: req.params.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// The timeline. A meeting's own fields say when it is and how it ended; these
// are what happened in between.
router.use('/:id/notes', notesRouter('meeting', (id) => meetingsRepo.findByExternalId(id)));

module.exports = router;
