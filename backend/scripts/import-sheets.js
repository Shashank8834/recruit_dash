#!/usr/bin/env node
/**
 * One-time import of the existing Google Sheet into Postgres.
 *
 * Historical rows have no raw WhatsApp messages behind them, so each imported
 * applicant gets a synthetic submission holding the message text as it was
 * stored. Their classifications are tagged model='imported:sheet' so you can
 * tell them apart from anything the pipeline produced — and exclude them from
 * accuracy measurements, where they'd be noise.
 *
 *   npm run import:sheets           # dry run, prints what it would do
 *   npm run import:sheets -- --write
 */
require('dotenv').config();

const { google } = require('googleapis');
const fs = require('fs');
const { pool, query, withTransaction } = require('../src/db');
const { migrate } = require('../src/db/migrate');

const WRITE = process.argv.includes('--write');

function authClient() {
  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyEnv) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');
  let credentials;
  try {
    credentials = JSON.parse(keyEnv);
  } catch {
    credentials = JSON.parse(fs.readFileSync(keyEnv, 'utf8'));
  }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function readSheet(sheets, spreadsheetId, range) {
  const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) =>
    headers.reduce((obj, h, i) => {
      obj[h] = row[i] !== undefined ? row[i] : '';
      return obj;
    }, {})
  );
}

function toDate(unixish) {
  const n = parseInt(unixish, 10);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

const VALID_VERDICTS = new Set([
  'STRONG', 'PARTIAL', 'WEAK', 'NONE', 'NEEDS_REVIEW', 'UNKNOWN',
]);

async function importJds(rows) {
  const idMap = new Map();
  for (const row of rows) {
    const externalId = row.JD_ID;
    if (!externalId) continue;

    const existing = await query('SELECT id FROM jds WHERE external_id = $1', [externalId]);
    if (existing.rows.length) {
      idMap.set(externalId, existing.rows[0].id);
      continue;
    }
    if (!WRITE) {
      console.log(`  would insert JD ${externalId}`);
      continue;
    }
    const { rows: inserted } = await query(
      `INSERT INTO jds (external_id, posted_by, jd_text, status, posted_at)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [
        externalId,
        row.Posted_By || null,
        row.JD_Text || '',
        row.Status === 'closed' ? 'closed' : 'open',
        toDate(row.Date),
      ]
    );
    idMap.set(externalId, inserted[0].id);
  }
  return idMap;
}

async function importApplicants(rows, jdIdMap) {
  let imported = 0;
  let skipped = 0;

  for (const row of rows) {
    const phone = (row.Phone || '').replace(/\s+/g, '') || null;
    const verdict = VALID_VERDICTS.has(row.Result) ? row.Result : 'UNKNOWN';
    const jdId = jdIdMap.get(row.JD_ID) || null;
    const createdAt = toDate(row.Date);

    if (!WRITE) {
      console.log(`  would import ${row.Applicant_ID} (${verdict})`);
      imported += 1;
      continue;
    }

    try {
      await withTransaction(async (client) => {
        let contactId = null;
        if (phone) {
          const { rows: c } = await client.query(
            `INSERT INTO contacts (phone, push_name, name, email)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (phone) DO UPDATE
               SET name  = COALESCE(contacts.name, EXCLUDED.name),
                   email = COALESCE(contacts.email, EXCLUDED.email)
             RETURNING id`,
            [phone, row.Sender || null, row.Name || null, row.Email || null]
          );
          contactId = c[0].id;
        }

        const { rows: s } = await client.query(
          `INSERT INTO submissions
             (chat_id, contact_id, combined_text, kind, status,
              window_start, window_end, created_at, classified_at)
           VALUES ($1,$2,$3,'application','classified',$4,$4,$4,$4)
           RETURNING id`,
          [phone ? `${phone}@imported` : 'imported', contactId, row.Message || '', createdAt]
        );

        await client.query(
          `INSERT INTO classifications
             (submission_id, jd_id, verdict, reason, model, prompt_version, created_at)
           VALUES ($1,$2,$3,$4,'imported:sheet','imported',$5)`,
          [s[0].id, jdId, verdict, row.Reason || null, createdAt]
        );
      });
      imported += 1;
    } catch (err) {
      console.error(`  failed ${row.Applicant_ID}: ${err.message}`);
      skipped += 1;
    }
  }
  return { imported, skipped };
}

(async () => {
  await migrate();

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  if (!spreadsheetId) throw new Error('GOOGLE_SHEET_ID is not set');

  const sheets = google.sheets({ version: 'v4', auth: authClient() });
  const [jdRows, applicantRows] = await Promise.all([
    readSheet(sheets, spreadsheetId, 'JD_Master!A:E'),
    readSheet(sheets, spreadsheetId, 'Applicants!A:K'),
  ]);

  console.log(`Read ${jdRows.length} JDs and ${applicantRows.length} applicants from the sheet.`);
  if (!WRITE) console.log('DRY RUN — re-run with --write to apply.\n');

  const jdIdMap = await importJds(jdRows);
  const result = await importApplicants(applicantRows, jdIdMap);

  console.log(
    `\nJDs: ${jdIdMap.size} mapped. Applicants: ${result.imported} imported, ${result.skipped} skipped.`
  );
  if (WRITE) {
    console.log('Imported rows are tagged model="imported:sheet".');
  }
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
