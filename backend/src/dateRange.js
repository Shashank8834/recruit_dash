/**
 * The window the dashboard shows when the caller does not ask for one.
 *
 * Recruitment is a rolling concern: what matters is who applied this week and
 * which roles are live now, not a year of history. The default was 30 days,
 * which on a freshly backfilled database meant the first screen mixed
 * this week's verdicts with every historical row imported from Sheets — most
 * of them matched against roles that have since been demoted or closed. The
 * oldest, least trustworthy rows are the ones a stranger to the system reads
 * first, and they are the ones least worth reading.
 *
 * Nothing is deleted, and this is only a DEFAULT: an explicit startDate widens
 * it again, so the history stays one query away rather than gone.
 */
const DEFAULT_DAYS = parseInt(process.env.DASHBOARD_DEFAULT_DAYS || '7', 10);

function dateRange(req) {
  const now = Math.floor(Date.now() / 1000);
  const start = req.query.startDate
    ? parseInt(req.query.startDate, 10)
    : now - DEFAULT_DAYS * 24 * 60 * 60;
  const end = req.query.endDate ? parseInt(req.query.endDate, 10) : now;
  return { start, end };
}

module.exports = { dateRange, DEFAULT_DAYS };
