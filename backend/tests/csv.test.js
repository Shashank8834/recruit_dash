/**
 * CSV escaping, pinned against the values that actually break a spreadsheet.
 *
 * These rows come from real recruitment data: names contain commas, addresses
 * contain newlines, and a phone number written "+91..." is one character away
 * from something Excel treats as arithmetic.
 */
const test = require('node:test');
const assert = require('node:assert');

const { toCsv, cell } = require('../src/csv');

test('values that would break a row are quoted', () => {
  assert.equal(cell('Smith, John'), '"Smith, John"');
  assert.equal(cell('said "hi"'), '"said ""hi"""');
  assert.equal(cell('line1\nline2'), '"line1\nline2"');
  assert.equal(cell('plain'), 'plain');
});

test('formula injection is defused', () => {
  // A cell opening with =, +, - or @ is evaluated by Excel and Sheets. A CV
  // field is attacker-influenced text: it must never execute.
  for (const dangerous of ['=1+1', '+1', '-1', '@SUM(A1)', '=cmd|/c calc']) {
    assert.ok(
      cell(dangerous).startsWith('\t'),
      `${dangerous} should be prefixed with a tab`
    );
  }
  // A negative number still needs to survive as a readable value.
  assert.equal(cell('-5').replace('\t', ''), '-5');
});

test('empty and absent are the same in a spreadsheet', () => {
  assert.equal(cell(null), '');
  assert.equal(cell(undefined), '');
  // Zero is a real value — zero years of experience is a fact about a fresher.
  assert.equal(cell(0), '0');
});

test('arrays become one readable cell', () => {
  assert.equal(cell(['B.Tech', 'MBA']), 'B.Tech; MBA');
  assert.equal(cell([]), '');
});

test('a full export round-trips to the right shape', () => {
  const csv = toCsv(
    [{ key: 'name', label: 'Name' }, { key: 'years', label: 'Experience' }],
    [{ name: 'Ada', years: 4.5 }, { name: 'Grace, R', years: null }]
  );
  const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.deepEqual(lines, ['Name,Experience', 'Ada,4.5', '"Grace, R",']);
});
