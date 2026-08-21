/**
 * The guards on CV extraction.
 *
 * The model returns JSON, which says nothing about whether the values are
 * usable. These are the failures that would otherwise reach a recruiter's
 * database looking like facts.
 */
const test = require('node:test');
const assert = require('node:assert');

const { sanitise } = require('../src/services/cvExtractor');

test('placeholder strings become null, not text', () => {
  // Models fill unknown fields with these rather than returning null, and
  // "N/A" in a phone column is worse than an empty one: it looks populated.
  for (const placeholder of ['N/A', 'n/a', 'None', 'null', 'Unknown', 'not stated', '  ']) {
    assert.equal(sanitise({ phone: placeholder }).phone, null, placeholder);
  }
  assert.equal(sanitise({ phone: '+91 98765 43210' }).phone, '+91 98765 43210');
});

test('an implausible age is rejected rather than stored', () => {
  // A number outside a working lifetime means a year, a postcode or a phone
  // fragment was read as an age — and age is used in decisions about people.
  assert.equal(sanitise({ age: 2019 }).age, null);
  assert.equal(sanitise({ age: 0 }).age, null);
  assert.equal(sanitise({ age: 8 }).age, null);
  assert.equal(sanitise({ age: 34 }).age, 34);
  assert.equal(sanitise({ age: 34.6 }).age, 35);
});

test('zero years of experience is kept, but nonsense is not', () => {
  // Zero is the correct answer for a fresher — dropping it to null would make
  // "no professional experience" indistinguishable from "could not tell".
  assert.equal(sanitise({ experience_years: 0 }).experienceYears, 0);
  assert.equal(sanitise({ experience_years: 4.25 }).experienceYears, 4.3);
  assert.equal(sanitise({ experience_years: 61 }).experienceYears, null);
  assert.equal(sanitise({ experience_years: -2 }).experienceYears, null);
  assert.equal(sanitise({ experience_years: 'four' }).experienceYears, null);
});

test('qualifications are always a clean array', () => {
  assert.deepEqual(sanitise({ qualifications: ['B.Tech', ' ', 'N/A', 'MBA'] }).qualifications,
    ['B.Tech', 'MBA']);
  assert.deepEqual(sanitise({ qualifications: 'B.Tech' }).qualifications, []);
  assert.deepEqual(sanitise({}).qualifications, []);
});

test('an empty extraction yields all nulls rather than throwing', () => {
  const empty = sanitise({});
  assert.equal(empty.name, null);
  assert.equal(empty.age, null);
  assert.equal(empty.experienceYears, null);
});
