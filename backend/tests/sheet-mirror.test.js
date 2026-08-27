/**
 * The cell limit, pinned against the row that actually broke the mirror.
 *
 * Google Sheets rejects the entire write when any one cell exceeds 50,000
 * characters, and the sync is a full rewrite — so a single forwarded CV froze
 * both sheets indefinitely rather than losing its own row. APP_126 was 124,276
 * characters when it happened.
 */
const test = require('node:test');
const assert = require('node:assert');

const { fitCell, CELL_LIMIT } = require('../src/services/sheetMirror');

test('a cell within the limit is passed through untouched', () => {
  assert.equal(fitCell('a normal message'), 'a normal message');
  assert.equal(fitCell('x'.repeat(CELL_LIMIT)), 'x'.repeat(CELL_LIMIT));
});

test('an oversized cell is trimmed to something Sheets will accept', () => {
  // The size that broke it in production.
  const pastedCv = 'x'.repeat(124276);
  const fitted = fitCell(pastedCv);

  assert.ok(fitted.length <= CELL_LIMIT, `${fitted.length} still exceeds the limit`);
  // One past the limit must also come back inside it — an off-by-one here is
  // the whole bug again, and it only shows up in production.
  assert.ok(fitCell('x'.repeat(CELL_LIMIT + 1)).length <= CELL_LIMIT);
});

test('a trimmed cell says it was trimmed', () => {
  const fitted = fitCell('x'.repeat(CELL_LIMIT * 2));
  assert.match(fitted, /truncated/);
  // Silent shortening is the failure mode this guards against: the mirror must
  // point at where the full text still lives.
  assert.match(fitted, /dashboard/);
});

test('the values a row builder actually emits survive', () => {
  // Builders emit '' for nulls and String(n) for numbers; nothing here should
  // be turned into "null" or "undefined" on its way to the sheet.
  assert.equal(fitCell(''), '');
  assert.equal(fitCell(null), '');
  assert.equal(fitCell(undefined), '');
  assert.equal(fitCell('0.82'), '0.82');
});
