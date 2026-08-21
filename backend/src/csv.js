/**
 * CSV generation.
 *
 * Written out rather than pulled from a package because the whole problem is
 * four rules, and the ones that matter are the ones a naive join misses:
 * embedded commas, embedded quotes, embedded newlines, and Excel's habit of
 * evaluating a leading =, +, - or @ as a formula.
 */

/**
 * Excel and Sheets treat a cell starting with =, +, - or @ as a formula, so a
 * candidate whose name or notes begin with one becomes an error or, worse, a
 * live reference. Prefixing a tab is the standard defusal: the cell displays
 * as written and is inert.
 */
function defuse(value) {
  return /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;
}

function cell(value) {
  if (value === null || value === undefined) return '';

  let text;
  if (Array.isArray(value)) text = value.join('; ');
  else if (value instanceof Date) text = value.toISOString();
  else text = String(value);

  text = defuse(text);

  // Quote when the value contains anything that would otherwise break the row,
  // doubling any quotes inside it.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {Array<{key: string, label: string}>} columns
 * @param {Array<object>} rows
 */
function toCsv(columns, rows) {
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => cell(row[c.key])).join(','));
  }
  // CRLF per RFC 4180, and a BOM so Excel reads it as UTF-8 rather than the
  // local codepage — without it, accented names arrive mangled.
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** Content-Disposition with a date, so successive exports do not overwrite. */
function filename(prefix) {
  const stamp = new Date().toISOString().slice(0, 10);
  return `${prefix}-${stamp}.csv`;
}

module.exports = { toCsv, cell, filename };
