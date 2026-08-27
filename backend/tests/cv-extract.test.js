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

test('the salary number is derived from the string, not asked for separately', () => {
  // The model is given one salary field. Asking it for the string AND the
  // number invited the two to disagree — "24 LPA" alongside 24 — with no way
  // to tell which half was wrong. Now there is only one authored value.
  const out = sanitise({ salary_text: '18 LPA' });
  assert.equal(out.salaryText, '18 LPA');
  assert.equal(out.salaryAmount, 1800000);
  assert.equal(out.salaryCurrency, 'INR');
});

test('a number the model volunteers anyway is ignored', () => {
  // salary_amount is no longer in the schema. If a model sends one regardless
  // it must not override the parse of the string the recruiter actually reads.
  const out = sanitise({ salary_text: '18 LPA', salary_amount: 18, salary_currency: 'USD' });
  assert.equal(out.salaryAmount, 1800000);
  assert.equal(out.salaryCurrency, 'INR');
});

test('an unparseable salary keeps its text and drops the number', () => {
  // "Negotiable" is worth showing a recruiter and worth nothing to a filter,
  // and a filter must not invent a figure to sort it by.
  const out = sanitise({ salary_text: 'Negotiable' });
  assert.equal(out.salaryText, 'Negotiable');
  assert.equal(out.salaryAmount, null);
  assert.equal(out.salaryCurrency, null);
});

test('the salary a CV states is kept verbatim beside the number', () => {
  // The recruiter quotes this string back to the candidate, so it must survive
  // whatever the normalisation makes of it.
  const out = sanitise({ salary_text: 'Rs. 22,00,000 + ESOPs' });
  assert.equal(out.salaryText, 'Rs. 22,00,000 + ESOPs');
  assert.equal(out.salaryAmount, 2200000);
});

test('skills are deduplicated but not shortlisted', () => {
  assert.deepEqual(
    sanitise({ skills: ['Kubernetes', 'kubernetes', ' Kubernetes ', 'IFRS'] }).skills,
    ['Kubernetes', 'IFRS']
  );
  // A long skills section is a normal CV, not a parse failure. This used to
  // stop at ten, which quietly threw away most of what a full-stack or an ERP
  // CV lists — and a skill that is not stored cannot be searched for.
  assert.equal(sanitise({ skills: Array(40).fill().map((_, i) => `S${i}`) }).skills.length, 40);
  // The cap that remains is only a guard against a model repeating itself.
  assert.equal(sanitise({ skills: Array(200).fill().map((_, i) => `S${i}`) }).skills.length, 100);
  assert.deepEqual(sanitise({ skills: 'Kubernetes' }).skills, []);
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
