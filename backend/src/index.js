require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { pool, query } = require('./db');
const { migrate } = require('./db/migrate');

const dashboardRoutes = require('./routes/dashboard');
const jdsRoutes = require('./routes/jds');
const applicantsRoutes = require('./routes/applicants');
const webhookRoutes = require('./routes/webhook');
const reviewRoutes = require('./routes/review');
// The manual side: uploaded CVs and hand-written roles. Mounted under their own
// paths and backed by their own tables, so nothing the WhatsApp pipeline writes
// can appear here by accident.
const candidatesRoutes = require('./routes/candidates');
const manualJobsRoutes = require('./routes/manualJobs');
const sheetMirror = require('./services/sheetMirror');
const rateLimiter = require('./services/rateLimiter');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
// WhatsApp messages can carry long forwarded text and base64 media metadata.
app.use(express.json({ limit: '5mb' }));

app.use('/api/dashboard', dashboardRoutes);
app.use('/api/jds', jdsRoutes);
app.use('/api/applicants', applicantsRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/candidates', candidatesRoutes);
app.use('/api/roles', manualJobsRoutes);
app.use('/webhook', webhookRoutes);

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    // The model budget is shared across processes, so exposing it here is the
    // quickest way to see why classification has gone quiet.
    const llm = await rateLimiter.status().catch(() => null);
    res.json({
      status: 'ok',
      db: 'up',
      sheetMirror: sheetMirror.isEnabled(),
      llm: llm && {
        usedLastMinute: llm.used_last_minute,
        maxRpm: parseFloat(process.env.GEMINI_MAX_RPM || '4'),
        blockedUntil: llm.blocked_until,
        blockedReason: llm.blocked_until ? llm.reason : null,
      },
    });
  } catch (err) {
    res.status(503).json({ status: 'degraded', db: 'down', error: err.message });
  }
});

/** Force a sheet mirror rewrite now instead of waiting for the worker. */
app.post('/api/sheets/sync', async (_req, res) => {
  try {
    res.json(await sheetMirror.sync());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

async function shutdown(signal) {
  console.log(`[api] ${signal} received, closing`);
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  await migrate();
  app.listen(PORT, () => {
    console.log(`Recruitment dashboard API on :${PORT}`);
    console.log(`WhatsApp webhook: POST http://localhost:${PORT}/webhook/whatsapp`);
  });
})().catch((err) => {
  console.error('[api] failed to start:', err);
  process.exit(1);
});
