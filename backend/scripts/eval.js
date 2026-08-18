#!/usr/bin/env node
/**
 * Measures classification accuracy against hand-labelled cases.
 *
 * Without this, a prompt change is a guess: you can tell that behaviour
 * changed but not whether it improved. Run it before and after every prompt
 * edit and compare the matrices.
 *
 *   npm run eval:load          # load eval/golden.json into the DB
 *   npm run eval               # score current prompts against the golden set
 *   npm run eval -- --stage=router
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { pool, query } = require('../src/db');
const { migrate } = require('../src/db/migrate');
const classifier = require('../src/services/classifier');
const jdsRepo = require('../src/repo/jds');

const args = process.argv.slice(2);
const LOAD = args.includes('--load');
const STAGE = (args.find((a) => a.startsWith('--stage=')) || '').split('=')[1] || 'all';
// Default 1: the eval is paced by the shared rate limiter in llm.js, and
// fanning out on a free-tier key just converts throughput into 429s.
const CONCURRENCY = parseInt(process.env.EVAL_CONCURRENCY || '1', 10);

function readGoldenFile() {
  const file = path.join(__dirname, '..', 'eval', 'golden.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Older versions of this file were a bare array of cases.
  return Array.isArray(parsed)
    ? { file, jds: [], cases: parsed }
    : { file, jds: parsed.jds || [], cases: parsed.cases || [] };
}

async function loadGolden() {
  const { file, cases: items } = readGoldenFile();

  await query('TRUNCATE golden_labels RESTART IDENTITY');
  for (const item of items) {
    await query(
      `INSERT INTO golden_labels
         (label, input_text, expected_kind, expected_verdict, jd_external_id, notes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        item.label,
        item.input_text,
        item.expected_kind || null,
        item.expected_verdict || null,
        item.jd_external_id || null,
        item.notes || null,
      ]
    );
  }
  console.log(`Loaded ${items.length} golden labels from ${file}`);
}

/** Runs tasks with bounded concurrency so the eval doesn't trip rate limits. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function confusionMatrix(pairs, classes) {
  const matrix = new Map();
  for (const expected of classes) {
    matrix.set(expected, new Map(classes.map((c) => [c, 0])));
  }
  for (const { expected, actual } of pairs) {
    if (!matrix.has(expected)) matrix.set(expected, new Map(classes.map((c) => [c, 0])));
    const row = matrix.get(expected);
    row.set(actual, (row.get(actual) || 0) + 1);
  }
  return matrix;
}

function printMatrix(title, pairs, classes) {
  console.log(`\n=== ${title} ===`);
  if (pairs.length === 0) {
    console.log('(no cases)');
    return;
  }
  const matrix = confusionMatrix(pairs, classes);
  const width = Math.max(14, ...classes.map((c) => c.length + 2));
  const pad = (s) => String(s).padEnd(width);

  console.log(pad('expected \\ got') + classes.map(pad).join(''));
  for (const expected of classes) {
    const row = matrix.get(expected);
    const cells = classes.map((c) => {
      const n = row.get(c) || 0;
      return pad(expected === c && n > 0 ? `${n} *` : n);
    });
    console.log(pad(expected) + cells.join(''));
  }

  console.log('\nPer-class:');
  for (const cls of classes) {
    const tp = pairs.filter((p) => p.expected === cls && p.actual === cls).length;
    const fp = pairs.filter((p) => p.expected !== cls && p.actual === cls).length;
    const fn = pairs.filter((p) => p.expected === cls && p.actual !== cls).length;
    if (tp + fp + fn === 0) continue;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    console.log(
      `  ${cls.padEnd(14)} P=${precision.toFixed(2)}  R=${recall.toFixed(2)}  F1=${f1.toFixed(2)}  (n=${tp + fn})`
    );
  }

  const correct = pairs.filter((p) => p.expected === p.actual).length;
  console.log(`\nAccuracy: ${correct}/${pairs.length} (${((correct / pairs.length) * 100).toFixed(1)}%)`);
}

async function run() {
  const { rows: labels } = await query('SELECT * FROM golden_labels ORDER BY id');
  if (labels.length === 0) {
    console.log('No golden labels. Run: npm run eval:load');
    return;
  }

  // Match against the fixture JDs from the golden file, never the database.
  // Scoring "7 years of React" against whatever 25 roles happen to be open
  // measures nothing: NONE is the right answer when no React role exists, so
  // the expected verdicts would be meaningless and the run unrepeatable.
  const { jds: fixtureJds } = readGoldenFile();
  const openJds = fixtureJds.map((j) => ({
    external_id: j.external_id,
    title: j.title,
    jd_text: j.jd_text,
    requirements: j.requirements || [],
  }));

  if (openJds.length === 0) {
    console.log('No fixture JDs in eval/golden.json — stage 2 cannot be scored.');
  }
  console.log(
    `Scoring ${labels.length} cases with prompt ${classifier.PROMPT_VERSION} ` +
    `against ${openJds.length} fixture JDs (confidence floor ${classifier.NEEDS_REVIEW_BELOW})`
  );

  // Roughly 1.6 calls per case: every case is routed, and those expecting a
  // verdict are matched as well.
  const rpm = parseFloat(process.env.GEMINI_MAX_RPM || '4');
  console.log(
    rpm > 0
      ? `Paced at ${rpm} req/min — expect about ${Math.ceil((labels.length * 1.6) / rpm)} minute(s).\n`
      : 'Rate limiting disabled.\n'
  );

  const results = await mapLimit(labels, CONCURRENCY, async (label) => {
    try {
      const routed = await classifier.route({ text: label.input_text, contextMessages: [] });
      let verdict = null;
      let confidence = routed.confidence;
      let matchedJd = null;

      if (
        STAGE !== 'router' &&
        label.expected_verdict &&
        routed.kind === 'application'
      ) {
        const raw = await classifier.match({ text: label.input_text, jds: openJds });
        const scored = classifier.applyConfidenceFloor(raw);
        verdict = scored.verdict;
        confidence = scored.confidence;
        matchedJd = scored.jdExternalId;
      }

      return { label, kind: routed.kind, verdict, confidence, matchedJd, error: null };
    } catch (err) {
      return { label, kind: null, verdict: null, confidence: null, matchedJd: null, error: err.message };
    }
  });

  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.log(`${failed.length} case(s) errored:`);
    failed.forEach((r) => console.log(`  ${r.label.label}: ${r.error}`));
  }

  const kindPairs = results
    .filter((r) => !r.error && r.label.expected_kind)
    .map((r) => ({ expected: r.label.expected_kind, actual: r.kind, label: r.label.label }));

  printMatrix('Stage 1 — routing', kindPairs, [
    'job_posting', 'application', 'chatter', 'unclear',
  ]);

  if (STAGE !== 'router') {
    const verdictPairs = results
      .filter((r) => !r.error && r.label.expected_verdict && r.verdict)
      .map((r) => ({
        expected: r.label.expected_verdict,
        actual: r.verdict,
        label: r.label.label,
      }));
    printMatrix('Stage 2 — JD match', verdictPairs, [
      'STRONG', 'PARTIAL', 'WEAK', 'NONE', 'NEEDS_REVIEW',
    ]);
  }

  const misses = results.filter(
    (r) =>
      !r.error &&
      ((r.label.expected_kind && r.kind !== r.label.expected_kind) ||
        (r.label.expected_verdict && r.verdict && r.verdict !== r.label.expected_verdict) ||
        (r.label.jd_external_id && r.matchedJd && r.matchedJd !== r.label.jd_external_id))
  );

  if (misses.length) {
    console.log('\n=== Misses ===');
    for (const m of misses) {
      console.log(`\n${m.label.label}`);
      console.log(`  expected: kind=${m.label.expected_kind || '-'} verdict=${m.label.expected_verdict || '-'}`);
      console.log(`  got:      kind=${m.kind || '-'} verdict=${m.verdict || '-'} confidence=${m.confidence ?? '-'}`);
      if (m.label.jd_external_id || m.matchedJd) {
        const wrongRole = m.matchedJd !== m.label.jd_external_id;
        console.log(
          `  role:     expected=${m.label.jd_external_id || '-'} matched=${m.matchedJd || 'NONE'}` +
          (wrongRole ? '   <-- matched the wrong role' : '')
        );
      }
      if (m.label.notes) console.log(`  note:     ${m.label.notes}`);
      console.log(`  input:    ${m.label.input_text.slice(0, 120).replace(/\n/g, ' ⏎ ')}`);
    }
  }
}

(async () => {
  await migrate();
  if (LOAD) await loadGolden();
  else await run();
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
