const { query } = require('../db');

async function create({ submissionId, title, postedBy, jdText, requirements, postedAt }, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `INSERT INTO jds (external_id, submission_id, title, posted_by, jd_text, requirements, posted_at)
     VALUES ('pending', $1, $2, $3, $4, $5, COALESCE($6, now()))
     RETURNING *`,
    [
      submissionId || null,
      title || null,
      postedBy || null,
      jdText,
      JSON.stringify(requirements || []),
      postedAt || null,
    ]
  );
  // external_id is derived from the serial id so it stays stable and readable
  // in the mirrored sheet (JD_1001, JD_1002, ...).
  const { rows: updated } = await run(
    `UPDATE jds SET external_id = 'JD_' || (1000 + id) WHERE id = $1 RETURNING *`,
    [rows[0].id]
  );
  return updated[0];
}

/** Open JDs, most recent first — the candidate set the matcher scores against. */
async function listOpen(limit = 40) {
  const { rows } = await query(
    `SELECT * FROM jds WHERE status = 'open' ORDER BY posted_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function listBetween({ start, end, status }) {
  const { rows } = await query(
    `SELECT j.*,
            COUNT(c.id) FILTER (WHERE c.is_current) AS candidate_count
       FROM jds j
       LEFT JOIN classifications c ON c.jd_id = j.id AND c.is_current
      WHERE j.posted_at >= to_timestamp($1)
        AND j.posted_at <= to_timestamp($2)
        AND ($3::text IS NULL OR j.status = $3)
      GROUP BY j.id
      ORDER BY j.posted_at DESC`,
    [start, end, status || null]
  );
  return rows;
}

async function findByExternalId(externalId) {
  const { rows } = await query('SELECT * FROM jds WHERE external_id = $1', [externalId]);
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await query('SELECT * FROM jds WHERE id = $1', [id]);
  return rows[0] || null;
}

async function remove(externalId) {
  const { rows } = await query(
    'DELETE FROM jds WHERE external_id = $1 RETURNING id',
    [externalId]
  );
  return rows[0] || null;
}

async function setStatus(externalId, status) {
  const { rows } = await query(
    'UPDATE jds SET status = $2 WHERE external_id = $1 RETURNING *',
    [externalId, status]
  );
  return rows[0] || null;
}

module.exports = {
  create,
  listOpen,
  listBetween,
  findByExternalId,
  findById,
  remove,
  setStatus,
};
