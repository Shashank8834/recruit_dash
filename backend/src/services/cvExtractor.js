const { clip, generateShrinking } = require('./classifier');
const { parse: parseSalary } = require('./salary');

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
// found and re-run by that fact alone. cv-v3 and earlier kept only ten skills,
// so a CV listing thirty was stored with two thirds of it missing; re-running
// those is the only way to recover the rest.
const EXTRACTION_VERSION = 'cv-v4';

// A CV's identity fields sit at the top, but total experience can only be
// judged from the whole work history, so this budget is generous compared to
// the router's. ~12k characters is about 3k tokens, which leaves room under a
// free tier's per-minute ceiling.
const CV_CHARS = parseInt(process.env.CV_EXTRACT_CHARS || '12000', 10);
// The unused headroom is NOT free, which is what 3072 got wrong. Output is
// billed on what is generated, but it is METERED on what is reserved: the
// provider counts the whole max_tokens against tokens-per-minute the moment the
// request arrives. At 3072 the reservation alone was more than half a 6000-TPM
// ceiling, and with the ~1100-token system prompt on top, any CV past roughly
// seven thousand characters was rejected before a call was made — which is why
// perfectly ordinary two-page CVs came back as "could not be read".
//
// 1536 leaves room for the whole schema: a hundred skills, eight domains and
// every identity field is well under a thousand tokens even before the model
// starts padding. If a genuinely enormous CV does truncate the reply, llm.js
// doubles the cap and retries, so the ceiling is a starting point rather than
// a hard limit.
const CV_OUTPUT_TOKENS = parseInt(process.env.CV_EXTRACT_OUTPUT_TOKENS || '1536', 10);

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
  A monthly figure should be written as the CV writes it; say in notes that it
  is monthly, so the reader is not misled into treating it as annual.
- skills: what the candidate can DO — "Kubernetes", "IFRS", "treasury
  management", "Python", "SAP FICO". Take them from the skills section and
  from what the work history says they actually did. Not job titles, not
  employers, not sectors, not soft qualities like "team player".
  List EVERY distinct skill the CV names. There is no limit and no shortlist:
  a recruiter searches this field for one specific skill, and a skill you left
  out because it looked minor is a candidate who cannot be found at all. Work
  through the skills section in full — including every tool, technology,
  framework, language, standard and platform in it — then add what the work
  history shows them doing that the section omitted. Most relevant first, so
  the important ones still read first. Do not merge several skills into one
  string ("Python, Java, SQL" is three entries, not one), do not invent skills
  the CV does not evidence, and return an empty array when it never says.
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
    skills: { type: 'array', items: { type: 'string' } },
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

  // Deduplicated case-insensitively because a model that reads two employers in
  // the same sector, or a skill listed twice, will happily repeat it — and
  // capped, because a runaway list is a parse failure rather than a career.
  // The cap is a guard against a model that has started repeating itself, not
  // an editorial limit: it is set well above any real CV, so it never decides
  // which of a candidate's skills are worth keeping.
  function cleanList(values, limit) {
    const out = [];
    const seen = new Set();
    for (const raw of Array.isArray(values) ? values : []) {
      const value = text(raw);
      if (!value || value.length > 60) continue;
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
      if (out.length === limit) break;
    }
    return out;
  }

  const domains = cleanList(data.domain_expertise, 8);
  // Every skill the CV names, not the ten the model likes best. Ten looked
  // tidy and was wrong: a full-stack CV lists that many technologies before it
  // reaches the databases, and a skill that was dropped here is invisible to
  // both the search box and the shortlist prefilter that ranks on this column.
  const skills = cleanList(data.skills, 100);

  // The comparable figure is DERIVED from the string rather than asked for
  // separately. A model given two fields for one fact will sometimes disagree
  // with itself — "24 LPA" alongside 24 — and there is no way to tell which
  // half is wrong. One authored value, one parse, and they cannot drift.
  const salaryText = text(data.salary_text);
  const salary = parseSalary(salaryText || '');

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
    salaryText,
    salaryAmount: salary.amount,
    salaryCurrency: salary.amount === null ? null : salary.currency,
    skills,
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

  // Shrinking rather than a fixed clip, for the same reason the matcher does
  // it: the ceiling is a property of the provider tier, not of this code, so a
  // budget that fits today fails on a smaller key tomorrow. A rejection
  // re-renders the CV shorter instead of ending the upload — half a CV read is
  // a candidate in the database, missing some of the older roles. Nothing read
  // is a file the recruiter has to notice and handle by hand.
  const build = (scale) => `# CV\n${clip(rawText, Math.floor(CV_CHARS * scale), 'CV')}`;
  const { data, model, usage } = await generateShrinking({
    system: SYSTEM,
    schema: SCHEMA,
    build,
    label: 'CV extraction',
    maxOutputTokens: CV_OUTPUT_TOKENS,
  });

  return { ...sanitise(data), model, version: EXTRACTION_VERSION, usage };
}

module.exports = { extract, sanitise, EXTRACTION_VERSION, SYSTEM, SCHEMA };
