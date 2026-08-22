/**
 * Coercion of the model's verdict and confidence.
 *
 * These values go straight into columns with a CHECK constraint and a
 * NUMERIC(4,3) type. On an OpenAI-compatible provider nothing validates them
 * first — response_format guarantees valid JSON, not a valid shape, and
 * assertShape only checks top-level keys. So this is the last line before a
 * paid-for model call is thrown away by a constraint violation.
 */
const test = require('node:test');
const assert = require('node:assert');

const { coerceVerdict, coerceConfidence } = require('../src/services/talentMatch');

test('verdict casing and stray punctuation are accepted', () => {
  // Models routinely answer in lowercase despite an uppercase enum.
  assert.equal(coerceVerdict('strong'), 'STRONG');
  assert.equal(coerceVerdict(' Partial '), 'PARTIAL');
  assert.equal(coerceVerdict('"WEAK"'), 'WEAK');
  assert.equal(coerceVerdict('NONE'), 'NONE');
});

test('an invented verdict is rejected, not written', () => {
  // The column CHECK would reject these anyway — but by then the whole batch
  // has failed. Catching it here turns a lost run into one review item.
  for (const invented of ['EXCELLENT', 'GOOD FIT', '', null, undefined, 42]) {
    assert.equal(coerceVerdict(invented), null, String(invented));
  }
});

test('confidence given as a percentage is rescaled', () => {
  // 95 in a NUMERIC(4,3) column overflows; as a confidence it plainly means
  // 0.95, and a model that answers in percent is a recognisable mistake.
  assert.equal(coerceConfidence(0.93), 0.93);
  assert.equal(coerceConfidence(1), 1);
  assert.equal(coerceConfidence(0), 0);
  assert.equal(coerceConfidence(95), 0.95);
  assert.equal(coerceConfidence('0.8'), 0.8);
});

test('unusable confidence becomes null rather than a guess', () => {
  // A wrong confidence changes which candidates a human is told to review, so
  // no value is better than an invented one.
  for (const bad of ['high', null, undefined, NaN, -1, 1000]) {
    assert.equal(coerceConfidence(bad), null, String(bad));
  }
});

test('confidence is rounded to what the column can store', () => {
  // NUMERIC(4,3) keeps three decimals; more would be silently truncated.
  assert.equal(coerceConfidence(0.123456), 0.123);
});
