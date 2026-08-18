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
 *   node scripts/backfill.js --days=14             # dry run, counts only
 *   node scripts/backfill.js --days=14 --import    # write messages
 *   node scripts/backfill.js --classify --limit=20 # classify a slice
 */
require('dotenv').config();

const { Client } = require('pg');
const { pool, query, withTransaction } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const { normalize } = require('../src/services/evolution');
const contactsRepo = require('../src/repo/contacts');
const messagesRepo = require('../src/repo/messages');
const submissionsRepo = require('../src/repo/submissions');
const { classifySubmission } = require('../src/services/pipeline');
const media = require('../src/services/media');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const has = (name) => args.includes(`--${name}`);

const DAYS = parseInt(flag('days', '14'), 10);
const LIMIT = parseInt(flag('limit', '0'), 10);
const DO_IMPORT = has('import');
const DO_CLASSIFY = has('classify');
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

  const rpm = parseFloat(process.env.GEMINI_MAX_RPM || '4');
  if (rpm > 0) {
    console.log(
      `At ${rpm} req/min (~2 calls each) the full set is roughly ` +
      `${Math.ceil((batches.length * 2) / rpm)} minute(s).`
    );
  }

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
  if (INSPECT || !DO_CLASSIFY) await importPhase();
  if (DO_CLASSIFY || (!DO_IMPORT && !INSPECT)) await classifyPhase();
  await pool.end();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
