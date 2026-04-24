const express = require('express');
const router = express.Router();
const { fetchAllData, deleteJD } = require('../services/sheets');

router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, status } = req.query;
    const { jds, applicants } = await fetchAllData();

    const now = Math.floor(Date.now() / 1000);
    const defaultStart = now - 30 * 24 * 60 * 60;
    const start = startDate ? parseInt(startDate) : defaultStart;
    const end = endDate ? parseInt(endDate) : now;

    let filtered = jds.filter((jd) => {
      const ts = parseInt(jd.Date);
      return ts >= start && ts <= end;
    });

    if (status) {
      filtered = filtered.filter((jd) => jd.Status === status);
    }

    const result = filtered
      .map((jd) => {
        const matched = applicants.filter((a) => a.JD_ID === jd.JD_ID);
        return {
          ...jd,
          Date: parseInt(jd.Date),
          candidateCount: matched.length,
        };
      })
      .sort((a, b) => b.Date - a.Date);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { applicants, jds } = await fetchAllData();
    const jd = jds.find((j) => j.JD_ID === req.params.id);
    if (!jd) return res.status(404).json({ error: 'JD not found' });

    const ORDER = { STRONG: 0, PARTIAL: 1, WEAK: 2, NONE: 3, UNKNOWN: 4 };
    const matched = applicants
      .filter((a) => a.JD_ID === jd.JD_ID)
      .map((a) => ({ ...a, Date: parseInt(a.Date) }))
      .sort((a, b) => {
        const orderDiff = (ORDER[a.Result] ?? 4) - (ORDER[b.Result] ?? 4);
        return orderDiff !== 0 ? orderDiff : b.Date - a.Date;
      });

    res.json({ ...jd, Date: parseInt(jd.Date), applicants: matched });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await deleteJD(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'JD not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
