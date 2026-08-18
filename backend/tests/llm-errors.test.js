/**
 * Pins the two provider-error rules that failed silently in production.
 *
 * Both are single regexes whose wrong answer is indistinguishable from their
 * right one at a glance: one decides whether to shrink a prompt or wait out a
 * window, the other decides whether "wait" means one second or thirty-one.
 * They are pinned against the provider's real response bodies, verbatim.
 */
const test = require('node:test');
const assert = require('node:assert');

const llm = require('../src/services/llm');

// Verbatim from Groq. The two differ by a phrase, not by status or shape:
// both name the TPM limit, both say "Requested", and both arrived as 429.
const GROQ_TOO_LARGE =
  '{"error":{"message":"Request too large for model `openai/gpt-oss-120b` in ' +
  'organization `org_x` service tier `on_demand` on tokens per minute (TPM): ' +
  'Limit 8000, Requested 8222, please reduce your message size and try again.",' +
  '"type":"tokens","code":"rate_limit_exceeded"}}';

const GROQ_WINDOW_EXHAUSTED =
  '{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in ' +
  'organization `org_x` service tier `on_demand` on tokens per minute (TPM): ' +
  'Limit 8000, Used 7311, Requested 4824. Please try again in 31.0125s.",' +
  '"type":"tokens","code":"rate_limit_exceeded"}}';

test('an oversized request is told apart from an exhausted window', () => {
  assert.equal(llm.isOversizedRequest(429, GROQ_TOO_LARGE), true);
  assert.equal(llm.isOversizedRequest(429, GROQ_WINDOW_EXHAUSTED), false);
});

test('413 is oversized whatever the body says', () => {
  assert.equal(llm.isOversizedRequest(413, ''), true);
});

test('an unrecognised error waits rather than shrinking', () => {
  // Shrinking on a real rate limit spends quota reproducing the failure and
  // degrades the prompt; waiting on an oversized one only costs a pause.
  assert.equal(llm.isOversizedRequest(429, 'service unavailable'), false);
  assert.equal(llm.isOversizedRequest(500, ''), false);
});

test('the server-stated wait is honoured in both phrasings', () => {
  // Groq says it in prose; missing this backed off ~1s into a 31s window.
  const groq = llm.serverRetryDelayMs(GROQ_WINDOW_EXHAUSTED);
  assert.ok(groq >= 31000 && groq <= 32000, `expected ~31s, got ${groq}`);

  const gemini = llm.serverRetryDelayMs('{"retryDelay":"52s"}');
  assert.ok(gemini >= 52000 && gemini <= 53000, `expected ~52s, got ${gemini}`);

  assert.equal(llm.serverRetryDelayMs('no delay stated'), null);
});
