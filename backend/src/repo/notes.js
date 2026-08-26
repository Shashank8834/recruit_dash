const { query } = require('../db');

/**
 * Notes, on any of the four things a recruiter looks at.
 *
 * One repo rather than one per entity. The behaviour is identical everywhere —
 * append, edit, delete, oldest first — and four copies of it would drift the
 * first time one of them gained a field.
 */

/**
 * What a note can be attached to, and the column that attaches it.
 *
 * A lookup, not a column name taken from the caller. These values are
 * concatenated into SQL, and the only thing standing between that and an
 * injection would be where the caller happened to get the string from. A
 * lookup cannot be talked into anything else. Same reasoning as the conflict
 * targets in manualJobs.recordSuggestion.
 */
const TARGETS = {
  candidate: { column: 'candidate_id', label: 'Candidate' },
  role:      { column: 'manual_job_id', label: 'Role' },
  posting:   { column: 'jd_id', label: 'Posting' },
  applicant: { column: 'contact_id', label: 'Applicant' },
  meeting:   { column: 'meeting_id', label: 'Meeting' },
};

function columnFor(target) {
  const entry = TARGETS[target];
  if (!entry) throw new Error(`Unknown note target: ${target}`);
  return entry.column;
}

/** Oldest first: notes are a running account, and it reads forwards. */
async function list(target, id) {
  const { rows } = await query(
    `SELECT id, body, author, created_at, updated_at
       FROM notes WHERE ${columnFor(target)} = $1 ORDER BY created_at`,
    [id]
  );
  return rows;
}

async function add(target, id, { body, author }) {
  const { rows } = await query(
    `INSERT INTO notes (${columnFor(target)}, body, author)
     VALUES ($1,$2,$3)
     RETURNING id, body, author, created_at, updated_at`,
    [id, body, author || null]
  );
  return rows[0];
}

/**
 * Scoped to the owner, not looked up by note id alone. The note id comes from a
 * URL, and without the scope a note could be edited through any record's page —
 * including one whose notes the caller was never shown.
 */
async function update(target, id, noteId, { body }) {
  const { rows } = await query(
    `UPDATE notes SET body = $3, updated_at = now()
      WHERE id = $2 AND ${columnFor(target)} = $1
      RETURNING id, body, author, created_at, updated_at`,
    [id, noteId, body]
  );
  return rows[0] || null;
}

async function remove(target, id, noteId) {
  const { rows } = await query(
    `DELETE FROM notes WHERE id = $2 AND ${columnFor(target)} = $1 RETURNING id`,
    [id, noteId]
  );
  return rows[0] || null;
}

/**
 * A correlated subquery folding a record's notes into one cell, for the CSV
 * exports. `alias` is the table alias the surrounding query gave the owner.
 *
 * Dated and one per line, because a note without its date is a claim with no
 * shelf life — "wants 20% more" reads very differently a year on. The line
 * breaks survive the CSV writer, which quotes any cell containing them.
 */
function aggregate(target, alias, idColumn = 'id') {
  return `(SELECT string_agg(
             to_char(n.created_at, 'YYYY-MM-DD') ||
             CASE WHEN COALESCE(n.author, '') = '' THEN '' ELSE ' ' || n.author END ||
             ': ' || n.body,
             chr(10) ORDER BY n.created_at)
        FROM notes n WHERE n.${columnFor(target)} = ${alias}.${idColumn})`;
}

/** How many notes a record has, for a list column. */
function countSubquery(target, alias, idColumn = 'id') {
  return `(SELECT COUNT(*)::int FROM notes n
            WHERE n.${columnFor(target)} = ${alias}.${idColumn})`;
}

module.exports = { TARGETS, list, add, update, remove, aggregate, countSubquery };
