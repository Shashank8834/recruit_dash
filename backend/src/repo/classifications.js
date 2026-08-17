const { query } = require('../db');

/**
 * Records a verdict. The previous verdict for the same (submission, jd) is
 * demoted rather than deleted, so re-running the classifier over old data
 * leaves a full history you can diff.
 */
async function record(
  { submissionId, jdId, verdict, confidence, reason, evidence, model, promptVersion },
  client
) {
  const run = client ? client.query.bind(client) : query;

  await run(
    `UPDATE classifications
        SET is_current = false
      WHERE submission_id = $1
        AND COALESCE(jd_id, 0) = COALESCE($2::bigint, 0)
        AND is_current`,
    [submissionId, jdId || null]
  );

  const { rows } = await run(
    `INSERT INTO classifications
       (submission_id, jd_id, verdict, confidence, reason, evidence, model, prompt_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      submissionId,
      jdId || null,
      verdict,
      confidence,
      reason,
      JSON.stringify(evidence || []),
      model,
      promptVersion,
    ]
  );
  return rows[0];
}

/**
 * Retires every live verdict for a submission. Used when a later submission
 * turns out to be a continuation of this one — the combined submission carries
 * the verdict, and this one stops appearing as a separate candidate.
 */
async function supersede(submissionId, client) {
  const run = client ? client.query.bind(client) : query;
  await run(
    `UPDATE classifications SET is_current = false
      WHERE submission_id = $1 AND is_current`,
    [submissionId]
  );
}

async function history(submissionId) {
  const { rows } = await query(
    `SELECT c.*, h.verdict AS override_verdict, h.reviewer, h.note
       FROM classifications c
       LEFT JOIN human_overrides h ON h.classification_id = c.id
      WHERE c.submission_id = $1
      ORDER BY c.created_at DESC`,
    [submissionId]
  );
  return rows;
}

async function override({ classificationId, verdict, reviewer, note }) {
  const { rows } = await query(
    `INSERT INTO human_overrides (classification_id, verdict, reviewer, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (classification_id) DO UPDATE
       SET verdict = EXCLUDED.verdict,
           reviewer = EXCLUDED.reviewer,
           note = EXCLUDED.note,
           created_at = now()
     RETURNING *`,
    [classificationId, verdict, reviewer || null, note || null]
  );
  return rows[0];
}

async function clearOverride(classificationId) {
  await query('DELETE FROM human_overrides WHERE classification_id = $1', [classificationId]);
}

/** Everything awaiting a human decision, lowest confidence first. */
async function reviewQueue({ limit = 100 }) {
  const { rows } = await query(
    `SELECT *
       FROM applicant_rows
      WHERE result = 'NEEDS_REVIEW'
      ORDER BY confidence ASC NULLS FIRST, created_at DESC
      LIMIT $1`,
    [limit]
  );
  return rows;
}

async function reviewQueueCount() {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM applicant_rows WHERE result = 'NEEDS_REVIEW'`
  );
  return rows[0].count;
}

async function findById(id) {
  const { rows } = await query('SELECT * FROM classifications WHERE id = $1', [id]);
  return rows[0] || null;
}

module.exports = {
  record,
  supersede,
  history,
  override,
  clearOverride,
  reviewQueue,
  reviewQueueCount,
  findById,
};
