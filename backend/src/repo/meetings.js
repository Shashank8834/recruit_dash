const { query } = require('../db');
const notesRepo = require('./notes');

/**
 * Meetings with a candidate, and where each one got to.
 *
 * The person is either a talent-pool candidate or a WhatsApp contact — the two
 * pools that already meet in job suggestions, joined the same way and labelled
 * the same way, so a row always says which side of the product it came from.
 */

const STATUSES = ['open', 'closed'];

/**
 * The person and the role, resolved from whichever side they came from.
 *
 * Unioned only here at read time, as suggestions are. Neither pool learns about
 * the other, and every row carries the source so nobody has to infer it from a
 * null.
 */
const SELECT = `
  m.id, m.external_id, m.scheduled_at, m.subject, m.status, m.outcome,
  m.closed_at, m.created_by, m.created_at, m.updated_at,
  m.candidate_id, m.contact_id, m.manual_job_id,
  CASE WHEN m.candidate_id IS NOT NULL THEN 'candidate' ELSE 'applicant' END AS person_source,
  COALESCE(c.external_id, 'APP_' || cl.id)              AS person_ref,
  COALESCE(c.name, ct.name, ct.push_name, ct.phone)     AS person_name,
  COALESCE(c.phone, ct.phone)                           AS person_phone,
  COALESCE(c.email, ct.email)                           AS person_email,
  c.current_designation                                 AS person_designation,
  c.current_company                                     AS person_company,
  j.external_id                                         AS job_ref,
  j.title                                               AS job_title,
  ${notesRepo.countSubquery('meeting', 'm')}            AS note_count`;

const FROM = `
  FROM meetings m
  LEFT JOIN candidates c   ON c.id = m.candidate_id
  LEFT JOIN manual_jobs j  ON j.id = m.manual_job_id
  LEFT JOIN contacts ct    ON ct.id = m.contact_id
  -- One classification per contact, so a WhatsApp person resolves to a page
  -- that exists. LATERAL keeps it to one row: a person with three
  -- applications must not turn one meeting into three.
  LEFT JOIN LATERAL (
    SELECT cl2.id
      FROM classifications cl2
      JOIN submissions s2 ON s2.id = cl2.submission_id
     WHERE s2.contact_id = m.contact_id AND cl2.is_current
     ORDER BY cl2.created_at DESC
     LIMIT 1
  ) cl ON m.contact_id IS NOT NULL`;

async function create({
  candidateId, contactId, manualJobId, scheduledAt, subject, createdBy,
}) {
  const { rows } = await query(
    `INSERT INTO meetings
       (external_id, candidate_id, contact_id, manual_job_id, scheduled_at, subject, created_by)
     VALUES ('pending',$1,$2,$3,$4,$5,$6)
     RETURNING id`,
    [candidateId || null, contactId || null, manualJobId || null, scheduledAt, subject, createdBy || null]
  );
  // Derived from the serial id, as candidates and roles are, so the identifier
  // is stable and readable in an exported spreadsheet.
  await query(
    `UPDATE meetings SET external_id = 'MEET_' || (1000 + id) WHERE id = $1`,
    [rows[0].id]
  );
  return findById(rows[0].id);
}

/**
 * @param {object} opts
 * @param {string} [opts.status]     'open' | 'closed'
 * @param {string} [opts.when]       'upcoming' | 'past'
 * @param {number} [opts.candidateId]
 * @param {number} [opts.contactId]
 * @param {number} [opts.manualJobId]
 */
async function list({
  status, when, candidateId, contactId, manualJobId, limit = 200,
} = {}) {
  const { rows } = await query(
    `SELECT ${SELECT}
     ${FROM}
      WHERE ($1::text IS NULL OR m.status = $1)
        AND ($2::text IS NULL
             OR ($2 = 'upcoming' AND m.scheduled_at >= now())
             OR ($2 = 'past'     AND m.scheduled_at <  now()))
        AND ($3::bigint IS NULL OR m.candidate_id  = $3)
        AND ($4::bigint IS NULL OR m.contact_id    = $4)
        AND ($5::bigint IS NULL OR m.manual_job_id = $5)
      -- Open meetings first, then soonest. A worklist answers "what do I still
      -- have to deal with" before "what happened in the past", and sorting by
      -- date alone buries an unclosed meeting from last month under everything
      -- since.
      ORDER BY CASE m.status WHEN 'open' THEN 0 ELSE 1 END,
               m.scheduled_at DESC
      LIMIT $6`,
    [status || null, when || null, candidateId || null, contactId || null,
     manualJobId || null, limit]
  );
  return rows;
}

/** The next few meetings still to happen, for the Overview. */
async function upcoming(limit = 5) {
  const { rows } = await query(
    `SELECT ${SELECT}
     ${FROM}
      WHERE m.status = 'open' AND m.scheduled_at >= now()
      ORDER BY m.scheduled_at
      LIMIT $1`,
    [limit]
  );
  return rows;
}

/** Counts for the Overview: what is booked, what was never closed. */
async function summary() {
  const { rows } = await query(
    `SELECT COUNT(*)::int                                                      AS total,
            COUNT(*) FILTER (WHERE status = 'open')::int                       AS open,
            COUNT(*) FILTER (WHERE status = 'closed')::int                     AS closed,
            COUNT(*) FILTER (WHERE status = 'open' AND scheduled_at >= now())::int AS upcoming,
            -- An open meeting whose date has passed. This is the number that
            -- matters: it is the conversation somebody had and never concluded.
            COUNT(*) FILTER (WHERE status = 'open' AND scheduled_at < now())::int  AS overdue
       FROM meetings`
  );
  return rows[0];
}

async function findByExternalId(externalId) {
  const { rows } = await query(
    `SELECT ${SELECT} ${FROM} WHERE m.external_id = $1`, [externalId]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await query(`SELECT ${SELECT} ${FROM} WHERE m.id = $1`, [id]);
  return rows[0] || null;
}

/**
 * Edits a meeting, including opening and closing it.
 *
 * status and closed_at move together, because the CHECK constraint requires it
 * and because they mean one thing: closing stamps the time, reopening clears
 * it. Leaving that to the caller means every caller has to remember, and the
 * one that forgets writes a row the database rejects.
 */
async function update(externalId, fields) {
  const allowed = {
    subject: 'subject',
    scheduledAt: 'scheduled_at',
    outcome: 'outcome',
    manualJobId: 'manual_job_id',
  };

  const sets = [];
  const values = [externalId];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    values.push(fields[key]);
    sets.push(`${column} = $${values.length}`);
  }

  if (fields.status !== undefined) {
    values.push(fields.status);
    sets.push(`status = $${values.length}`);
    sets.push(
      fields.status === 'closed'
        // Preserved on a re-close so the original conclusion time survives
        // someone reopening a meeting to add a note and closing it again.
        ? 'closed_at = COALESCE(closed_at, now())'
        : 'closed_at = NULL'
    );
  }

  if (sets.length === 0) return findByExternalId(externalId);

  const { rows } = await query(
    `UPDATE meetings SET ${sets.join(', ')}, updated_at = now()
      WHERE external_id = $1 RETURNING id`,
    values
  );
  return rows[0] ? findById(rows[0].id) : null;
}

async function remove(externalId) {
  const { rows } = await query(
    'DELETE FROM meetings WHERE external_id = $1 RETURNING id',
    [externalId]
  );
  return rows[0] || null;
}

module.exports = {
  STATUSES,
  create, list, upcoming, summary, findByExternalId, findById, update, remove,
};
