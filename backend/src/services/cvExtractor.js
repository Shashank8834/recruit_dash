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
const EXTRACTION_VERSION = 'cv-v1';

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
