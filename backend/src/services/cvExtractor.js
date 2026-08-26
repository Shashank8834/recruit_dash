const { generateJson } = require('./llm');
const { clip } = require('./classifier');

/**
 * Pulls structured fields out of an uploaded CV.
 *
 * Deliberately separate from classifier.js. That file answers "what is this
 * WhatsApp message and which role does it fit"; this one answers "who is this
 * person", on a document a recruiter chose to upload. Sharing a prompt would
 * mean every change to one had to be re-evaluated against the other, and the
 * two have different failure modes: a misrouted message costs a review, a
 * wrong phone number costs a call to a stranger.
 */
// Bumped with the prompt: `backfill --reclassify` selects by version, so a CV
// extracted under cv-v1 has no salary, domain or listing status and can be
// found and re-run by that fact alone.
const EXTRACTION_VERSION = 'cv-v2';

// A CV's identity fields sit at the top, but total experience can only be
// judged from the whole work history, so this budget is generous compared to
// the router's. ~12k characters is about 3k tokens, which leaves room under a
// free tier's per-minute ceiling.
const CV_CHARS = parseInt(process.env.CV_EXTRACT_CHARS || '12000', 10);
const CV_OUTPUT_TOKENS = parseInt(process.env.CV_EXTRACT_OUTPUT_TOKENS || '1024', 10);

const SYSTEM = `You extract structured details from a candidate's CV.

Return only what the document states. This data goes into a recruiter's
database and is used to contact people, so an invented phone number or a
guessed employer is worse than an empty field. Every field is optional: when
the CV does not say, return null.

Field notes, in the order they cause mistakes:

- name: the candidate's own name. CVs often open with a letterhead, a referee,
  or the name of a university; none of those are the candidate.
- email / phone: copy them character for character. Do not reformat, do not
  strip or add country codes, do not correct what looks like a typo.
- current_company / current_designation: the role they hold NOW. If the most
  recent entry has an end date, they have left it — that is their most recent
  role, not their current one, and current_company should then be null. Prefer
  an entry marked "present", "current", or with no end date.
- location: where the candidate is based, not where an employer is
  headquartered and not a willingness to relocate.
- age: only if the CV states an age or a date of birth. Do NOT derive it from
  a graduation year — people study at every age, and this field is used in
  decisions about them.
- qualifications: degrees, diplomas and professional certifications, each as
  one string, most recent first. Not skills, not courses, not employers.
- experience_years: total professional experience in years, one decimal place.
  If the CV states a total, use it. Otherwise add up the work history, counting
  overlapping roles once and excluding internships and training unless that is
  the entirety of their experience. For a fresher with no professional roles,
  return 0 rather than null — zero experience is a fact, an unreadable work
  history is not.
- salary_text: the candidate's CURRENT or most recent salary, copied as the CV
  writes it — "18 LPA", "Rs. 22,00,000", "£85,000 + bonus". Keep the wording;
  it is what a recruiter quotes back. If the CV gives only an EXPECTED salary,
  use that and say so in notes. If it gives neither, null — a salary is
  negotiated on, and a guessed one poisons the negotiation.
- salary_amount: the same figure as a plain ANNUAL number, with no separators
  and no unit. "18 LPA" is 1800000. "Rs. 22,00,000" is 2200000. "£85,000" is
  85000. A monthly figure is multiplied by 12; an hourly rate is not
  annualised at all — return null, because the hours are unknown. If the CV
  states a range, use the lower end. Null whenever salary_text is null or too
  vague to convert.
- salary_currency: the three-letter code for salary_amount — INR, USD, GBP,
  AED. LPA, lakhs, crores and ₹ all mean INR. Null if no currency is stated
  or implied.
- domain_expertise: the SECTORS the candidate has worked in, not their skills
  and not their job titles. "BFSI", "Manufacturing", "Healthcare", "SaaS",
  "Retail", "Logistics". Take them from who their employers are and what the
  CV says those businesses do. Two or three is normal; an empty array is the
  right answer when the CV never makes the sector clear. Never put a
  technology, a tool or a function here.
- company_listing_status: "listed" if the CURRENT employer is a publicly
  traded company, "unlisted" if it is private, a partnership, a startup, a
  government body or a non-profit. Only answer when the CV says so or the
  employer is unambiguously one or the other — a well-known listed company
  counts as unambiguous. Null when you are unsure, which will be often;
  guessing here silently mis-sorts a candidate for every role that screens on
  it.

If the document is not a CV at all — a job description, a cover letter with no
history, an unreadable scan — set every field to null and say so in notes.`;

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' },
    current_company: { type: 'string' },
    current_designation: { type: 'string' },
    location: { type: 'string' },
    age: { type: 'number' },
    qualifications: { type: 'array', items: { type: 'string' } },
    experience_years: { type: 'number' },
    salary_text: { type: 'string' },
    salary_amount: { type: 'number' },
    salary_currency: { type: 'string' },
    domain_expertise: { type: 'array', items: { type: 'string' } },
    company_listing_status: { type: 'string', enum: ['listed', 'unlisted'] },
    notes: {
      type: 'string',
      description: 'Anything that made extraction uncertain; empty if clean.',
    },
  },
  required: ['name', 'notes'],
};

/**
 * The model returns JSON, which says nothing about whether the values are
 * usable. These checks reject the specific ways this extraction goes wrong.
 */
function sanitise(data) {
  const text = (v) => {
    if (typeof v !== 'string') return null;
    const trimmed = v.trim();
    // Models fill unknown fields with these rather than returning null.
    if (!trimmed || /^(n\/?a|none|null|unknown|not (stated|specified|provided))$/i.test(trimmed)) {
      return null;
    }
    return trimmed;
  };

  // A CV cannot belong to someone 12 or 99 years old; a number outside this
  // range means a year, a phone fragment or a postcode was read as an age.
  const age = Number.isFinite(data.age) && data.age >= 14 && data.age <= 90
    ? Math.round(data.age)
    : null;

  // 60 years of experience is a parse error, not a career. Zero is kept: it is
  // the correct, meaningful answer for a fresher.
  const years = Number.isFinite(data.experience_years) &&
    data.experience_years >= 0 && data.experience_years <= 60
    ? Math.round(data.experience_years * 10) / 10
    : null;

  const qualifications = Array.isArray(data.qualifications)
    ? data.qualifications.map(text).filter(Boolean)
    : [];

  // Sectors, not skills. Deduplicated case-insensitively because a model that
  // reads two employers in the same sector will happily list it twice, and
  // capped because a runaway list is a parse failure rather than a career.
  const domains = [];
  const seenDomains = new Set();
  for (const raw of Array.isArray(data.domain_expertise) ? data.domain_expertise : []) {
    const value = text(raw);
    if (!value || value.length > 60) continue;
    const key = value.toLowerCase();
    if (seenDomains.has(key)) continue;
    seenDomains.add(key);
    domains.push(value);
    if (domains.length === 8) break;
  }

  // An annual salary, or nothing. The bounds reject the two failures that
  // actually happen: a figure read in the wrong unit ("18" for 18 lakhs, or a
  // stray year), and a lakhs-vs-rupees confusion that inflates by 10^5. Both
  // land far outside any real annual salary in any currency this sees, and a
  // salary wrong by a factor of a hundred thousand is quoted to a candidate
  // before anyone notices.
  const salaryAmount =
    Number.isFinite(data.salary_amount) &&
    data.salary_amount >= 1000 &&
    data.salary_amount <= 1e11
      ? Math.round(data.salary_amount * 100) / 100
      : null;

  // Three letters, uppercased. A model asked for a code will sometimes answer
  // "Rs" or "rupees"; those are not codes, and a currency column holding prose
  // cannot be compared against anything.
  const rawCurrency = text(data.salary_currency);
  const salaryCurrency =
    rawCurrency && /^[A-Za-z]{3}$/.test(rawCurrency) ? rawCurrency.toUpperCase() : null;

  // A number with no currency is still useful — the text beside it says what it
  // is. A currency with no number is not, and would sort as a fact about pay
  // that carries no pay.
  const listing = text(data.company_listing_status);
  const listingStatus =
    listing && ['listed', 'unlisted'].includes(listing.toLowerCase())
      ? listing.toLowerCase()
      : null;

  return {
    name: text(data.name),
    email: text(data.email),
    phone: text(data.phone),
    currentCompany: text(data.current_company),
    currentDesignation: text(data.current_designation),
    location: text(data.location),
    age,
    qualifications,
    experienceYears: years,
    salaryText: text(data.salary_text),
    salaryAmount,
    salaryCurrency: salaryAmount === null ? null : salaryCurrency,
    domainExpertise: domains,
    companyListingStatus: listingStatus,
    notes: text(data.notes),
  };
}

async function extract(rawText) {
  if (!rawText || rawText.trim().length < 40) {
    // Short-circuit rather than spend a model call. A file this empty is a
    // failed text extraction — a scanned image, or a PDF of pictures — and the
    // useful answer is to say so, not to have a model guess at nothing.
    return {
      ...sanitise({}),
      notes: 'No readable text in the document — it may be a scan or an image-only PDF.',
      model: null,
      version: EXTRACTION_VERSION,
      usage: null,
    };
  }

  const prompt = `# CV\n${clip(rawText, CV_CHARS, 'CV')}`;
  const { data, model, usage } = await generateJson({
    system: SYSTEM,
    prompt,
    schema: SCHEMA,
    maxOutputTokens: CV_OUTPUT_TOKENS,
  });

  return { ...sanitise(data), model, version: EXTRACTION_VERSION, usage };
}

module.exports = { extract, sanitise, EXTRACTION_VERSION, SYSTEM, SCHEMA };
