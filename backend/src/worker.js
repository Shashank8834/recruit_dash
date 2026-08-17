require('dotenv').config();

const os = require('os');
const { pool } = require('./db');
const { migrate } = require('./db/migrate');
const batches = require('./repo/batches');
const { flushBatch } = require('./services/pipeline');
const sheetMirror = require('./services/sheetMirror');

const WORKER_ID = `${os.hostname()}-${process.pid}`;
const POLL_MS = parseInt(process.env.WORKER_POLL_MS || '5000', 10);
const SHEET_SYNC_MS = parseInt(process.env.SHEET_SYNC_MS || '30000', 10);
const CLAIM_LIMIT = parseInt(process.env.WORKER_CLAIM_LIMIT || '5', 10);

let running = true;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tick() {
  const due = await batches.claimDue({ workerId: WORKER_ID, limit: CLAIM_LIMIT });
  if (due.length === 0) return 0;

  for (const batch of due) {
    try {
      const result = await flushBatch(batch);
      console.log(
        `[worker] flushed ${batch.chat_id} (${batch.message_count} msgs) ->`,
        JSON.stringify(result)
      );
    } catch (err) {
      // flushBatch already recorded the failure and scheduled a retry.
      console.error(`[worker] flush failed for ${batch.chat_id}:`, err.message);
    }
  }
  return due.length;
}

async function batchLoop() {
  while (running) {
    try {
      const handled = await tick();
      // Only idle when there was nothing to do — a backlog drains at full speed.
      if (handled === 0) await sleep(POLL_MS);
    } catch (err) {
      console.error('[worker] poll error:', err.message);
      await sleep(POLL_MS);
    }
  }
}

async function sheetLoop() {
  while (running) {
    await sleep(SHEET_SYNC_MS);
    if (!running) break;
    try {
      const result = await sheetMirror.sync();
      if (result.synced > 0) {
        console.log('[worker] sheet mirror synced', JSON.stringify(result));
      }
    } catch (err) {
      console.error('[worker] sheet sync failed:', err.message);
    }
  }
}

async function shutdown(signal) {
  console.log(`[worker] ${signal} received, draining`);
  running = false;
  await sleep(200);
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

(async () => {
  await migrate();
  console.log(
    `[worker] ${WORKER_ID} started; polling every ${POLL_MS}ms, ` +
    `sheet mirror ${sheetMirror.isEnabled() ? `every ${SHEET_SYNC_MS}ms` : 'disabled'}`
  );
  await Promise.all([batchLoop(), sheetLoop()]);
})().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
