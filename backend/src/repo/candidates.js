const { query } = require('../db');
const notesRepo = require('./notes');
const { parse: parseSalary } = require('../services/salary');

/**
 * Uploaded CVs and hand-entered candidates. Nothing in the WhatsApp pipeline
 * writes here — that side has its own tables, and keeping the two apart is the
 * point of this one.
 */

// file_data and raw_text are deliberately absent: one is the whole document
// and the other is megabytes of bytes, and a list of 200 candidates would
// carry both on every row. `has_file` is the part a list actually needs —
// whether there is something to open.
const FIELDS = `
  c.id, c.external_id, c.file_name, c.file_size, c.mime_type,
  c.name, c.email, c.phone, c.current_company, c.current_designation, c.location,
  c.age, c.qualifications, c.experience_years,
  c.salary_text, c.salary_amount, c.salary_currency,
  c.domain_expertise, c.skills, c.company_listing_status,
  c.employee_type, c.referred_by,
  c.extraction_model, c.extraction_version, c.extraction_notes,
  c.entry_mode, (c.file_data IS NOT NULL) AS has_file,
  c.uploaded_by, c.created_at, c.updated_at`;

// Notes live in one table shared by every record that carries them, so the
// fragments that fold them into a column come from there rather than being
// spelled out again here.
const NOTES_AGGREGATE = `${notesRepo.aggregate('candidate', 'c')} AS notes`;
const NOTE_COUNT = `${notesRepo.countSubquery('candidate', 'c')} AS note_count`;

/**
 * When this candidate was last seen and when they are next due.
 *
 * A talent pool sorted by "Added" answers when a CV arrived, which stops being
 * the useful question the moment somebody has been met: from then on what
 * matters is whether they have gone quiet. These are the two dates that say
 * so, and they belong on the list rather than one click into each person —
 * "who have I not spoken to since March" is a question about the whole pool.
 *
 * Correlated subqueries rather than a join, matching how note counts are done
 * here already, so adding them cannot multiply rows.
 *
 * Split on now() rather than on status: a meeting that has happened has
 * happened whether or not anyone closed it, and reading the last contact off
 * an unclosed future booking would date it wrongly in the one direction that
 * makes somebody look attended-to when they are not.
 */
const MEETING_DATES = `
  (SELECT COUNT(*)::int FROM meetings m WHERE m.candidate_id = c.id)
    AS meeting_count,
  (SELECT MAX(m.scheduled_at) FROM meetings m
    WHERE m.candidate_id = c.id AND m.scheduled_at <  now()) AS last_meeting_at,
  (SELECT MIN(m.scheduled_at) FROM meetings m
    WHERE m.candidate_id = c.id AND m.scheduled_at >= now()) AS next_meeting_at`;

const WHERE_FILTERS = `
  ($1::text IS NULL OR (
     c.name                ILIKE '%' || $1 || '%' OR
     c.current_company     ILIKE '%' || $1 || '%' OR
     c.current_designation ILIKE '%' || $1 || '%' OR
     c.location            ILIKE '%' || $1 || '%' OR
     c.email               ILIKE '%' || $1 || '%' OR
     c.phone               ILIKE '%' || $1 || '%' OR
     -- Sectors and skills are what people type into a search box expecting to
     -- find someone, exactly as they would a company name. ::text matches
     -- inside the array without a join.
     c.domain_expertise::text ILIKE '%' || $1 || '%' OR
     c.skills::text ILIKE '%' || $1 || '%'
   ))
   AND ($2::numeric IS NULL OR c.experience_years >= $2)
   -- A candidate with no salary on record is excluded from a salary filter
   -- rather than assumed to fall inside it. "Under 25 LPA" is a claim about
   -- what we know, and an unknown salary is not evidence of a low one.
   AND ($3::numeric IS NULL OR (c.salary_amount IS NOT NULL AND c.salary_amount >= $3))
   AND ($4::numeric IS NULL OR (c.salary_amount IS NOT NULL AND c.salary_amount <= $4))
   AND ($5::text IS NULL OR c.company_listing_status = $5)
   -- Domain and skill filters match any element, case-insensitively and on a
   -- substring: someone searching "finance" should find "Corporate Finance"
   -- rather than only an exact tag. jsonb_array_elements_text unpacks the
   -- array so ILIKE applies per entry rather than to the whole JSON blob,
   -- which would also match the punctuation between entries.
   AND ($6::text IS NULL OR EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(c.domain_expertise) d
          WHERE d ILIKE '%' || $6 || '%'))
   AND ($7::text IS NULL OR EXISTS (
         SELECT 1 FROM jsonb_array_elements_text(c.skills) sk
          WHERE sk ILIKE '%' || $7 || '%'))
   -- Exact, not a substring: this is a two-value classification, and somebody
   -- nobody has classified yet is left out of both sides rather than quietly
   -- counted into one of them.
   AND ($8::text IS NULL OR c.employee_type = $8)`;

// The filters occupy $1..$8; a caller that also paginates continues from $9.
const FILTER_PARAM_COUNT = 8;

function filterValues({
  search, minExperience, salaryFrom, salaryTo, listingStatus, domain, skill,
  employeeType,
} = {}) {
  return [
    search || null, minExperience ?? null,
    salaryFrom ?? null, salaryTo ?? null,
    listingStatus || null, domain || null, skill || null,
    employeeType || null,
  ];
}

async function create(fields, client) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run(
    `INSERT INTO candidates
       (external_id, file_name, file_size, mime_type, raw_text, file_data,
        name, email, phone, current_company, current_designation, location,
        age, qualifications, experience_years,
        extraction_model, extraction_version, extraction_notes,
        entry_mode, uploaded_by,
        salary_text, salary_amount, salary_currency,
        domain_expertise, skills, company_listing_status,
        employee_type, referred_by)
     VALUES ('pending',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
             $20,$21,$22,$23,$24,$25,$26,$27)
     RETURNING id`,
    [
      fields.fileName || null,
      fields.fileSize || null,
      fields.mimeType || null,
      fields.rawText || '',
      fields.fileData || null,
      fields.name || null,
      fields.email || null,
      fields.phone || null,
      fields.currentCompany || null,
      fields.currentDesignation || null,
      fields.location || null,
      fields.age || null,
      JSON.stringify(fields.qualifications || []),
      fields.experienceYears === null || fields.experienceYears === undefined
        ? null
        : fields.experienceYears,
      fields.extractionModel || null,
      fields.extractionVersion || null,
      fields.extractionNotes || null,
      fields.entryMode === 'manual' ? 'manual' : 'upload',
      fields.uploadedBy || null,
      fields.salaryText || null,
      fields.salaryAmount === null || fields.salaryAmount === undefined
        ? null
        : fields.salaryAmount,
      fields.salaryCurrency || null,
      JSON.stringify(fields.domainExpertise || []),
      JSON.stringify(fields.skills || []),
      fields.companyListingStatus || null,
      fields.employeeType || null,
      // Only the non-elite side carries one. An elite candidate is here on
      // their own record, and the column has a constraint saying so.
      fields.employeeType === 'non_elite' ? fields.referredBy || null : null,
    ]
  );
  // Derived from the serial id, as JDs are, so the identifier is stable and
  // readable in an exported spreadsheet.
  const { rows: updated } = await run(
    `UPDATE candidates c SET external_id = 'CAND_' || (1000 + c.id) WHERE c.id = $1
      RETURNING ${FIELDS}`,
    [rows[0].id]
  );
  return updated[0];
}

/**
 * @param {object} opts
 * @param {string} [opts.search]  matches name, company, designation, location
 * @param {number} [opts.minExperience]
 * @param {number} [opts.salaryFrom]  annual, in whatever currency is stored
 * @param {number} [opts.salaryTo]
 * @param {string} [opts.listingStatus] 'listed' | 'unlisted'
 * @param {string} [opts.domain]      matches any one sector, as a substring
 * @param {string} [opts.skill]       matches any one skill, as a substring
 * @param {string} [opts.employeeType] 'elite' | 'non_elite'
 * @param {boolean} [opts.withNotes]  fold every note into one column
 */
async function list({
  search, minExperience, salaryFrom, salaryTo, listingStatus, domain, skill,
  employeeType, withNotes = false, limit = 200, offset = 0,
} = {}) {
  const { rows } = await query(
    `SELECT ${FIELDS},
            ${withNotes ? NOTES_AGGREGATE : NOTE_COUNT},
            ${MEETING_DATES}
       FROM candidates c
      WHERE ${WHERE_FILTERS}
      ORDER BY c.created_at DESC
      LIMIT $${FILTER_PARAM_COUNT + 1} OFFSET $${FILTER_PARAM_COUNT + 2}`,
    [...filterValues({
       search, minExperience, salaryFrom, salaryTo, listingStatus, domain, skill, employeeType,
     }),
     limit, offset]
  );
  return rows;
}

async function count(filters = {}) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS count FROM candidates c WHERE ${WHERE_FILTERS}`,
    filterValues(filters)
  );
  return rows[0].count;
}

/**
 * The last ten digits of a phone number, which is what makes two of them the
 * same person.
 *
 * '+91 98765 43210', '098765 43210' and '9876543210' are one number written
 * three ways, and comparing the strings says they are three people. Ten digits
 * is the subscriber number everywhere this is used; anything shorter is
 * compared whole rather than padded, so a four-digit extension never collides
 * with a real number that happens to end in it.
 */
function phoneKey(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits ? digits.slice(-10) : null;
}

/**
 * The candidate already in the pool with this email or this phone number, if
 * there is one.
 *
 * Email and phone identify a person here; names repeat and titles change. When
 * either matches, it is the same person arriving a second time — a CV
 * re-uploaded months later, a referral typed in by someone who did not know
 * they were already on file — and a second row would split their notes,
 * meetings and match history across two profiles that neither of them can see.
 *
 * `excludeId` is the row being edited, so correcting a typo in somebody's own
 * email does not report them as a duplicate of themselves.
 */
async function findDuplicate({ email, phone, excludeId = null } = {}) {
  const normalisedEmail = email ? String(email).trim().toLowerCase() : null;
  const key = phoneKey(phone);
  if (!normalisedEmail && !key) return null;

  const { rows } = await query(
    `SELECT c.external_id, c.name, c.email, c.phone,
            ($1::text IS NOT NULL AND lower(btrim(c.email)) = $1) AS email_matched
       FROM candidates c
      WHERE ($3::bigint IS NULL OR c.id <> $3)
        AND (
          ($1::text IS NOT NULL AND lower(btrim(c.email)) = $1)
          OR
          ($2::text IS NOT NULL AND c.phone IS NOT NULL
             AND right(regexp_replace(c.phone, '\\D', '', 'g'), 10) = $2)
        )
      ORDER BY c.id
      LIMIT 1`,
    [normalisedEmail, key, excludeId]
  );
  return rows[0] || null;
}

/** How to tell somebody they are already here, naming the field that matched. */
function duplicateMessage(duplicate) {
  const who = duplicate.name ? `${duplicate.name} (${duplicate.external_id})` : duplicate.external_id;
  const field = duplicate.email_matched ? 'email address' : 'phone number';
  return `That ${field} is already in the talent pool — ${who}. Open that profile instead of adding a second one.`;
}

async function findByExternalId(externalId) {
  const { rows } = await query(
    `SELECT ${FIELDS}, c.raw_text, ${MEETING_DATES}
       FROM candidates c WHERE c.external_id = $1`,
    [externalId]
  );
  return rows[0] || null;
}

async function findById(id) {
  const { rows } = await query(
    `SELECT ${FIELDS}, c.raw_text FROM candidates c WHERE c.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/**
 * The stored document itself.
 *
 * Its own query rather than a column on the reads above: this is the one place
 * that wants the bytes, and every other caller would be paying to carry a 15MB
 * buffer it immediately discards.
 */
async function fileFor(externalId) {
  const { rows } = await query(
    `SELECT file_name, mime_type, file_size, file_data
       FROM candidates WHERE external_id = $1`,
    [externalId]
  );
  const row = rows[0];
  if (!row || !row.file_data) return null;
  return row;
}

/** Corrects a field the extraction got wrong. Recruiters will always need this. */
/**
 * Attaches a CV to a candidate who has none, or replaces the one on file.
 *
 * Deliberately does NOT re-extract the fields. A candidate reached this state
 * either by being entered by hand or by being corrected since upload, and both
 * mean somebody has typed what they know into those columns. Re-running
 * extraction over a newly attached file would overwrite that with a model's
 * reading of it, which is the one thing an "attach the CV" button must not do.
 *
 * raw_text is filled only when it is empty, so a candidate who had no readable
 * CV gains the text view without an existing one being replaced.
 */
async function attachFile(externalId, { fileName, fileSize, mimeType, fileData, rawText }) {
  const { rows } = await query(
    `UPDATE candidates
        SET file_name  = $2,
            file_size  = $3,
            mime_type  = $4,
            file_data  = $5,
            raw_text   = CASE
                           WHEN COALESCE(btrim(raw_text), '') = '' THEN COALESCE($6, raw_text)
                           ELSE raw_text
                         END,
            updated_at = now()
      WHERE external_id = $1
      RETURNING id`,
    [externalId, fileName, fileSize ?? null, mimeType || null, fileData, rawText || null]
  );
  return rows[0] ? findByExternalId(externalId) : null;
}

async function update(externalId, fields) {
  // The comparable figure follows the string it came from. Nobody types the
  // annual number any more — there is one salary field on screen — so editing
  // "24 LPA" to "30 LPA" has to move the amount the filters compare, or the
  // candidate keeps ranking against a salary they no longer have.
  if (fields.salaryText !== undefined && fields.salaryAmount === undefined) {
    const parsed = parseSalary(fields.salaryText || '');
    fields = { ...fields, salaryAmount: parsed.amount, salaryCurrency: parsed.currency };
  }

  const allowed = {
    name: 'name',
    email: 'email',
    phone: 'phone',
    currentCompany: 'current_company',
    currentDesignation: 'current_designation',
    location: 'location',
    age: 'age',
    experienceYears: 'experience_years',
    qualifications: 'qualifications',
    salaryText: 'salary_text',
    salaryAmount: 'salary_amount',
    salaryCurrency: 'salary_currency',
    domainExpertise: 'domain_expertise',
    skills: 'skills',
    companyListingStatus: 'company_listing_status',
    employeeType: 'employee_type',
  };

  const sets = [];
  const values = [externalId];
  // Remembered as it is pushed rather than looked up afterwards: the value can
  // legitimately be null, and searching `values` for it would find whichever
  // other field happened to be cleared in the same request.
  let employeeTypeParam = null;
  for (const [key, column] of Object.entries(allowed)) {
    if (fields[key] === undefined) continue;
    const isJson = ['qualifications', 'domainExpertise', 'skills'].includes(key);
    values.push(isJson ? JSON.stringify(fields[key] || []) : fields[key]);
    sets.push(`${column} = $${values.length}${isJson ? '::jsonb' : ''}`);
    if (key === 'employeeType') employeeTypeParam = values.length;
  }

  // referred_by is not in `allowed` because it cannot be set on its own: it
  // belongs to the non-elite side, and the column has a constraint saying so.
  // Reclassifying someone as elite while leaving their referrer behind would
  // both violate that constraint and credit a referral that no longer exists.
  //
  // So the two are written as one decision, against whichever employee_type
  // the row will actually have when this update lands — the new one when it is
  // being changed, the stored one when only the referrer is.
  if (fields.employeeType !== undefined || fields.referredBy !== undefined) {
    const typeExpr = employeeTypeParam ? `$${employeeTypeParam}::text` : 'c.employee_type';
    let referrerExpr = 'c.referred_by';
    if (fields.referredBy !== undefined) {
      values.push(fields.referredBy || null);
      // Cast because the other arm of the CASE is a bare NULL, which leaves
      // the parameter with no type for Postgres to infer.
      referrerExpr = `$${values.length}::text`;
    }
    sets.push(
      `referred_by = CASE WHEN ${typeExpr} = 'non_elite' THEN ${referrerExpr} ELSE NULL END`
    );
  }

  if (sets.length === 0) return findByExternalId(externalId);

  const { rows } = await query(
    `UPDATE candidates c SET ${sets.join(', ')}, updated_at = now()
      WHERE c.external_id = $1
      RETURNING ${FIELDS}`,
    values
  );
  return rows[0] || null;
}

async function remove(externalId) {
  const { rows } = await query(
    'DELETE FROM candidates WHERE external_id = $1 RETURNING id',
    [externalId]
  );
  return rows[0] || null;
}

module.exports = {
  create, list, count, findByExternalId, findById, fileFor, attachFile, update, remove,
  findDuplicate, duplicateMessage, phoneKey,
};
