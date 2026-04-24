const express = require('express');
const router = express.Router();
const { fetchAllData } = require('../services/sheets');

router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, result } = req.query;
    const { jds, applicants } = await fetchAllData();

    const now = Math.floor(Date.now() / 1000);
    const defaultStart = now - 30 * 24 * 60 * 60;

    const start = startDate ? parseInt(startDate) : defaultStart;
    const end = endDate ? parseInt(endDate) : now;

    const filteredJDs = jds.filter((jd) => {
      const ts = parseInt(jd.Date);
      return ts >= start && ts <= end;
    });

    let filteredApplicants = applicants.filter((app) => {
      const ts = parseInt(app.Date);
      return ts >= start && ts <= end;
    });

    if (result) {
      filteredApplicants = filteredApplicants.filter(
        (app) => app.Result === result.toUpperCase()
      );
    }

    const counts = filteredApplicants.reduce(
      (acc, app) => {
        const r = app.Result || 'UNKNOWN';
        acc[r] = (acc[r] || 0) + 1;
        return acc;
      },
      {}
    );

    res.json({
      totalJDs: filteredJDs.length,
      totalApplicants: filteredApplicants.length,
      strongMatches: counts['STRONG'] || 0,
      partialMatches: counts['PARTIAL'] || 0,
      weakMatches: counts['WEAK'] || 0,
      noneMatches: counts['NONE'] || 0,
      unknownMatches: counts['UNKNOWN'] || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
