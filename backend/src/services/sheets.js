const { google } = require('googleapis');
const fs = require('fs');

let cachedData = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function getAuthClient() {
  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyEnv) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not set');

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

function isDummyMode() {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  return !spreadsheetId || spreadsheetId === 'dummy' || !keyEnv || keyEnv === '{}';
}

function invalidateCache() {
  cachedData = null;
  cacheExpiry = 0;
}

async function deleteRowFromSheet(sheets, spreadsheetId, sheetName, idValue) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A:A`,
  });
  const rows = response.data.values || [];
  const rowIndex = rows.findIndex((row, i) => i > 0 && row[0] === idValue);
  if (rowIndex === -1) return false;

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: sheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex,
            endIndex: rowIndex + 1,
          },
        },
      }],
    },
  });
  return true;
}

async function deleteJD(id) {
  if (isDummyMode()) {
    await fetchAllData();
    const idx = cachedData.jds.findIndex((j) => j.JD_ID === id);
    if (idx === -1) return false;
    cachedData.jds.splice(idx, 1);
    cachedData.applicants = cachedData.applicants.filter((a) => a.JD_ID !== id);
    return true;
  }

  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const deleted = await deleteRowFromSheet(sheets, spreadsheetId, 'JD_Master', id);
  if (deleted) invalidateCache();
  return deleted;
}

async function deleteApplicant(id) {
  if (isDummyMode()) {
    await fetchAllData();
    const idx = cachedData.applicants.findIndex((a) => a.Applicant_ID === id);
    if (idx === -1) return false;
    cachedData.applicants.splice(idx, 1);
    return true;
  }

  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const deleted = await deleteRowFromSheet(sheets, spreadsheetId, 'Applicants', id);
  if (deleted) invalidateCache();
  return deleted;
}

async function fetchSheetRange(sheets, spreadsheetId, range) {
  const response = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const rows = response.data.values || [];
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((row) =>
    headers.reduce((obj, header, i) => {
      obj[header] = row[i] !== undefined ? row[i] : '';
      return obj;
    }, {})
  );
}

async function fetchAllData(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedData && now < cacheExpiry) {
    return cachedData;
  }

  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const keyEnv = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  // Fall back to mock data when no real credentials are configured
  const isDummy =
    !spreadsheetId ||
    spreadsheetId === 'dummy' ||
    !keyEnv ||
    keyEnv === '{}';

  if (isDummy) {
    const { jds, applicants } = require('./mockData');
    cachedData = { jds, applicants };
    cacheExpiry = now + CACHE_TTL_MS;
    return cachedData;
  }

  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth });

  const [jds, applicants] = await Promise.all([
    fetchSheetRange(sheets, spreadsheetId, 'JD_Master!A:E'),
    fetchSheetRange(sheets, spreadsheetId, 'Applicants!A:K'),
  ]);

  cachedData = { jds, applicants };
  cacheExpiry = now + CACHE_TTL_MS;
  return cachedData;
}

module.exports = { fetchAllData, deleteJD, deleteApplicant };
