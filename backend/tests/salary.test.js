/**
 * Reading a salary the way it is written.
 *
 * This is the only thing standing between "24 LPA" and a filter that can
 * compare it, so the cases here are the ones a recruitment inbox actually
 * contains — and the ones where getting it wrong is expensive rather than
 * merely untidy.
 */
const test = require('node:test');
const assert = require('node:assert');

const { parse } = require('../src/services/salary');

test('Indian conventions annualise to rupees', () => {
  assert.deepEqual(parse('24 LPA'), { amount: 2400000, currency: 'INR' });
  assert.deepEqual(parse('Rs. 15 lakhs'), { amount: 1500000, currency: 'INR' });
  assert.deepEqual(parse('12 lacs'), { amount: 1200000, currency: 'INR' });
  assert.deepEqual(parse('1.2 Cr'), { amount: 12000000, currency: 'INR' });
  // Indian digit grouping: 22,00,000 is twenty-two lakhs, not twenty-two
  // thousand. Stripping separators before parsing is what makes that work.
  assert.deepEqual(parse('₹22,00,000'), { amount: 2200000, currency: 'INR' });
});

test('a unit states the currency even when no symbol is written', () => {
  // Lakhs and crores are only used for rupees, so "18L" says INR by saying L.
  assert.deepEqual(parse('18L'), { amount: 1800000, currency: 'INR' });
  // "k" is not Indian-specific and must not imply a currency.
  assert.deepEqual(parse('950k'), { amount: 950000, currency: null });
});

test('other currencies are recognised and left un-multiplied', () => {
  assert.deepEqual(parse('$120,000'), { amount: 120000, currency: 'USD' });
  assert.deepEqual(parse('£85,000'), { amount: 85000, currency: 'GBP' });
  assert.deepEqual(parse('AED 400,000'), { amount: 400000, currency: 'AED' });
});

test('a range takes the lower end, with the unit stated at the far end', () => {
  // "18-22 LPA" states its unit once. Reading the 18 without looking past the
  // range for the unit gave eighteen rupees, which then failed the plausibility
  // floor and dropped the salary entirely.
  assert.deepEqual(parse('18-22 LPA'), { amount: 1800000, currency: 'INR' });
  assert.deepEqual(parse('18 to 22 lakhs'), { amount: 1800000, currency: 'INR' });
  assert.deepEqual(parse('30–35 LPA'), { amount: 3000000, currency: 'INR' });
});

test('a unit later in the sentence cannot rescale a complete figure', () => {
  // The range lookahead must not become a general search: this string contains
  // "lakh", and multiplying by it would report a 12 lakh salary as 12 billion.
  assert.deepEqual(
    parse('1200000 rupees for 5 lakh shares'),
    { amount: 1200000, currency: 'INR' }
  );
});

test('a bare number too small to be a salary is left unparsed', () => {
  // "18" almost certainly means 18 lakhs, but it could be an hourly rate, and
  // a salary wrong by a factor of 100,000 reaches the candidate before anyone
  // checks. The text still shows; only the comparable number is withheld.
  assert.equal(parse('18').amount, null);
  assert.equal(parse('CTC 20').amount, null);
  // With a unit there is no ambiguity to protect against.
  assert.equal(parse('18 lakhs').amount, 1800000);
});

test('what is not a salary yields nothing', () => {
  for (const value of ['', '   ', 'Negotiable', 'As per industry standards', null, undefined, 42]) {
    assert.equal(parse(value).amount, null, JSON.stringify(value));
  }
});

test('an absurd figure is a parse failure, not a salary', () => {
  assert.equal(parse('50000 crore').amount, null);
});

test('extra words around the figure do not stop it being read', () => {
  assert.deepEqual(parse('25 LPA + bonus'), { amount: 2500000, currency: 'INR' });
  assert.deepEqual(parse('INR 30 lakh per annum'), { amount: 3000000, currency: 'INR' });
  assert.deepEqual(parse('Current CTC: 1,80,000'), { amount: 180000, currency: null });
});
