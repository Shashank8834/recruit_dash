const express = require('express');
const router = express.Router();
const { fetchAllData, deleteApplicant } = require('../services/sheets');

router.get('/', async (req, res) => {
  try {
    const { startDate, endDate, result } = req.query;
    const { applicants } = await fetchAllData();

    const now = Math.floor(Date.now() / 1000);
    const defaultStart = now - 30 * 24 * 60 * 60;
    const start = startDate ? parseInt(startDate) : defaultStart;
    const end = endDate ? parseInt(endDate) : now;

    let filtered = applicants.filter((a) => {
      const ts = parseInt(a.Date);
      return ts >= start && ts <= end;
    });

    if (result) {
      filtered = filtered.filter((a) => a.Result === result.toUpperCase());
    }

    const result_ = filtered
      .map((a) => ({ ...a, Date: parseInt(a.Date) }))
      .sort((a, b) => b.Date - a.Date);

    res.json(result_);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { applicants, jds } = await fetchAllData();
    const applicant = applicants.find((a) => a.Applicant_ID === req.params.id);
    if (!applicant) return res.status(404).json({ error: 'Applicant not found' });

    const allMatches = applicants
      .filter(
        (a) =>
          a.Sender === applicant.Sender &&
          a.JD_ID !== 'NONE' &&
          a.JD_ID !== ''
      )
      .map((a) => {
        const jd = jds.find((j) => j.JD_ID === a.JD_ID);
        return {
          applicant_id: a.Applicant_ID,
          JD_ID: a.JD_ID,
          Date: parseInt(a.Date),
          Result: a.Result,
          Reason: a.Reason,
          jdText: jd ? jd.JD_Text : null,
          jdPostedBy: jd ? jd.Posted_By : null,
          jdStatus: jd ? jd.Status : null,
        };
      });

    res.json({ ...applicant, Date: parseInt(applicant.Date), matches: allMatches });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await deleteApplicant(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Applicant not found' });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
