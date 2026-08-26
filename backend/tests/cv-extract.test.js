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

test('a salary is annual, or it is nothing', () => {
  // The two failures that actually happen: a figure read in the wrong unit
  // ("18" for 18 lakhs), and a lakhs-vs-rupees confusion inflating by 10^5.
  // A salary wrong by that much is quoted to a candidate before anyone checks.
  assert.equal(sanitise({ salary_amount: 1800000 }).salaryAmount, 1800000);
  assert.equal(sanitise({ salary_amount: 18 }).salaryAmount, null);
  assert.equal(sanitise({ salary_amount: 1.8e12 }).salaryAmount, null);
  assert.equal(sanitise({ salary_amount: 'eighteen lakhs' }).salaryAmount, null);
});

test('a currency without an amount is dropped', () => {
  // "INR" on its own is a fact about pay that carries no pay, and would sort
  // and filter as though a salary were known.
  assert.equal(sanitise({ salary_currency: 'INR' }).salaryCurrency, null);
  assert.equal(sanitise({ salary_amount: 1800000, salary_currency: 'inr' }).salaryCurrency, 'INR');
  // A model asked for a code will sometimes answer in prose.
  assert.equal(sanitise({ salary_amount: 1800000, salary_currency: 'rupees' }).salaryCurrency, null);
  assert.equal(sanitise({ salary_amount: 1800000, salary_currency: 'Rs' }).salaryCurrency, null);
});

test('the salary a CV states is kept verbatim beside the number', () => {
  // The recruiter quotes this string back to the candidate, so it must survive
  // whatever the normalisation makes of it.
  const out = sanitise({ salary_text: 'Rs. 22,00,000 + ESOPs', salary_amount: 2200000 });
  assert.equal(out.salaryText, 'Rs. 22,00,000 + ESOPs');
  assert.equal(out.salaryAmount, 2200000);
});

test('domains are deduplicated and bounded', () => {
  // A model reading two employers in the same sector lists it twice, and a
  // runaway list is a parse failure rather than a career.
  assert.deepEqual(
    sanitise({ domain_expertise: ['BFSI', 'bfsi', ' BFSI ', 'Manufacturing'] }).domainExpertise,
    ['BFSI', 'Manufacturing']
  );
  assert.equal(sanitise({ domain_expertise: Array(20).fill().map((_, i) => `S${i}`) }).domainExpertise.length, 8);
  assert.deepEqual(sanitise({ domain_expertise: 'BFSI' }).domainExpertise, []);
  assert.deepEqual(sanitise({ domain_expertise: ['N/A', ''] }).domainExpertise, []);
});

test('listing status is one of two values or unknown', () => {
  // Null is the common and correct answer, and must stay distinguishable from
  // "we established it is unlisted" — every role that screens on this depends
  // on the difference.
  assert.equal(sanitise({ company_listing_status: 'Listed' }).companyListingStatus, 'listed');
  assert.equal(sanitise({ company_listing_status: 'UNLISTED' }).companyListingStatus, 'unlisted');
  assert.equal(sanitise({ company_listing_status: 'probably listed' }).companyListingStatus, null);
  assert.equal(sanitise({ company_listing_status: 'public' }).companyListingStatus, null);
  assert.equal(sanitise({}).companyListingStatus, null);
});
