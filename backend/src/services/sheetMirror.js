const { google } = require('googleapis');
const fs = require('fs');
const { query } = require('../db');

/**
 * Postgres is the source of truth. This module keeps the Google Sheet as a
 * read-only mirror for anyone still working in it.
 *
 * The sync is a full rewrite rather than a per-row patch. At recruitment
 * volumes that costs one API call per sheet, and it makes an entire class of
 * drift bug impossible: the sheet cannot disagree with the database, because
 * it is regenerated from it. The queue table survives as a change log and a
 * dirty flag.
 */

const JD_HEADERS = ['JD_ID', 'Date', 'Posted_By', 'JD_Text', 'Status'];
const APPLICANT_HEADERS = [
  'Applicant_ID', 'JD_ID', 'Date', 'Sender', 'Message',
  'Result', 'Reason', 'Phone', 'Email', 'Name', 'Confidence',
];

function isEnabled() {
  const id = process.env.GOOGLE_SHEET_ID;
  const key = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  return Boolean(id && id !== 'dummy' && key && key !== '{}');
}

function getAuthClient() {
  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  let credentials;
  try {
    credentials = JSON.parse(keyEnv);
  } catch {
    if (fs.existsSync(keyEnv)) {
      credentials = JSON.parse(fs.readFileSync(keyEnv, 'utf8'));
    } else {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY must be valid JSON or a path to a JSON file');
    }
  }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

/** Marks the mirror dirty. Cheap, and doubles as an audit trail of changes. */
async function enqueue(entity, entityId, op = 'upsert') {
  if (!isEnabled()) return null;
  const { rows } = await query(
    `INSERT INTO sheet_sync_queue (entity, entity_id, op)
     VALUES ($1,$2,$3) RETURNING *`,
    [entity, entityId, op]
  );
  return rows[0];
}

async function pendingCount() {
  const { rows } = await query(
    'SELECT COUNT(*)::int AS count FROM sheet_sync_queue WHERE synced_at IS NULL'
  );
  return rows[0].count;
}

/**
 * Google Sheets rejects a cell over 50,000 characters — and rejects the WHOLE
 * write when it does.
 *
 * Because the sync is a full rewrite of both sheets, one oversized row does not
 * degrade the mirror, it stops it dead: every subsequent sync fails on the same
 * cell, the queue never drains, and the sheet silently freezes at whatever it
 * held before. A pasted CV in a forwarded WhatsApp message gets there easily —
 * the row that did it in practice was 124,276 characters.
 *
 * So the cell is trimmed rather than the write abandoned. Postgres holds the
 * full text and the dashboard renders it; the sheet is explicitly a read-only
 * convenience mirror, so losing the tail of one message there costs far less
 * than losing every row.
 */
const CELL_LIMIT = 50000;
const TRUNCATION_NOTE = '… [truncated — full text in the dashboard]';

/**
 * Applied to every cell rather than to the two columns known to be long. The
 * one that overflows is never the one you expected — a name field pasted into
 * by a bot, a reason a model returned at length — and a guard that lists
 * columns has to be remembered again each time a column is added.
 */
function fitCell(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  if (text.length <= CELL_LIMIT) return text;
  return text.slice(0, CELL_LIMIT - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
}

function toSheetDate(value) {
  if (!value) return '';
  return String(Math.floor(new Date(value).getTime() / 1000));
}

async function buildJdRows() {
  const { rows } = await query(
    `SELECT external_id, posted_at, posted_by, jd_text, status
       FROM jds ORDER BY id ASC`
  );
  return rows.map((r) => [
    r.external_id,
    toSheetDate(r.posted_at),
    r.posted_by || '',
    r.jd_text || '',
    r.status,
  ]);
}

async function buildApplicantRows() {
  const { rows } = await query(
    `SELECT external_id, jd_external_id, created_at, sender, message,
            result, reason, phone, email, name, confidence
       FROM applicant_rows
      ORDER BY classification_id ASC`
  );
  return rows.map((r) => [
    r.external_id,
    r.jd_external_id || 'NONE',
    toSheetDate(r.created_at),
    r.sender || '',
    r.message || '',
    r.result,
    r.reason || '',
    r.phone || '',
    r.email || '',
    r.name || '',
    r.confidence === null ? '' : String(r.confidence),
  ]);
}

async function writeSheet(sheets, spreadsheetId, sheetName, headers, rows) {
  // Trimmed here, at the one place every row passes through, rather than in
  // each builder — a second builder added later is then covered by default
  // instead of by whoever remembers.
  let truncated = 0;
  const values = [headers, ...rows].map((row) => row.map((value) => {
    const fitted = fitCell(value);
    if (typeof value === 'string' && fitted.length < value.length) truncated += 1;
    return fitted;
  }));

  // Said out loud. A mirror that quietly shortens what it copies is worse than
  // one that fails, because nobody knows to go and read the original.
  if (truncated > 0) {
    console.warn(
      `[sheets] ${sheetName}: ${truncated} cell(s) over ${CELL_LIMIT} characters were truncated`
    );
  }

  // Clear beyond the written range so deleted records don't linger as ghosts.
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${sheetName}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

/**
 * Rewrites both sheets if anything is pending. Safe to call on a timer.
 * @returns {Promise<{synced:number}>}
 */
async function sync() {
  if (!isEnabled()) return { synced: 0, skipped: 'not configured' };

  const { rows: pending } = await query(
    'SELECT id FROM sheet_sync_queue WHERE synced_at IS NULL ORDER BY id ASC'
  );
  if (pending.length === 0) return { synced: 0 };

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = google.sheets({ version: 'v4', auth: getAuthClient() });

  const [jdRows, applicantRows] = await Promise.all([
    buildJdRows(),
    buildApplicantRows(),
  ]);

  try {
    await writeSheet(sheets, spreadsheetId, 'JD_Master', JD_HEADERS, jdRows);
    await writeSheet(sheets, spreadsheetId, 'Applicants', APPLICANT_HEADERS, applicantRows);
  } catch (err) {
    await query(
      `UPDATE sheet_sync_queue
          SET attempts = attempts + 1, last_error = $2
        WHERE id = ANY($1::bigint[])`,
      [pending.map((p) => p.id), String(err.message).slice(0, 500)]
    );
    throw err;
  }

  await query(
    `UPDATE sheet_sync_queue SET synced_at = now() WHERE id = ANY($1::bigint[])`,
    [pending.map((p) => p.id)]
  );

  return { synced: pending.length, jdRows: jdRows.length, applicantRows: applicantRows.length };
}

module.exports = { enqueue, sync, pendingCount, isEnabled, fitCell, CELL_LIMIT };
