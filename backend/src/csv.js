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

/**
 * `YYYY-MM-DD HH:MM`, not an ISO instant.
 *
 * Excel and Sheets parse this as a real date and will sort and filter on it.
 * They read "2026-08-25T07:34:41.227Z" as text, which is why an exported
 * "Added" column looked like a machine identifier rather than a date and could
 * not be sorted by.
 *
 * Rendered in the server's timezone (set TZ on the container to match the
 * team's), so an upload logged at 13:04 exports as 13:04.
 */
function timestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function cell(value) {
  if (value === null || value === undefined) return '';

  let text;
  if (Array.isArray(value)) text = value.join('; ');
  else if (value instanceof Date) text = timestamp(value);
  else text = String(value);

  text = defuse(text);

  // Quote when the value contains anything that would otherwise break the row,
  // doubling any quotes inside it.
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {Array<{key: string, label: string, map?: Record<string, string>}>} columns
 *   `map` renames stored values for the reader — a status column holding
 *   'manual' is a schema detail, and the spreadsheet is read by people who
 *   never saw the schema. Unmapped values pass through unchanged rather than
 *   becoming blank, so a value added later still shows up.
 * @param {Array<object>} rows
 */
function toCsv(columns, rows) {
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const value = row[c.key];
          return cell(c.map && c.map[value] !== undefined ? c.map[value] : value);
        })
        .join(',')
    );
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
