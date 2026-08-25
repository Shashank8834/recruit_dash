const { query } = require('../db');

/**
 * Roles a recruiter writes by hand, kept separate from `jds`, which holds what
 * the WhatsApp pipeline parsed out of messages.
 */

/**
 * The stages a role moves through, in order.
 *
 * Exported rather than duplicated in the route and the UI: the order decides
 * how the list sorts and how the picker reads, and three copies of it drift
 * the first time a stage is added. The database CHECK is the enforcement; this
 * is the ordering the CHECK cannot express.
 */
const STAGES = ['open', 'reviewing', 'placed', 'closed'];

async function create({ title, company, location, description, requirements, minExperienceYears, createdBy }) {
  const { rows } = await query(
    `INSERT INTO manual_jobs
       (external_id, title, company, location, description, requirements,
        min_experience_years, created_by)
     VALUES ('pending',$1,$2,$3,$4,$5,$6,$7)
     RETURNING *`,
    [
      title,
      company || null,
      location || null,
      description || '',
      JSON.stringify(requirements || []),
      minExperienceYears ?? null,
      createdBy || null,
    ]
  );
  const { rows: updated } = await query(
    `UPDATE manual_jobs SET external_id = 'ROLE_' || (1000 + id) WHERE id = $1 RETURNING *`,
    [rows[0].id]
  );
  return updated[0];
}

async function list({ status } = {}) {
  const { rows } = await query(
    `SELECT j.*,
            (SELECT COUNT(*)::int FROM job_match_suggestions s
              WHERE s.manual_job_id = j.id AND s.verdict IN ('STRONG','PARTIAL')
            ) AS match_count
       FROM manual_jobs j
      WHERE ($1::text IS NULL OR j.status = $1)
      -- Stage first, newest within it. Sorted by date alone, a role closed
      -- last week sits above three that are open right now, and the list stops
      -- being a worklist.
      ORDER BY array_position($2::text[], j.status), j.created_at DESC`,
    [status || null, STAGES]
  );
  return rows;
}

/** How many roles sit at each stage. Every stage is present, zeroes included. */
async function countsByStage() {
  const { rows } = await query(
    `SELECT status, COUNT(*)::int AS count FROM manual_jobs GROUP BY status`
  );
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

async function findByExternalId(externalId) {
  const { rows } = await query('SELECT * FROM manual_jobs WHERE external_id = $1', [externalId]);
  return rows[0] || null;
}

async function update(externalId, fields) {
  const allowed = {
    title: 'title',
    company: 'company',
    location: 'location',
    description: 'description',
    status: 'status',
    minExperienceYears: 'min_experience_years',
    requirements: 'requirements',
  };
  const sets = [];
  const values = [externalId];
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    values.push(key === 'requirements' ? JSON.stringify(fields[key] || []) : fields[key]);
    sets.push(`${column} = $${values.length}${key === 'requirements' ? '::jsonb' : ''}`);
  }
  if (sets.length === 0) return findByExternalId(externalId);

  const { rows } = await query(
    `UPDATE manual_jobs SET ${sets.join(', ')}, updated_at = now()
      WHERE external_id = $1 RETURNING *`,
    values
  );
  return rows[0] || null;
}

async function remove(externalId) {
  const { rows } = await query(
    'DELETE FROM manual_jobs WHERE external_id = $1 RETURNING id',
    [externalId]
  );
  return rows[0] || null;
}

/**
 * Replaces a suggestion for one (job, candidate) pair.
 *
 * Upsert rather than insert: re-running suggestions on a job should refresh
 * the verdicts, not stack a new row on every run until the list is mostly
 * history. The unique indexes make each pair a single live opinion.
 */
async function recordSuggestion({
  manualJobId, source, candidateId, submissionId,
  verdict, confidence, reason, evidence, model, promptVersion,
}) {
  // Whitelisted rather than interpolated from `source` directly. The value is
  // internal today, but this is a string being concatenated into SQL, and the
  // only thing standing between that and an injection is where the caller
  // happens to get it from. A lookup cannot be talked into anything else.
  const CONFLICT_TARGETS = {
    manual: '(manual_job_id, candidate_id) WHERE candidate_id IS NOT NULL',
    whatsapp: '(manual_job_id, submission_id) WHERE submission_id IS NOT NULL',
  };
  const conflictTarget = CONFLICT_TARGETS[source];
  if (!conflictTarget) throw new Error(`Unknown suggestion source: ${source}`);

  const { rows } = await query(
    `INSERT INTO job_match_suggestions
       (manual_job_id, source, candidate_id, submission_id,
        verdict, confidence, reason, evidence, model, prompt_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT ${conflictTarget} DO UPDATE
       SET verdict = EXCLUDED.verdict,
           confidence = EXCLUDED.confidence,
           reason = EXCLUDED.reason,
           evidence = EXCLUDED.evidence,
           model = EXCLUDED.model,
           prompt_version = EXCLUDED.prompt_version,
           created_at = now()
     RETURNING *`,
    [
      manualJobId,
      source,
      candidateId || null,
      submissionId || null,
      verdict,
      confidence,
      reason || null,
      JSON.stringify(evidence || []),
      model || null,
      promptVersion || null,
    ]
  );
  return rows[0];
}

/**
 * Suggestions for a job, best first, with the candidate's details joined from
 * whichever pool they came from.
 *
 * The two sides are unioned only here, at read time, and every row states its
 * source — which is what "both, labelled" means in practice. Neither table
 * learns about the other.
 */
async function suggestionsFor(manualJobId) {
  const { rows } = await query(
    `SELECT s.id, s.source, s.verdict, s.confidence, s.reason, s.created_at,
            COALESCE(c.external_id, 'APP_' || cl.id)          AS candidate_ref,
            COALESCE(c.name, ct.name, ct.push_name)           AS name,
            COALESCE(c.email, ct.email)                       AS email,
            COALESCE(c.phone, ct.phone)                       AS phone,
            c.current_company, c.current_designation, c.location,
            c.experience_years
       FROM job_match_suggestions s
       LEFT JOIN candidates c   ON c.id = s.candidate_id
       LEFT JOIN submissions sub ON sub.id = s.submission_id
       LEFT JOIN contacts ct    ON ct.id = sub.contact_id
       -- One row per suggestion, whatever the classification history holds.
       -- A submission may carry several live classifications (the partial
       -- unique index is per jd_id, not per submission), and a plain LEFT JOIN
       -- would then list the same person once per verdict — looking like
       -- duplicate candidates in a recruiter's shortlist.
       LEFT JOIN LATERAL (
         SELECT c2.id FROM classifications c2
          WHERE c2.submission_id = sub.id AND c2.is_current
          ORDER BY c2.created_at DESC
          LIMIT 1
       ) cl ON true
      WHERE s.manual_job_id = $1
      ORDER BY
        CASE s.verdict
          WHEN 'STRONG' THEN 1 WHEN 'PARTIAL' THEN 2 WHEN 'WEAK' THEN 3
          WHEN 'NEEDS_REVIEW' THEN 4 ELSE 5
        END,
        s.confidence DESC NULLS LAST`,
    [manualJobId]
  );
  return rows;
}

module.exports = {
  STAGES,
  create, list, countsByStage, findByExternalId, update, remove,
  recordSuggestion, suggestionsFor,
};
