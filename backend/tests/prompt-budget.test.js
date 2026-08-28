/**
 * Every stage that builds a prompt, measured at its worst case against the
 * per-request token ceiling.
 *
 * This is the test that would have caught the CV upload failure before a
 * recruiter did. A provider meters tokens-per-minute against the RESERVED
 * output budget, so each stage spends part of the ceiling on its system
 * prompt, its schema and its output cap before any content is counted. Get
 * those fixed costs wrong and the stage does not degrade — it is rejected
 * outright, by our own limiter, with nothing sent.
 *
 * The point of pinning all four together is that the budgets live in eight
 * separate env vars across three files. Raising TALENT_SHORTLIST or
 * MATCH_JD_LIMIT is a one-character change that can push a stage over, and the
 * failure surfaces to a user rather than here.
 */
const test = require('node:test');
const assert = require('node:assert');

// The ceiling only exists on an OpenAI-compatible provider; Gemini's tier has
// no meaningful TPM limit and defaults to 0 (disabled). Set before llm.js is
// required, since it reads env at load.
process.env.LLM_PROVIDER = 'groq';
process.env.LLM_MAX_TPM = '6000';

const llm = require('../src/services/llm');

const calls = [];
llm.generateJson = async (args) => {
  calls.push(args);
  return {
    data: {
      // Enough of every schema to satisfy each caller's result mapping.
      name: 'A', notes: '', kind: 'application', confidence: 1,
      continues_previous: false, reason: 'r', jd_external_id: 'NONE',
      verdict: 'NONE', evidence: [], matches: [],
    },
    model: 'fake',
    usage: null,
  };
};

const classifier = require('../src/services/classifier');
const cvExtractor = require('../src/services/cvExtractor');
const talentMatch = require('../src/services/talentMatch');

const CEILING = 6000;

/** Longer than any budget, so each stage clips to its own maximum. */
const OVERLONG = 'x'.repeat(60000);

test.beforeEach(() => {
  calls.length = 0;
});

async function worstCase(label, run) {
  await run();
  assert.ok(calls.length >= 1, `${label} never called the model`);
  const c = calls[0];
  const tokens = llm.estimateTokens(c.system, c.prompt, c.maxOutputTokens, c.schema);
  assert.ok(
    tokens <= CEILING,
    `${label} estimates ${tokens} tokens at its worst case, over the ${CEILING} ceiling — ` +
    'it will be rejected before a request is sent'
  );
  assert.equal(calls.length, 1, `${label} needed ${calls.length} attempts; it should fit first time`);
  return tokens;
}

test('CV extraction fits at its worst case', async () => {
  await worstCase('CV extraction', () => cvExtractor.extract(OVERLONG));
});

test('routing fits at its worst case', async () => {
  // A long message block plus a full context window of long earlier messages.
  const context = Array.from({ length: 40 }, () => ({
    sent_at: new Date().toISOString(),
    body: 'z'.repeat(2000),
  }));
  await worstCase('routing', () => classifier.route({ text: OVERLONG, contextMessages: context }));
});

test('JD matching fits at its worst case', async () => {
  // Far more open roles than MATCH_JD_LIMIT would pass, each with a long
  // description and a dozen requirements, against a full-length CV.
  const jds = Array.from({ length: 30 }, (_, i) => ({
    external_id: `JD-${i}`,
    title: 'Head of Finance and Corporate Strategy',
    jd_text: 'y'.repeat(5000),
    requirements: Array(12).fill('a requirement of a fairly typical length'),
  }));
  await worstCase('JD matching', () => classifier.match({ text: OVERLONG, jds }));
});

test('talent suggestion fits at its worst case', async () => {
  // The shortlist is capped, so this stage cannot overflow today — but it is
  // the one caller that has no shrink path, so if a raised TALENT_SHORTLIST
  // ever pushes it over, it fails outright rather than degrading.
  const job = {
    title: 'Chief Financial Officer',
    company: 'A Company With A Fairly Long Name Limited',
    location: 'Bangalore',
    min_experience_years: 12,
    requirements: Array(12).fill('a requirement of a fairly typical length'),
    description: 'w'.repeat(10000),
  };
  const candidates = Array.from({ length: talentMatch.SHORTLIST_SIZE }, (_, i) => ({
    key: `CAND_${1000 + i}`,
    profile: 'p'.repeat(600),
  }));
  await worstCase('talent suggestion', () => talentMatch.score(job, candidates));
});

test('a budget with no room left reports it rather than returning a usable size', () => {
  // When the system prompt and the output reservation fill the ceiling between
  // them, no prompt of any length fits and shrinking cannot help. The caller
  // has to be able to tell that apart from "shrink a bit more", so the room
  // left goes non-positive rather than clamping to zero and looking sendable.
  const budget = llm.promptBudget({ system: 'x'.repeat(400), schema: null, maxOutputTokens: 9999 });
  assert.ok(budget.chars <= 0);
  assert.ok(budget.fixedTokens > CEILING);
  assert.equal(budget.ceiling, CEILING);
});

test('no ceiling configured means no shrinking', () => {
  // Gemini's tier has no TPM limit worth pacing, and its default is 0. A
  // budget of Infinity is how callers read "send it whole".
  const gemini = require('node:child_process').execFileSync(
    process.execPath,
    ['-e', [
      'process.env.LLM_PROVIDER = "gemini";',
      'delete process.env.LLM_MAX_TPM;',
      'const llm = require("./src/services/llm");',
      'const b = llm.promptBudget({ system: "x", schema: null, maxOutputTokens: 1024 });',
      'console.log(b.chars === Infinity ? "infinite" : String(b.chars));',
    ].join('')],
    { cwd: require('node:path').join(__dirname, '..'), encoding: 'utf8' }
  );
  assert.equal(gemini.trim(), 'infinite');
});
