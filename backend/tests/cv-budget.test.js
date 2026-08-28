/**
 * What a CV extraction costs before it is sent, and what happens when it is
 * still too big.
 *
 * A provider meters tokens-per-minute against the RESERVED output budget, not
 * the generated one, so the output cap is charged in full on every request. At
 * a 3072-token cap the reservation plus the system prompt left under 2000
 * tokens for the CV itself, and ordinary two-page CVs were rejected by our own
 * limiter before a call was made — surfacing in the uploader as "could not be
 * read", which reads as an unreadable file rather than a budget we set.
 */
const test = require('node:test');
const assert = require('node:assert');

// A token ceiling has to be in force for any of this to mean anything, and the
// default is per-provider: 6000 on an OpenAI-compatible endpoint, 0 (disabled)
// on Gemini. Set before llm.js is required, since it reads env at load.
process.env.LLM_PROVIDER = 'groq';
process.env.LLM_MAX_TPM = '6000';

// Patched before cvExtractor loads, because the shrink loop it borrows from
// classifier.js destructures generateJson at require time.
const llm = require('../src/services/llm');

const calls = [];
let respond = () => ({ data: { name: 'Asha', notes: '' }, model: 'fake', usage: null });
llm.generateJson = async (args) => {
  calls.push(args);
  return respond(calls.length);
};

const cvExtractor = require('../src/services/cvExtractor');

const CEILING = 6000;
// Longer than the extractor's own character budget, so the prompt it builds is
// the largest one it can ever build. If this fits, every real CV does.
const HUGE_CV = 'x'.repeat(40000);

function estimate(call) {
  return llm.estimateTokens(call.system, call.prompt, call.maxOutputTokens, call.schema);
}

test.beforeEach(() => {
  calls.length = 0;
  respond = () => ({ data: { name: 'Asha', notes: '' }, model: 'fake', usage: null });
});

test('the estimate counts the schema the provider is actually sent', () => {
  // On an OpenAI-compatible endpoint the schema is appended to the system
  // prompt, because response_format guarantees valid JSON but not the right
  // shape. Those are metered characters — over a thousand of them for the CV
  // schema — and leaving them out biased every reservation low, in the one
  // direction that earns a 429.
  const wire = llm.wireSystem(cvExtractor.SYSTEM, cvExtractor.SCHEMA);
  assert.ok(
    wire.length > cvExtractor.SYSTEM.length + 1000,
    'the schema should be part of what gets counted'
  );
  assert.ok(
    llm.estimateTokens(cvExtractor.SYSTEM, '', 1536, cvExtractor.SCHEMA) >
      llm.estimateTokens(cvExtractor.SYSTEM, '', 1536, null)
  );
});

test('a CV filling the whole character budget still fits in one request', async () => {
  await cvExtractor.extract(HUGE_CV);

  assert.equal(calls.length, 1, 'it should fit first time, not after a rejection');
  const tokens = estimate(calls[0]);
  assert.ok(
    tokens <= CEILING,
    `largest possible CV request estimates ${tokens} tokens, over the ${CEILING} ceiling`
  );

  // The specific thing that used to break it: the same prompt reserving the
  // old 3072 output tokens does not fit, which is the whole bug.
  assert.ok(
    llm.estimateTokens(calls[0].system, calls[0].prompt, 3072, calls[0].schema) > CEILING
  );
});

test('the prompt is fitted to the ceiling, not halved down to it', async () => {
  // Halving throws away up to half a CV to save the few hundred characters
  // that were over. Fitting keeps the work history that halving would drop.
  await cvExtractor.extract(HUGE_CV);
  const tokens = estimate(calls[0]);
  assert.ok(
    tokens > CEILING * 0.7,
    `only used ${tokens} of ${CEILING} tokens — the CV was trimmed further than it needed to be`
  );
});

test('a shorter CV is not trimmed at all', async () => {
  const cv = 'Asha Menon\nCFO at Acme.\n'.repeat(40);
  await cvExtractor.extract(cv);
  assert.ok(
    calls[0].prompt.includes(cv),
    'a CV comfortably under the ceiling should be sent whole'
  );
});

test('a rejection from the provider re-sends shorter rather than failing', async () => {
  // The configured ceiling is our arithmetic; the provider has the real one.
  // Half a CV read is a candidate in the database. Nothing read is a file the
  // recruiter has to notice and handle by hand.
  respond = (n) => {
    if (n === 1) throw new Error('TOKEN_LIMIT 429 Request too large, please reduce your message size');
    return { data: { name: 'Asha', notes: '' }, model: 'fake', usage: null };
  };

  const out = await cvExtractor.extract(HUGE_CV);

  assert.equal(out.name, 'Asha');
  assert.equal(calls.length, 2);
  assert.ok(
    calls[1].prompt.length < calls[0].prompt.length,
    'the retry re-rendered the CV at the same length instead of shrinking it'
  );
});

test('a rejection that shrinking cannot fix is reported, not retried forever', async () => {
  respond = () => {
    throw new Error('TOKEN_LIMIT 429 Request too large, please reduce your message size');
  };

  await assert.rejects(() => cvExtractor.extract(HUGE_CV), /TOKEN_LIMIT/);
  assert.equal(calls.length, 3, 'the shrink loop should give up after three attempts');
});

test('an empty document costs no model call at all', async () => {
  const out = await cvExtractor.extract('   ');
  assert.equal(calls.length, 0);
  assert.match(out.notes, /No readable text/);
});
