/**
 * Reads a salary the way it is actually written down.
 *
 * A recruiter types "24 LPA", not 2400000, and nobody should be asked to enter
 * both. So the number the filters compare against is derived from the string
 * rather than typed alongside it — one field to fill, and the two can never
 * disagree because only one of them is authored.
 *
 * The verbatim string is still what gets stored and shown: it is what a
 * candidate is quoted back, and it carries things a number cannot ("+ ESOPs",
 * "negotiable"). This produces the comparable figure beside it.
 *
 * Everything here is annual and in the smallest sensible whole unit — rupees,
 * not lakhs — so amounts stay comparable across the currencies this sees.
 */

/** Multipliers, longest key first so "lakhs" is matched before "l". */
const UNITS = [
  ['crores', 1e7], ['crore', 1e7], ['cr', 1e7],
  ['lakhs', 1e5], ['lakh', 1e5], ['lacs', 1e5], ['lac', 1e5],
  ['lpa', 1e5],
  ['million', 1e6], ['mn', 1e6],
  ['thousand', 1e3],
  // Single letters last, and only when they follow the number directly:
  // "18L" is eighteen lakhs, but the L in "SALARY" is not a unit.
  ['l', 1e5], ['k', 1e3], ['m', 1e6],
];

const CURRENCY_HINTS = [
  [/₹|\brs\.?\b|\binr\b|\brupees?\b|\blakhs?\b|\blacs?\b|\bcrores?\b|\blpa\b/i, 'INR'],
  [/\$|\busd\b|\bdollars?\b/i, 'USD'],
  [/£|\bgbp\b|\bpounds?\b/i, 'GBP'],
  [/€|\beur\b|\beuros?\b/i, 'EUR'],
  [/\baed\b|\bdirhams?\b/i, 'AED'],
  [/\bsgd\b/i, 'SGD'],
];

/**
 * @param {string} text  a salary as written
 * @returns {{amount: number|null, currency: string|null}}
 */
function parse(text) {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) return { amount: null, currency: null };

  const currency = (CURRENCY_HINTS.find(([pattern]) => pattern.test(raw)) || [])[1] || null;

  // The first number in the string. A range ("18-22 LPA") takes the lower end,
  // which is the conservative reading: it is the figure the candidate is
  // certainly on, and over-stating someone's salary prices them out of a role
  // they would have taken.
  const match = raw.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!match) return { amount: null, currency };

  const value = parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return { amount: null, currency };

  // What follows the number decides the scale. Only the text after it is
  // considered: "CTC 18" must not pick up a unit from the word before.
  const after = raw.replace(/,/g, '').slice(match.index + match[1].length).toLowerCase();
  let unit = UNITS.find(([name]) => new RegExp(`^\\s*${name}\\b`).test(after));

  // A range states its unit once, at the end: "18-22 LPA" is eighteen lakhs to
  // twenty-two, not eighteen rupees. The unit is looked for past the rest of
  // the range — but ONLY past a range separator, so a stray "lakh" later in a
  // sentence cannot multiply an already-complete figure by 100,000.
  if (!unit) {
    const range = after.match(/^\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?\s*(.*)$/);
    if (range) {
      unit = UNITS.find(([name]) => new RegExp(`^${name}\\b`).test(range[1]));
    }
  }

  const multiplier = unit ? unit[1] : 1;
  const amount = Math.round(value * multiplier * 100) / 100;

  // A bare number too small to be an annual salary is ambiguous, not small:
  // "18" almost certainly means 18 lakhs, but it could mean 18 dollars an hour,
  // and a salary wrong by a factor of 100,000 is quoted to a candidate before
  // anyone notices. Left null, the string still shows; guessed, it silently
  // sorts them into the wrong band.
  if (!unit && amount < 1000) return { amount: null, currency };

  // The same upper guard the extractor applies: past this it is a parse
  // failure, not a salary.
  if (amount > 1e11) return { amount: null, currency };

  // Lakhs and crores are only used for rupees, so "18L" states its currency
  // by stating its unit even though it never writes ₹ or INR.
  const INDIAN_UNITS = new Set(['crores', 'crore', 'cr', 'lakhs', 'lakh', 'lacs', 'lac', 'lpa', 'l']);
  const impliedCurrency = currency || (unit && INDIAN_UNITS.has(unit[0]) ? 'INR' : null);

  return { amount, currency: impliedCurrency };
}

module.exports = { parse };
