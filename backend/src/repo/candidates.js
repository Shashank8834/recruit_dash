const { query } = require('../db');
const notesRepo = require('./notes');

/**
 * Uploaded CVs and hand-entered candidates. Nothing in the WhatsApp pipeline
 * writes here — that side has its own tables, and keeping the two apart is the
 * point of this one.
 */

// file_data and raw_text are deliberately absent: one is the whole document
// and the other is megabytes of bytes, and a list of 200 candidates would
// carry both on every row. `has_file` is the part a list actually needs —
// whether there is something to open.
const FIELDS = `
  c.id, c.external_id, c.file_name, c.file_size, c.mime_type,
  c.name, c.email, c.phone, c.current_company, c.current_designation, c.location,
  c.age, c.qualifications, c.experience_years,
  c.extraction_model, c.extraction_version, c.extraction_notes,
  c.entry_mode, (c.file_data IS NOT NULL) AS has_file,
  c.uploaded_by, c.created_at, c.updated_at`;

// Notes live in one table shared by every record that carries them, so the
// fragments that fold them into a column come from there rather than being
// spelled out again here.
const NOTES_AGGREGATE = `${notesRepo.aggregate('candidate', 'c')} AS notes`;
const NOTE_COUNT = `${notesRepo.countSubquery('candidate', 'c')} AS note_count`;

const WHERE_FILTERS = `
  ($1::text IS NULL OR (
     c.name                ILIKE '%' || $1 || '%' OR
     c.current_company     ILIKE '%' || $1 || '%' OR
     c.current_designation ILIKE '%' || $1 || '%' OR
     c.location            ILIKE '%' || $1 || '%' OR
     c.email               ILIKE '%' || $1 || '%' OR
     c.phone               ILIKE '%' || $1 || '%'
   ))
   AND ($2::numeric IS NULL OR c.experience_years >= $2)`;

async function create(fields, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `INSERT INTO candidates
       (external_id, file_name, file_size, mime_type, raw_text, file_data,
        name, email, phone, current_company, current_designation, location,
        age, qualifications, experience_years,
        extraction_model, extraction_version, extraction_notes,
        entry_mode, uploaded_by)
     VALUES ('pending',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING id`,
    [
      fields.fileName || null,
      fields.fileSize || null,
      fields.mimeType || null,
      fields.rawText || '',
      fields.fileData || null,
      fields.name || null,
      fields.email || null,
      fields.phone || null,
      fields.currentCompany || null,
      fields.currentDesignation || null,
      fields.location || null,
      fields.age || null,
      JSON.stringify(fields.qualifications || []),
      fields.experienceYears === null || fields.experienceYears === undefined
        ? null
        : fields.experienceYears,
      fields.extractionModel || null,
      fields.extractionVersion || null,
      fields.extractionNotes || null,
      fields.entryMode === 'manual' ? 'manual' : 'upload',
      fields.uploadedBy || null,
    ]
  );
  // Derived from the serial id, as JDs are, so the identifier is stable and
  // readable in an exported spreadsheet.
  const { rows: updated } = await run(
    `UPDATE candidates c SET external_id = 'CAND_' || (1000 + c.id) WHERE c.id = $1
      RETURNING ${FIELDS}`,
    [rows[0].id]
  );
  return updated[0];
}

/**
 * @param {object} opts
 * @param {string} [opts.search]  matches name, company, designation, location
 * @param {number} [opts.minExperience]
 * @param {boolean} [opts.withNotes]  fold every note into one column
 */
async function list({ search, minExperience, withNotes = false, limit = 200, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${FIELDS},
            ${withNotes ? NOTES_AGGREGATE : NOTE_COUNT}
       FROM candidates c
      WHERE ${WHERE_FILTERS}
      ORDER BY c.created_at DESC
      LIMIT $3 OFFSET $4`,
    [search || null, minExperience ?? null, limit, offset]
  );
  return rows;
}

async function count({ search, minExperience } = {}) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM candidates c WHERE ${WHERE_FILTERS}`,
    [search || null, minExperience ?? null]
  );
  return rows[0].count;
}

async function findByExternalId(externalId) {
  const { rows } = await query(
    `SELECT ${FIELDS}, c.raw_text FROM candidates c WHERE c.external_id = $1`,
    [externalId]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await query(
    `SELECT ${FIELDS}, c.raw_text FROM candidates c WHERE c.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * The stored document itself.
 *
 * Its own query rather than a column on the reads above: this is the one place
 * that wants the bytes, and every other caller would be paying to carry a 15MB
 * buffer it immediately discards.
 */
async function fileFor(externalId) {
  const { rows } = await query(
    `SELECT file_name, mime_type, file_size, file_data
       FROM candidates WHERE external_id = $1`,
    [externalId]
  );
  const row = rows[0];
  if (!row || !row.file_data) return null;
  return row;
}

/** Corrects a field the extraction got wrong. Recruiters will always need this. */
async function update(externalId, fields) {
  const allowed = {
    name: 'name',
    email: 'email',
    phone: 'phone',
    currentCompany: 'current_company',
    currentDesignation: 'current_designation',
    location: 'location',
    age: 'age',
    experienceYears: 'experience_years',
    qualifications: 'qualifications',
  };

  const sets = [];
  const values = [externalId];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    values.push(key === 'qualifications' ? JSON.stringify(fields[key] || []) : fields[key]);
    sets.push(`${column} = $${values.length}${key === 'qualifications' ? '::jsonb' : ''}`);
  }
  if (sets.length === 0) return findByExternalId(externalId);

  const { rows } = await query(
    `UPDATE candidates c SET ${sets.join(', ')}, updated_at = now()
      WHERE c.external_id = $1
      RETURNING ${FIELDS}`,
    values
  );
  return rows[0] || null;
}

async function remove(externalId) {
  const { rows } = await query(
    'DELETE FROM candidates WHERE external_id = $1 RETURNING id',
    [externalId]
  );
  return rows[0] || null;
}

module.exports = {
  create, list, count, findByExternalId, findById, fileFor, update, remove,
};
