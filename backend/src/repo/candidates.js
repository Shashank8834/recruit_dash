const { query } = require('../db');

/**
 * Uploaded CVs. Nothing in the WhatsApp pipeline writes here — that side has
 * its own tables, and keeping the two apart is the point of this one.
 */

const FIELDS = `
  id, external_id, file_name, file_size, mime_type,
  name, email, phone, current_company, current_designation, location,
  age, qualifications, experience_years,
  extraction_model, extraction_version, extraction_notes,
  uploaded_by, created_at, updated_at`;

async function create(fields, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `INSERT INTO candidates
       (external_id, file_name, file_size, mime_type, raw_text,
        name, email, phone, current_company, current_designation, location,
        age, qualifications, experience_years,
        extraction_model, extraction_version, extraction_notes, uploaded_by)
     VALUES ('pending',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      fields.fileName || null,
      fields.fileSize || null,
      fields.mimeType || null,
      fields.rawText,
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
      fields.uploadedBy || null,
    ]
  );
  // Derived from the serial id, as JDs are, so the identifier is stable and
  // readable in an exported spreadsheet.
  const { rows: updated } = await run(
    `UPDATE candidates SET external_id = 'CAND_' || (1000 + id) WHERE id = $1 RETURNING *`,
    [rows[0].id]
  );
  return updated[0];
}

/**
 * @param {object} opts
 * @param {string} [opts.search]  matches name, company, designation, location
 * @param {number} [opts.minExperience]
 */
async function list({ search, minExperience, limit = 200, offset = 0 } = {}) {
  const { rows } = await query(
    `SELECT ${FIELDS}
       FROM candidates
      WHERE ($1::text IS NULL OR (
              name                ILIKE '%' || $1 || '%' OR
              current_company     ILIKE '%' || $1 || '%' OR
              current_designation ILIKE '%' || $1 || '%' OR
              location            ILIKE '%' || $1 || '%' OR
              email               ILIKE '%' || $1 || '%' OR
              phone               ILIKE '%' || $1 || '%'
            ))
        AND ($2::numeric IS NULL OR experience_years >= $2)
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
    [search || null, minExperience ?? null, limit, offset]
  );
  return rows;
}

async function count({ search, minExperience } = {}) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count
       FROM candidates
      WHERE ($1::text IS NULL OR (
              name                ILIKE '%' || $1 || '%' OR
              current_company     ILIKE '%' || $1 || '%' OR
              current_designation ILIKE '%' || $1 || '%' OR
              location            ILIKE '%' || $1 || '%' OR
              email               ILIKE '%' || $1 || '%' OR
              phone               ILIKE '%' || $1 || '%'
            ))
        AND ($2::numeric IS NULL OR experience_years >= $2)`,
    [search || null, minExperience ?? null]
  );
  return rows[0].count;
}

async function findByExternalId(externalId) {
  const { rows } = await query(
    `SELECT ${FIELDS}, raw_text FROM candidates WHERE external_id = $1`,
    [externalId]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await query(`SELECT ${FIELDS}, raw_text FROM candidates WHERE id = $1`, [id]);
  return rows[0] || null;
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
    `UPDATE candidates SET ${sets.join(', ')}, updated_at = now()
      WHERE external_id = $1
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

module.exports = { create, list, count, findByExternalId, findById, update, remove };
