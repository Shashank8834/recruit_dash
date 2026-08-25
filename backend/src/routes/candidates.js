const express = require('express');
const multer = require('multer');

const router = express.Router();
const candidatesRepo = require('../repo/candidates');
const media = require('../services/media');
const cvExtractor = require('../services/cvExtractor');
const { toCsv, filename } = require('../csv');
const notesRepo = require('../repo/notes');
const { notesRouter } = require('./notes');

/**
 * Manually uploaded CVs and hand-entered candidates.
 *
 * Kept apart from /api/applicants, which serves the WhatsApp pipeline. The two
 * never share a table, a route or a screen; they meet only where a job
 * suggestion deliberately draws on both pools, and there every result carries
 * its source.
 */

const MAX_UPLOAD_MB = parseFloat(process.env.CV_UPLOAD_MAX_MB || '15');

// Memory storage: the file is parsed to text and then written to its row in
// the same request, so staging it on the API container's disk would only
// create something to clean up — and a file left there outlives no deploy,
// while the row pointing at it would.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 20 },
});

const EXPORT_COLUMNS = [
  { key: 'external_id', label: 'ID' },
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'current_company', label: 'Current company' },
  { key: 'current_designation', label: 'Current designation' },
  { key: 'location', label: 'Location' },
  { key: 'age', label: 'Age' },
  { key: 'qualifications', label: 'Qualifications' },
  { key: 'experience_years', label: 'Total experience (years)' },
  // Mapped rather than dumped: 'upload' and 'manual' are storage values, and a
  // spreadsheet is read by people who never saw the schema.
  { key: 'entry_mode', label: 'Entered via', map: { upload: 'CV upload', manual: 'By hand' } },
  { key: 'file_name', label: 'Source file' },
  // Requested explicitly: the notes are most of why a spreadsheet gets read a
  // second time, and an export without them is a list of strangers.
  { key: 'notes', label: 'Notes' },
  { key: 'created_at', label: 'Added' },
];

function listFilters(req) {
  return {
    search: req.query.search || null,
    minExperience: req.query.minExperience ? parseFloat(req.query.minExperience) : null,
  };
}

/** Trims and nulls a submitted string; '' from a blank form input is not a value. */
function text(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Upload one or more CVs.
 *
 * Each file is handled independently and reported on individually: a batch of
 * twenty CVs where the fourth is a corrupt scan should store nineteen and tell
 * you which one failed, not reject the upload. Extraction costs a model call
 * per file, so the response also reports what could not be read at all — those
 * cost nothing and are worth re-uploading as a different format.
 */
router.post('/', upload.array('files', 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded. Send them as "files".' });
    }

    const stored = [];
    const failed = [];

    for (const file of files) {
      try {
        const cvText = await media.extractText(file.buffer, file.mimetype, file.originalname);
        if (!cvText || !cvText.trim()) {
          failed.push({
            file: file.originalname,
            error:
              'No readable text — likely a scanned image. Re-save it as a text PDF or DOCX.',
          });
          continue;
        }

        const extracted = await cvExtractor.extract(cvText);
        const candidate = await candidatesRepo.create({
          fileName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
          rawText: cvText,
          // The document itself, not only what we managed to read out of it.
          // Extraction keeps the fields we thought to ask for; the recruiter
          // reading the profile routinely wants the half we did not.
          fileData: file.buffer,
          ...extracted,
          extractionModel: extracted.model,
          extractionVersion: extracted.version,
          extractionNotes: extracted.notes,
          uploadedBy: req.body.uploadedBy || null,
        });
        stored.push(candidate);
      } catch (err) {
        console.error(`[candidates] ${file.originalname}: ${err.message}`);
        failed.push({ file: file.originalname, error: err.message });
      }
    }

    // 207 when the batch was partly successful: a 200 would hide the failures
    // and a 500 would imply nothing was stored.
    res.status(failed.length && stored.length ? 207 : failed.length ? 400 : 201).json({
      stored: stored.length,
      failed: failed.length,
      candidates: stored,
      errors: failed,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * A candidate typed in by hand, with no CV behind them.
 *
 * Its own path rather than a branch inside POST / — that handler is wrapped in
 * multer and reads a multipart body, and a JSON post arrives there with no
 * files and no way to tell "sent nothing" from "meant to send nothing".
 *
 * No extraction runs: the fields were typed, so there is nothing to read and
 * no model call to pay for. A name is the only requirement, because a referral
 * often really is just a name and a number, and rejecting that pushes it into
 * a private spreadsheet the matcher can never see.
 */
router.post('/manual', async (req, res) => {
  try {
    const body = req.body || {};
    const name = text(body.name);
    if (!name) return res.status(400).json({ error: 'A name is required.' });

    const candidate = await candidatesRepo.create({
      entryMode: 'manual',
      rawText: '',
      name,
      email: text(body.email),
      phone: text(body.phone),
      currentCompany: text(body.currentCompany),
      currentDesignation: text(body.currentDesignation),
      location: text(body.location),
      age: numberOrNull(body.age),
      experienceYears: numberOrNull(body.experienceYears),
      qualifications: Array.isArray(body.qualifications)
        ? body.qualifications.map((q) => String(q).trim()).filter(Boolean)
        : [],
      uploadedBy: text(body.uploadedBy),
    });

    // Offered on the same form, so it lands with the candidate rather than
    // needing a second trip to the detail page.
    const firstNote = text(body.note);
    if (firstNote) {
      await notesRepo.add('candidate', candidate.id, {
        body: firstNote,
        author: text(body.uploadedBy),
      });
    }

    res.status(201).json(candidate);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Registered before /:id so the literal path is not read as an id.
router.get('/export.csv', async (req, res) => {
  try {
    const rows = await candidatesRepo.list({
      ...listFilters(req),
      withNotes: true,
      limit: 10000,
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename('candidates')}"`);
    res.send(toCsv(EXPORT_COLUMNS, rows));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const filters = listFilters(req);
    const [rows, total] = await Promise.all([
      candidatesRepo.list({ ...filters, limit: parseInt(req.query.limit || '200', 10) }),
      candidatesRepo.count(filters),
    ]);
    res.json({ total, candidates: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const candidate = await candidatesRepo.findByExternalId(req.params.id);
    if (!candidate) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ ...candidate, notes: await notesRepo.list('candidate', candidate.id) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * The stored CV, to view in the browser or save.
 *
 * `?download=1` forces the save dialog; without it a PDF opens in the built-in
 * viewer, which is the whole point of the request — checking one detail against
 * the source should not mean a trip through the downloads folder.
 *
 * Only PDFs are served inline. Everything else is an attachment regardless of
 * what was asked for, because inline means the browser renders an uploaded file
 * on this app's origin, and a document that turns out to be HTML would then be
 * running as part of the dashboard.
 *
 * nosniff is what makes that restriction hold. The stored mime type came from
 * the uploading client and can claim anything, so the check above is only as
 * good as the browser's willingness to believe the Content-Type it is sent —
 * without nosniff, a file labelled application/pdf whose bytes are HTML gets
 * sniffed and rendered as HTML anyway.
 */
router.get('/:id/file', async (req, res) => {
  try {
    const file = await candidatesRepo.fileFor(req.params.id);
    if (!file) {
      return res.status(404).json({ error: 'No CV file stored for this candidate.' });
    }

    const type = file.mime_type || 'application/octet-stream';
    const viewable = type === 'application/pdf';
    const inline = viewable && req.query.download !== '1';

    // Quoted and stripped of quotes/newlines: the filename comes from whatever
    // the uploader's machine called it, and it is being written into a header.
    const safeName = (file.file_name || 'cv').replace(/["\r\n\\]/g, '_');

    res.setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`
    );
    res.send(file.file_data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const updated = await candidatesRepo.update(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ error: 'Candidate not found' });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const removed = await candidatesRepo.remove(req.params.id);
    if (!removed) return res.status(404).json({ error: 'Candidate not found' });
    res.json({ deleted: req.params.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --------------------------------------------------------------------------
// Notes
// --------------------------------------------------------------------------
// Mounted from the shared router rather than written out here. The handlers
// are the same on every record that carries notes; the only thing specific to
// candidates is how an external id becomes an internal one.
router.use('/:id/notes', notesRouter('candidate', (id) => candidatesRepo.findByExternalId(id)));

// Multer reports an oversized file as an error object, not an exception the
// route can catch — without this the client sees an opaque 500.
router.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than the ${MAX_UPLOAD_MB}MB limit.`
        : err.message;
    return res.status(400).json({ error: message });
  }
  console.error(err);
  res.status(500).json({ error: err.message });
});

module.exports = router;
