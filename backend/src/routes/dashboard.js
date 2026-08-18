const express = require('express');
const router = express.Router();
const { query } = require('../db');
const applicantsRepo = require('../repo/applicants');
const { dateRange } = require('../dateRange');

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
