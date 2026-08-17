const { query } = require('../db');

/** Reads go through the applicant_rows view, which already applies overrides. */
async function listBetween({ start, end, result }) {
  const { rows } = await query(
    `SELECT * FROM applicant_rows
      WHERE created_at >= to_timestamp($1)
        AND created_at <= to_timestamp($2)
        AND ($3::text IS NULL OR result = $3)
      ORDER BY created_at DESC`,
    [start, end, result ? result.toUpperCase() : null]
  );
  return rows;
}

async function listForJd(jdId) {
  const { rows } = await query(
    `SELECT * FROM applicant_rows
      WHERE jd_id = $1
      ORDER BY CASE result
                 WHEN 'STRONG' THEN 0
                 WHEN 'PARTIAL' THEN 1
                 WHEN 'WEAK' THEN 2
                 WHEN 'NEEDS_REVIEW' THEN 3
                 WHEN 'NONE' THEN 4
                 ELSE 5
               END,
               created_at DESC`,
    [jdId]
  );
  return rows;
}

async function findByExternalId(externalId) {
  const { rows } = await query(
    'SELECT * FROM applicant_rows WHERE external_id = $1',
    [externalId]
  );
  return rows[0] || null;
}

/** Every verdict recorded for this person, across all their submissions. */
async function allForContact(contactId) {
  const { rows } = await query(
    `SELECT a.*, j.jd_text, j.posted_by AS jd_posted_by, j.status AS jd_status
       FROM applicant_rows a
       LEFT JOIN jds j ON j.id = a.jd_id
      WHERE a.contact_id = $1
      ORDER BY a.created_at DESC`,
    [contactId]
  );
  return rows;
}

async function counts({ start, end }) {
  const { rows } = await query(
    `SELECT result, COUNT(*)::int AS count
       FROM applicant_rows
      WHERE created_at >= to_timestamp($1)
        AND created_at <= to_timestamp($2)
      GROUP BY result`,
    [start, end]
  );
  return rows.reduce((acc, r) => {
    acc[r.result] = r.count;
    return acc;
  }, {});
}

async function removeByExternalId(externalId) {
  // Deleting the submission cascades to its classifications and links; the raw
  // messages stay, because they are the record of what actually arrived.
  const { rows } = await query(
    `DELETE FROM submissions
      WHERE id = (SELECT submission_id FROM applicant_rows WHERE external_id = $1)
      RETURNING id`,
    [externalId]
  );
  return rows[0] || null;
}

module.exports = {
  listBetween,
  listForJd,
  findByExternalId,
  allForContact,
  counts,
  removeByExternalId,
};
