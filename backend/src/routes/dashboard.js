const express = require('express');
const router = express.Router();
const { query } = require('../db');
const applicantsRepo = require('../repo/applicants');
const manualJobsRepo = require('../repo/manualJobs');
const { dateRange } = require('../dateRange');

/**
 * The overview of the side a recruiter curates: hand-written roles and the
 * talent pool.
 *
 * Separate from GET / below, which reports on the WhatsApp pipeline. The two
 * answer different questions and are read by different people at different
 * times — "where are my roles up to" is a daily question about work in
 * progress, while "is the ingest healthy" is one you ask when something looks
 * wrong. Merging them produced a screen where the number that mattered was
 * never the one you were looking at.
 *
 * Every figure here counts the whole pool, with no date window. A talent pool
 * is an asset that accumulates; a CV uploaded in March is exactly as useful in
 * August, and windowing it would report a shrinking pool that is in fact
 * growing.
 */
router.get('/managed', async (_req, res) => {
  try {
    const [stages, talent, matches, recentRoles, recentCandidates] = await Promise.all([
      manualJobsRepo.countsByStage(),
      query(
        `SELECT COUNT(*)::int                                            AS total,
                COUNT(*) FILTER (WHERE entry_mode = 'upload')::int       AS uploaded,
                COUNT(*) FILTER (WHERE entry_mode = 'manual')::int       AS hand_entered,
                COUNT(*) FILTER (WHERE file_data IS NOT NULL)::int       AS with_cv,
                COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days')::int  AS added_7d,
                COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS added_30d,
                (SELECT COUNT(*)::int FROM candidate_notes)              AS notes,
                (SELECT COUNT(DISTINCT candidate_id)::int FROM candidate_notes) AS with_notes
           FROM candidates`
      ),
      query(
        `SELECT COUNT(*) FILTER (WHERE verdict = 'STRONG')::int  AS strong,
                COUNT(*) FILTER (WHERE verdict = 'PARTIAL')::int AS partial,
                COUNT(*)::int                                    AS total
           FROM job_match_suggestions`
      ),
      query(
        `SELECT j.external_id, j.title, j.company, j.status, j.created_at,
                (SELECT COUNT(*)::int FROM job_match_suggestions s
                  WHERE s.manual_job_id = j.id AND s.verdict IN ('STRONG','PARTIAL')
                ) AS match_count
           FROM manual_jobs j
          ORDER BY j.created_at DESC LIMIT 5`
      ),
      query(
        `SELECT external_id, name, current_designation, current_company,
                entry_mode, created_at
           FROM candidates ORDER BY created_at DESC LIMIT 5`
      ),
    ]);

    const active = stages.open + stages.reviewing;
    res.json({
      roles: {
        stages,
        total: Object.values(stages).reduce((a, b) => a + b, 0),
        // "Live" is open plus reviewing: both are roles someone is still
        // working, and splitting them here would understate the load.
        active,
      },
      talent: talent.rows[0],
      matches: matches.rows[0],
      recentRoles: recentRoles.rows,
      recentCandidates: recentCandidates.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/** The WhatsApp side: what the pipeline ingested and how it is holding up. */
router.get('/', async (req, res) => {
  try {
    const { start, end } = dateRange(req);

    const [counts, jdCount, pipeline] = await Promise.all([
      applicantsRepo.counts({ start, end }),
      query(
        // Drafts are fragments awaiting their other half, not open roles. They
        // are excluded from matching, so counting them here would advertise
        // openings the pipeline will never match anyone to.
        `SELECT COUNT(*)::int AS count FROM jds
          WHERE posted_at >= to_timestamp($1) AND posted_at <= to_timestamp($2)
            AND status <> 'draft'`,
        [start, end]
      ),
      query(
        `SELECT
           (SELECT COUNT(*)::int FROM pending_batches)                        AS pending_batches,
           (SELECT COUNT(*)::int FROM submissions WHERE status = 'pending')   AS pending_submissions,
           (SELECT COUNT(*)::int FROM submissions WHERE status = 'failed')    AS failed_submissions,
           (SELECT COUNT(*)::int FROM sheet_sync_queue WHERE synced_at IS NULL) AS sheet_backlog`
      ),
    ]);

    const total = Object.values(counts).reduce((a, b) => a + b, 0);

    res.json({
      totalJDs: jdCount.rows[0].count,
      totalApplicants: total,
      strongMatches: counts.STRONG || 0,
      partialMatches: counts.PARTIAL || 0,
      weakMatches: counts.WEAK || 0,
      noneMatches: counts.NONE || 0,
      unknownMatches: counts.UNKNOWN || 0,
      needsReview: counts.NEEDS_REVIEW || 0,
      pipeline: pipeline.rows[0],
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
