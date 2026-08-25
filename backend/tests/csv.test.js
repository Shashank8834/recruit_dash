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

test('a timestamp exports as something a spreadsheet can sort', () => {
  // An ISO instant ("2026-08-25T07:34:41.227Z") is read as text by Excel and
  // Sheets, which is why an exported date column could not be sorted on.
  const rendered = cell(new Date(2026, 7, 25, 13, 4, 41));
  assert.equal(rendered, '2026-08-25 13:04');
  assert.ok(!rendered.includes('T'), 'no ISO separator');
  assert.ok(!rendered.includes('Z'), 'no zone suffix');
});

test('stored values are renamed for whoever reads the sheet', () => {
  const columns = [
    { key: 'entry_mode', label: 'Entered via', map: { upload: 'CV upload', manual: 'By hand' } },
  ];
  const rows = [{ entry_mode: 'manual' }, { entry_mode: 'upload' }, { entry_mode: 'imported' }];
  const lines = toCsv(columns, rows).trim().split('\r\n');

  assert.deepEqual(lines.slice(1), ['By hand', 'CV upload', 'imported']);
});

test('a value with no mapping is passed through, not blanked', () => {
  // A stage added to the database before this list is updated must still
  // appear. Silently emptying the cell would look like missing data.
  const columns = [{ key: 'status', label: 'Stage', map: { open: 'Open' } }];
  const [, row] = toCsv(columns, [{ status: 'reviewing' }]).trim().split('\r\n');
  assert.equal(row, 'reviewing');
});

test('notes spanning several lines survive as one cell', () => {
  const columns = [
    { key: 'external_id', label: 'ID' },
    { key: 'notes', label: 'Notes' },
  ];
  const notes = '2026-08-25 Akhilesh: Referred by Priya.\n2026-08-26: Wants hybrid.';
  const csv = toCsv(columns, [{ external_id: 'CAND_1001', notes }]);

  assert.ok(csv.includes(`"${notes}"`), 'the whole note block stays in one quoted cell');
  // Two notes, one row: the row terminator is CRLF and the note breaks are not.
  assert.equal(csv.trimEnd().split('\r\n').length, 2);
});
