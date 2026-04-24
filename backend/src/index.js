require('dotenv').config();
const express = require('express');
const cors = require('cors');

const dashboardRoutes = require('./routes/dashboard');
const jdsRoutes = require('./routes/jds');
const applicantsRoutes = require('./routes/applicants');
const { fetchAllData } = require('./services/sheets');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use('/api/dashboard', dashboardRoutes);
app.use('/api/jds', jdsRoutes);
app.use('/api/applicants', applicantsRoutes);

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/refresh', async (_req, res) => {
  try {
    await fetchAllData(true);
    res.json({ message: 'Cache refreshed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Recruitment dashboard backend running on port ${PORT}`);
});
