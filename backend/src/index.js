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
const meetingsRoutes = require('./routes/meetings');
const authRoutes = require('./routes/auth');
const { attachUser, requireAuth } = require('./middleware/auth');
const sheetMirror = require('./services/sheetMirror');
const rateLimiter = require('./services/rateLimiter');
const llmService = require('./services/llm');

const app = express();
const PORT = process.env.PORT || 3001;

// The browser must send the session cookie, and a wildcard origin cannot ask
// it to: `credentials: true` with `origin: '*'` is refused outright by every
// browser. In production the app is served from the same origin as the API and
// no cross-origin request happens at all; ALLOWED_ORIGINS exists for a split
// deployment, and for the Vite dev server when it is not proxying.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : true,
  credentials: true,
}));

// Behind nginx or a Docker proxy, req.ip is the proxy's address unless this is
// set — which would key the login throttle to one address for every visitor,
// so the first person to fumble a password locks out the whole internet.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);

// WhatsApp messages can carry long forwarded text and base64 media metadata.
app.use(express.json({ limit: '5mb' }));

// Identifies the caller without refusing anyone. Mounted before every route so
// that handlers which merely want to know who is asking — stamping a note with
// its author — can read req.user without repeating the lookup.
app.use(attachUser);

// Open: the way in, and the way to ask whether you are already in.
app.use('/api/auth', authRoutes);

// --------------------------------------------------------------------------
// Everything below needs a session
// --------------------------------------------------------------------------
// Applied once, to the whole /api prefix, rather than route by route. Listing
// the protected routes individually means the next route added is public by
// default, and public-by-default on an API holding CVs and phone numbers is a
// mistake that will not announce itself.
//
// /webhook is deliberately NOT behind this: Evolution calls it machine to
// machine with no browser and no cookie, and it carries its own shared-token
// check. /api/health stays open below for the same reason — an uptime probe
// cannot log in, and it reports no personal data.
app.use('/api', (req, res, next) => {
  // Mounted AT /api, so req.path here is the remainder of the path — '/health',
  // not '/api/health'. Checked inside the same middleware rather than as an
  // earlier no-op mount: express runs middleware in registration order and a
  // pass-through registered first does not stop what comes after it from
  // matching, so the exemption has to be the thing that decides.
  if (req.path === '/health') return next();
  return requireAuth(req, res, next);
});

app.use('/api/dashboard', dashboardRoutes);
app.use('/api/jds', jdsRoutes);
app.use('/api/applicants', applicantsRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/candidates', candidatesRoutes);
app.use('/api/roles', manualJobsRoutes);
app.use('/api/meetings', meetingsRoutes);
app.use('/webhook', webhookRoutes);

app.get('/api/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    // The model budget is shared across processes, so exposing it here is the
    // quickest way to see why classification has gone quiet.
    const llm = await rateLimiter.status().catch(() => null);

    // A backoff that has expired is not a backoff. The stored value is kept as
    // history, but reporting it verbatim showed a three-day-old 429 as though
    // the pipeline were throttled right now — on the one endpoint someone
    // checks to answer "is it stuck?".
    const blockedUntil =
      llm && llm.blocked_until && new Date(llm.blocked_until) > new Date()
        ? llm.blocked_until
        : null;

    res.json({
      status: 'ok',
      db: 'up',
      sheetMirror: sheetMirror.isEnabled(),
      llm: llm && {
        usedLastMinute: llm.used_last_minute,
        // The resolved ceilings, not a re-read of one provider's variable.
        // GEMINI_MAX_RPM is unset on an OpenAI-compatible provider, so this
        // reported the fallback 4 while the limiter was actually pacing at 25.
        model: llmService.MODEL,
        provider: llmService.PROVIDER,
        maxRpm: llmService.MAX_RPM,
        maxTpm: llmService.MAX_TPM,
        blockedUntil,
        blockedReason: blockedUntil ? llm.reason : null,
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
