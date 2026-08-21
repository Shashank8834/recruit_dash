const express = require('express');
const multer = require('multer');

const router = express.Router();
const candidatesRepo = require('../repo/candidates');
const media = require('../services/media');
const cvExtractor = require('../services/cvExtractor');
const { toCsv, filename } = require('../csv');

/**
 * Manually uploaded CVs.
 *
 * Kept apart from /api/applicants, which serves the WhatsApp pipeline. The two
 * never share a table, a route or a screen; they meet only where a job
 * suggestion deliberately draws on both pools, and there every result carries
 * its source.
 */

const MAX_UPLOAD_MB = parseFloat(process.env.CV_UPLOAD_MAX_MB || '15');

// Memory storage: the file is parsed to text immediately and the text is what
// gets stored, so writing the upload to disk would only create something to
// clean up — and a directory of CVs is a liability of its own.
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
  { key: 'file_name', label: 'Source file' },
  { key: 'created_at', label: 'Uploaded' },
];

function listFilters(req) {
  return {
    search: req.query.search || null,
    minExperience: req.query.minExperience ? parseFloat(req.query.minExperience) : null,
  };
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
        const text = await media.extractText(file.buffer, file.mimetype, file.originalname);
        if (!text || !text.trim()) {
          failed.push({
            file: file.originalname,
            error:
              'No readable text — likely a scanned image. Re-save it as a text PDF or DOCX.',
          });
          continue;
        }

        const extracted = await cvExtractor.extract(text);
        const candidate = await candidatesRepo.create({
          fileName: file.originalname,
          fileSize: file.size,
          mimeType: file.mimetype,
          rawText: text,
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

// Registered before /:id so the literal path is not read as an id.
router.get('/export.csv', async (req, res) => {
  try {
    const rows = await candidatesRepo.list({ ...listFilters(req), limit: 10000 });
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
    res.json(candidate);
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
