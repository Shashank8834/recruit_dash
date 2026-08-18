#!/usr/bin/env node
/**
 * Replays historical WhatsApp messages out of Evolution's own database and
 * through the normal pipeline.
 *
 * Evolution stores every message it has ever received, so nothing that
 * happened before this stack existed is lost — it just never reached us.
 * This walks a window of that history, chains it the way the live debounce
 * would have, and classifies it.
 *
 * Two phases, deliberately separate:
 *
 *   import    reads Evolution's Message table into our `messages` table.
 *             Fast, no model calls, safe to repeat — the wa_message_id unique
 *             constraint makes it idempotent.
 *
 *   classify  groups those messages into submissions and runs the classifier.
 *             Slow and rate-limited, so it takes --limit and can be re-run
 *             until the backlog clears.
 *
 * Usage:
 *   node scripts/backfill.js --inspect             # show Evolution's schema
 *   node scripts/backfill.js --days=7              # dry run, counts only
 *   node scripts/backfill.js --days=7 --import     # write messages
 *   node scripts/backfill.js --classify --limit=20 # classify a slice
 *   node scripts/backfill.js --reclassify --limit=20  # re-run current prompts
 *
 * --days defaults to 7. On a metered free tier the window is a spending
 * decision as much as a scope one: every extra day is more submissions, and
 * each submission costs two model calls that come out of the same quota.
 */
require('dotenv').config();

const { Client } = require('pg');
const { pool, query, withTransaction } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { normalize } = require('../src/services/evolution');
const contactsRepo = require('../src/repo/contacts');
const messagesRepo = require('../src/repo/messages');
const submissionsRepo = require('../src/repo/submissions');
const { classifySubmission, reclassify } = require('../src/services/pipeline');
const classifier = require('../src/services/classifier');
const llm = require('../src/services/llm');
const media = require('../src/services/media');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = (name) => args.includes(`--${name}`);

const DAYS = parseInt(flag('days', '7'), 10);
const LIMIT = parseInt(flag('limit', '0'), 10);
const DO_IMPORT = has('import');
const DO_CLASSIFY = has('classify');
const DO_RECLASSIFY = has('reclassify');
const INSPECT = has('inspect');
const QUIET_SECONDS = parseInt(process.env.BATCH_QUIET_SECONDS || '60', 10);
const MAX_WINDOW_SECONDS = parseInt(process.env.BATCH_MAX_WINDOW_SECONDS || '600', 10);

const ALLOWED = (process.env.INGEST_ALLOWED_CHATS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function evolutionClient() {
  const url = process.env.EVOLUTION_DB_URL;
  if (!url) {
    throw new Error(
      'EVOLUTION_DB_URL is not set. Take it from Evolution’s DATABASE_CONNECTION_URI, e.g.\n' +
      '  postgresql://evolution:PASS@evolution_postgres:5432/evolution_db?schema=evolution_api'
    );
  }
  return new Client({ connectionString: url });
}

/** Evolution's column naming varies between versions; look before leaping. */
async function inspect(client) {
  const { rows } = await client.query(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_name ILIKE '%message%' ORDER BY 1,2`
  );
  console.log('Tables matching "message":');
  rows.forEach((r) => console.log(`  ${r.table_schema}.${r.table_name}`));

  for (const r of rows) {
    const cols = await client.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`,
      [r.table_schema, r.table_name]
    );
    console.log(`\n${r.table_schema}.${r.table_name}:`);
    cols.rows.forEach((c) => console.log(`  ${c.column_name.padEnd(24)} ${c.data_type}`));
  }
}

async function readHistory(client) {
  const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
  const params = [since];
  let chatFilter = '';
  if (ALLOWED.length) {
    params.push(ALLOWED);
    chatFilter = `AND m.key->>'remoteJid' = ANY($2)`;
  }

  const { rows } = await client.query(
    `SELECT m.key, m."pushName", m.message, m."messageType", m."messageTimestamp"
       FROM evolution_api."Message" m
      WHERE (m."messageTimestamp")::bigint >= $1
        AND COALESCE((m.key->>'fromMe')::boolean, false) = false
        ${chatFilter}
      ORDER BY (m."messageTimestamp")::bigint ASC`,
    params
  );
  return rows;
}

/** Rebuild the webhook envelope so one normalizer serves both paths. */
function toPayload(row) {
  return {
    event: 'messages.upsert',
    data: {
      key: row.key,
      pushName: row.pushName,
      message: row.message,
      messageType: row.messageType,
      messageTimestamp: Number(row.messageTimestamp),
    },
  };
}

async function importPhase() {
  const client = evolutionClient();
  await client.connect();
  try {
    if (INSPECT) return inspect(client);

    const rows = await readHistory(client);
    console.log(
      `Evolution holds ${rows.length} inbound message(s) in the last ${DAYS} day(s)` +
      (ALLOWED.length ? ` for ${ALLOWED.length} allowed chat(s)` : ' across all chats')
    );

    const usable = rows.map(toPayload).map(normalize).filter(Boolean);
    console.log(`${usable.length} carry text or media and would be ingested.`);

    if (!DO_IMPORT) {
      console.log('\nDRY RUN — re-run with --import to write them.');
      return;
    }

    let inserted = 0;
    let duplicate = 0;
    for (const norm of usable) {
      await withTransaction(async (tx) => {
        let contact = null;
        if (norm.phone) {
          contact = await contactsRepo.upsertByPhone(
            { phone: norm.phone, waJid: norm.senderJid, pushName: norm.pushName },
            tx
          );
        }
        const stored = await messagesRepo.insert(
          { ...norm, contactId: contact ? contact.id : null },
          tx
        );
        if (stored) inserted += 1;
        else duplicate += 1;
      });
    }
    console.log(`Imported ${inserted} new message(s); ${duplicate} already present.`);
  } finally {
    await client.end();
  }
}

/**
 * Chains messages the way the live debounce window would have: consecutive
 * messages from one chat belong together until the sender goes quiet for
 * BATCH_QUIET_SECONDS, capped at BATCH_MAX_WINDOW_SECONDS.
 */
function groupIntoBatches(messages) {
  const batches = [];
  let current = [];
  for (const m of messages) {
    if (current.length === 0) {
      current = [m];
      continue;
    }
    const prev = current[current.length - 1];
    const gap = (new Date(m.sent_at) - new Date(prev.sent_at)) / 1000;
    const span = (new Date(m.sent_at) - new Date(current[0].sent_at)) / 1000;
    if (gap <= QUIET_SECONDS && span <= MAX_WINDOW_SECONDS) current.push(m);
    else {
      batches.push(current);
      current = [m];
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * What this run will cost, before it starts.
 *
 * Both ceilings are reported because either can be the binding one, and on a
 * free tier it is usually tokens: a 6000 TPM budget paces this run harder than
 * a 25 rpm one does. Quoting only requests per minute understated the wall
 * time by an order of magnitude, which is a bad surprise to hand someone
 * spending a quota that expires.
 */
function printEstimate(submissions) {
  if (submissions === 0) return;
  // Read the resolved ceilings rather than re-deriving them: LLM_MAX_TPM
  // defaults per provider, and a second copy of that rule would drift.
  const { MAX_RPM: rpm, MAX_TPM: tpm } = llm;
  const calls = submissions * 2;
  // Per-submission cost, measured rather than derived from the character
  // budgets. Those budgets are ceilings: they describe the largest prompt the
  // classifier is allowed to send, not the one it typically sends. Estimating
  // from them assumed every routing call carried a full 3,000-character block
  // and every match all five roles at full length, which came out around 8,400
  // tokens a submission against a measured average nearer 3,300 — quoting 41
  // minutes for work that takes closer to 16.
  //
  // Also an overestimate is not the safe direction here. This number only sets
  // expectations; the rate limiter does the actual pacing from real usage. A
  // wildly pessimistic quote just makes people cancel a run that would have
  // finished.
  //
  // Re-measure after a prompt change:
  //   SELECT round(avg(tokens)) FROM llm_call_log WHERE tokens > 0;
  // noting the table is pruned to the last 60 seconds, so sample it during a
  // run rather than after one.
  const TOKENS_PER_CALL = parseInt(process.env.BACKFILL_TOKENS_PER_CALL || '1700', 10);
  const tokens = calls * TOKENS_PER_CALL;

  const byRequests = rpm > 0 ? calls / rpm : 0;
  const byTokens = tpm > 0 ? tokens / tpm : 0;
  const minutes = Math.ceil(Math.max(byRequests, byTokens));

  if (!minutes) {
    console.log(`About ${calls} model call(s); rate limiting is disabled.`);
    return;
  }
  const bound = byTokens >= byRequests ? 'tokens' : 'requests';
  console.log(
    `About ${calls} model call(s) and ${tokens.toLocaleString()} tokens: ` +
    `roughly ${minutes} minute(s), bound by ${bound} ` +
    `(${rpm || 'unlimited'} rpm, ${tpm || 'unlimited'} tpm). ` +
    'Use --limit=N to take a slice.'
  );
}

/**
 * Re-runs the current prompts over submissions that were already classified by
 * an older one.
 *
 * Separate from --classify, which only ever sees messages that never made it
 * into a submission. After a prompt or budgeting change the verdicts already
 * on disk are the stale ones, and nothing else revisits them.
 *
 * Selection is by prompt_version and by whether the matched role is still
 * open, which makes the run RESUMABLE: each submission that succeeds moves to
 * the current version and matches against live roles, so it drops out of the
 * next run's query. On a metered tier that matters — this is a job you expect
 * to stop and restart with --limit until the backlog clears.
 *
 * Job postings are deliberately excluded. They have no classification row to
 * compare versions against, and re-running one calls jdsRepo.create again,
 * which would insert a duplicate role rather than update the original.
 */
async function reclassifyPhase() {
  const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
  // A verdict also goes stale when the ROLES change, not just the prompt.
  // Closing or demoting a job description silently invalidates every verdict
  // that pointed at it: the candidate was matched against a role that is no
  // longer in the candidate set, and re-running the same prompt version would
  // now reach a different answer. Selecting on prompt_version alone left those
  // verdicts on screen indefinitely, still naming a role the matcher would no
  // longer offer — which is the most misleading state the dashboard can be in,
  // because the row looks decided.
  const { rows: stale } = await query(
    `SELECT DISTINCT s.id, s.created_at, s.status
       FROM submissions s
       LEFT JOIN classifications c ON c.submission_id = s.id AND c.is_current
       LEFT JOIN jds j ON j.id = c.jd_id
      WHERE s.created_at >= to_timestamp($1)
        AND (
          s.status = 'failed'
          OR (c.id IS NOT NULL AND c.prompt_version IS DISTINCT FROM $2)
          OR (c.jd_id IS NOT NULL AND j.status IS DISTINCT FROM 'open')
        )
      ORDER BY s.created_at DESC`,
    [since, classifier.PROMPT_VERSION]
  );

  console.log(
    `${stale.length} submission(s) in the last ${DAYS} day(s) are not on ` +
    `prompt ${classifier.PROMPT_VERSION}, were matched to a role that is no ` +
    'longer open, or previously failed.'
  );
  printEstimate(stale.length);

  let todo = stale;
  if (LIMIT > 0) {
    todo = todo.slice(0, LIMIT);
    console.log(`Processing the first ${todo.length}.`);
  }

  let ok = 0;
  let failed = 0;
  for (const [i, row] of todo.entries()) {
    try {
      const result = await reclassify(row.id);
      ok += 1;
      console.log(`[${i + 1}/${todo.length}] submission ${row.id} -> ${JSON.stringify(result)}`);
    } catch (err) {
      failed += 1;
      console.error(`[${i + 1}/${todo.length}] submission ${row.id} failed: ${err.message}`);
    }
  }
  console.log(`\nRe-classified ${ok}, failed ${failed}. Re-run to continue.`);
}

async function classifyPhase() {
  const since = Math.floor(Date.now() / 1000) - DAYS * 86400;
  const { rows: pending } = await query(
    `SELECT m.* FROM messages m
      WHERE m.sent_at >= to_timestamp($1)
        AND NOT EXISTS (SELECT 1 FROM submission_messages sm WHERE sm.message_id = m.id)
      ORDER BY m.chat_id, m.sent_at ASC, m.id ASC`,
    [since]
  );

  const byChat = new Map();
  for (const m of pending) {
    if (!byChat.has(m.chat_id)) byChat.set(m.chat_id, []);
    byChat.get(m.chat_id).push(m);
  }

  let batches = [];
  for (const [chatId, msgs] of byChat) {
    for (const batch of groupIntoBatches(msgs)) batches.push({ chatId, messages: batch });
  }

  console.log(`${pending.length} unclassified message(s) form ${batches.length} submission(s).`);

  printEstimate(batches.length);

  if (!DO_CLASSIFY) {
    console.log('\nDRY RUN — re-run with --classify to process. Use --limit=N for a slice.');
    return;
  }

  if (LIMIT > 0) {
    batches = batches.slice(0, LIMIT);
    console.log(`Processing the first ${batches.length}.`);
  }

  let ok = 0;
  let failed = 0;
  for (const [i, batch] of batches.entries()) {
    try {
      await media.hydrate(batch.messages);
      const submission = await withTransaction((tx) =>
        submissionsRepo.create(
          {
            chatId: batch.chatId,
            contactId: batch.messages[0].contact_id,
            messages: batch.messages,
          },
          tx
        )
      );
      const result = await classifySubmission(submission, batch.messages);
      ok += 1;
      console.log(
        `[${i + 1}/${batches.length}] ${batch.chatId} (${batch.messages.length} msg) -> ${JSON.stringify(result)}`
      );
    } catch (err) {
      failed += 1;
      console.error(`[${i + 1}/${batches.length}] failed: ${err.message}`);
    }
  }
  console.log(`\nClassified ${ok}, failed ${failed}. Re-run to continue where this left off.`);
}

(async () => {
  await migrate();
  // --reclassify works entirely on rows we already hold, so it neither reads
  // Evolution nor needs EVOLUTION_DB_URL to be set.
  if (DO_RECLASSIFY) {
    await reclassifyPhase();
  } else {
    if (INSPECT || !DO_CLASSIFY) await importPhase();
    if (DO_CLASSIFY || (!DO_IMPORT && !INSPECT)) await classifyPhase();
  }
  await pool.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
