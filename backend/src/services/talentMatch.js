const { query } = require('../db');
const { generateJson } = require('./llm');
const { clip, applyConfidenceFloor } = require('./classifier');

/**
 * Suggests candidates for a hand-written role.
 *
 * The inverse of classifier.match, which scores one candidate against the open
 * roles. Here one role is scored against a pool of people, and that reversal is
 * what makes it expensive: the pool grows without bound while the role stays
 * fixed. Scoring every CV with a model call would cost hundreds of calls per
 * click, which on a metered tier is minutes of waiting for a list.
 *
 * So it runs in two stages, cheap before expensive:
 *
 *   1. Postgres full-text ranking narrows the pool to a shortlist. No model
 *      call, no token cost, and it is good at the easy part — a Node.js role
 *      should not be scored against a chartered accountant at all.
 *   2. One model call scores that shortlist, seeing compact profiles rather
 *      than whole CVs.
 *
 * Stage 1 can only reject on words, so it is deliberately generous: it passes
 * on more than is wanted and lets stage 2 judge. What it must not do is drop
 * someone a recruiter would have wanted to see, because they never reach the
 * model to be rescued.
 */
const PROMPT_VERSION = 'talent-v1';

const SHORTLIST_SIZE = parseInt(process.env.TALENT_SHORTLIST || '12', 10);
const PROFILE_CHARS = parseInt(process.env.TALENT_PROFILE_CHARS || '600', 10);
const JOB_CHARS = parseInt(process.env.TALENT_JOB_CHARS || '2500', 10);
const OUTPUT_TOKENS = parseInt(process.env.TALENT_OUTPUT_TOKENS || '1536', 10);

/** The words stage 1 ranks on: the role's title and what it asks for. */
function searchTerms(job) {
  const reqs = Array.isArray(job.requirements) ? job.requirements : [];
  return [job.title, ...reqs].filter(Boolean).join(' ').slice(0, 500);
}

/**
 * Ranks both pools against the role's text and returns the best few of each.
 *
 * Each pool is ranked and limited SEPARATELY, then merged. Ranking them
 * together would let whichever pool is larger take every slot — with 500
 * WhatsApp applicants against 20 uploaded CVs, one combined ordering would
 * return almost no uploads, and the uploads are the ones a recruiter chose
 * deliberately.
 */
async function shortlist(job, { limit = SHORTLIST_SIZE, includeWhatsapp = true } = {}) {
  const terms = searchTerms(job);
  const perPool = Math.max(1, Math.ceil(limit / (includeWhatsapp ? 2 : 1)));
  const minYears = job.min_experience_years === undefined ? null : job.min_experience_years;

  // A candidate whose experience could not be extracted is kept rather than
  // filtered out. An unreadable work history is not evidence of a junior
  // candidate, and silently excluding them would hide exactly the CVs whose
  // parsing needs attention.
  const { rows: manual } = await query(
    `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
     SELECT c.id, c.external_id, c.name, c.email, c.phone,
            c.current_company, c.current_designation, c.location,
            c.experience_years, c.qualifications, c.raw_text,
            ts_rank(
              to_tsvector('english',
                coalesce(c.current_designation,'') || ' ' ||
                coalesce(c.current_company,'')     || ' ' ||
                coalesce(c.qualifications::text,'')|| ' ' ||
                coalesce(c.raw_text,'')
              ), q.tsq
            ) AS rank
       FROM candidates c, q
      WHERE ($2::numeric IS NULL OR c.experience_years IS NULL OR c.experience_years >= $2)
      ORDER BY rank DESC, c.created_at DESC
      LIMIT $3`,
    [terms, minYears, perPool]
  );

  let whatsapp = [];
  if (includeWhatsapp) {
    // Only submissions the pipeline judged to be applications, and only the
    // live classification: a superseded verdict belongs to a fragment that was
    // folded into a later submission, so including it would list one person
    // twice.
    const { rows } = await query(
      `WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq)
       SELECT s.id AS submission_id,
              COALESCE(ct.name, ct.push_name) AS name,
              ct.email, ct.phone,
              s.combined_text,
              ts_rank(to_tsvector('english', coalesce(s.combined_text,'')), q.tsq) AS rank
         FROM submissions s, q
         LEFT JOIN contacts ct ON ct.id = s.contact_id
        WHERE s.kind = 'application'
          -- EXISTS, not a join: a submission can hold more than one live
          -- classification, and joining would put the same person in the
          -- shortlist twice — paying for them twice in the prompt and letting
          -- one candidate crowd out another.
          AND EXISTS (
            SELECT 1 FROM classifications cl
             WHERE cl.submission_id = s.id AND cl.is_current
          )
        ORDER BY rank DESC, s.created_at DESC
        LIMIT $2`,
      [terms, perPool]
    );
    whatsapp = rows;
  }

  const manualEntries = manual.map((c) => ({
    source: 'manual',
    key: c.external_id,
    candidateId: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    // A structured profile is cheaper and clearer than raw CV text: the fields
    // were already extracted, so re-sending the whole document would pay twice
    // for information we already hold.
    profile: [
      c.current_designation && `Current role: ${c.current_designation}`,
      c.current_company && `Company: ${c.current_company}`,
      c.location && `Location: ${c.location}`,
      c.experience_years !== null && `Experience: ${c.experience_years} years`,
      (c.qualifications || []).length && `Qualifications: ${c.qualifications.join(', ')}`,
      c.raw_text && `CV extract: ${clip(c.raw_text, PROFILE_CHARS, 'CV')}`,
    ].filter(Boolean).join('\n'),
    rank: Number(c.rank),
  }));

  const whatsappEntries = whatsapp.map((s) => ({
    source: 'whatsapp',
    key: `WA_${s.submission_id}`,
    submissionId: s.submission_id,
    name: s.name,
    email: s.email,
    phone: s.phone,
    profile: clip(s.combined_text, PROFILE_CHARS, 'message'),
    rank: Number(s.rank),
  }));

  return [...manualEntries, ...whatsappEntries].sort((a, b) => b.rank - a.rank);
}

const SYSTEM = `You shortlist candidates for a role a recruiter is hiring for.

You are given one role and several candidate profiles, each with a reference.
Score every candidate you are given and return one entry per reference —
including the poor fits. A recruiter needs to see that someone was considered
and rejected; a silently omitted candidate looks like one that was never found.

Verdicts:
- STRONG:  meets essentially all the stated requirements.
- PARTIAL: meets the core requirement with a real, nameable gap.
- WEAK:    adjacent background; would need substantial ramp-up.
- NONE:    not a sensible fit for this role.

Judge only what the profile states. Do not infer seniority from a job title
alone, do not assume unstated skills because related ones appear, and do not
penalise someone for omitting something the role does not ask for.

The profiles come from two places and differ in quality. Some are parsed CVs
with structured fields. Others are WhatsApp messages, which are short and
informal — a brief message is evidence of a brief message, not of a weak
candidate. Where a profile is too thin to judge, say so with low confidence
rather than guessing; those become review items instead of decisions.

Set confidence honestly. It decides what a human looks at.`;

const SCHEMA = {
  type: 'object',
  properties: {
    matches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'string', description: 'The candidate reference given.' },
          verdict: { type: 'string', enum: ['STRONG', 'PARTIAL', 'WEAK', 'NONE'] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['ref', 'verdict', 'confidence', 'reason'],
      },
    },
  },
  required: ['matches'],
};

const VERDICTS = ['STRONG', 'PARTIAL', 'WEAK', 'NONE'];

/** Strips the decoration models add around an identifier they were asked to echo. */
function normaliseRef(ref) {
  return String(ref || '').toUpperCase().replace(/[^A-Z0-9_]/g, '');
}

/**
 * Coerces the model's verdict and confidence into values the database accepts.
 *
 * The schema declares an enum, but it is only advisory on an OpenAI-compatible
 * provider: response_format guarantees valid JSON, not a valid shape, and
 * assertShape checks top-level keys only. So `verdict` arrives as unvalidated
 * text on its way into a column with a CHECK constraint — "strong" in
 * lowercase, or an invented "EXCELLENT", raises a constraint violation after
 * the model call has already been paid for.
 *
 * Confidence has the same problem in numeric form. The column is NUMERIC(4,3),
 * so a model answering 95 rather than 0.95 overflows it. A percentage is a
 * recognisable mistake and is rescaled; anything still out of range is dropped
 * to null, because a wrong confidence silently changes which candidates a
 * recruiter is told to review.
 */
function coerceVerdict(raw) {
  const upper = String(raw || '').trim().toUpperCase().replace(/[^A-Z_]/g, '');
  return VERDICTS.includes(upper) ? upper : null;
}

function coerceConfidence(raw) {
  const value = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(value)) return null;
  if (value >= 0 && value <= 1) return Math.round(value * 1000) / 1000;
  if (value > 1 && value <= 100) return Math.round(value * 10) / 1000;
  return null;
}

function renderJob(job) {
  const reqs = Array.isArray(job.requirements) ? job.requirements : [];
  const minYears = job.min_experience_years;
  return [
    `Title: ${job.title}`,
    job.company && `Company: ${job.company}`,
    job.location && `Location: ${job.location}`,
    minYears !== null && minYears !== undefined && `Minimum experience: ${minYears} years`,
    reqs.length && `Requirements:\n${reqs.map((r) => `- ${r}`).join('\n')}`,
    job.description && `Description:\n${clip(job.description, JOB_CHARS, 'description')}`,
  ].filter(Boolean).join('\n');
}

/**
 * Scores a shortlist in ONE model call rather than one call per candidate.
 *
 * Twelve calls at a free tier's few-per-minute pace is several minutes of
 * waiting for a list a recruiter expects on click. Scoring them together also
 * lets the model rank them against each other, which is closer to what
 * "suggest strong matches" means than twelve verdicts reached in isolation.
 */
async function score(job, candidates) {
  if (candidates.length === 0) return [];

  const prompt = `# Role
${renderJob(job)}

# Candidates
${candidates.map((c) => `## ${c.key}\n${c.profile}`).join('\n\n---\n\n')}`;

  const { data, model } = await generateJson({
    system: SYSTEM,
    prompt,
    schema: SCHEMA,
    maxOutputTokens: OUTPUT_TOKENS,
  });

  // Matched on a normalised reference, not the literal string. The model has
  // to echo back an identifier it was given in a markdown heading, and it
  // routinely returns "## CAND_1001", "cand_1001" or the id in quotes. An exact
  // lookup misses every one of those, and the failure is silent and total: each
  // candidate falls through to "the model did not return a verdict", so a
  // working suggestion run looks like a broken one.
  const byRef = new Map(
    (Array.isArray(data.matches) ? data.matches : []).map((m) => [normaliseRef(m.ref), m])
  );

  return candidates.map((candidate) => {
    const scored = byRef.get(normaliseRef(candidate.key));
    if (!scored) {
      // Asked for and not returned. Recorded as an explicit review item rather
      // than dropped: "the model skipped this one" and "this one is a poor
      // fit" are different facts, and only one of them is a judgement.
      return {
        ...candidate,
        verdict: 'NEEDS_REVIEW',
        confidence: null,
        reason: 'The model did not return a verdict for this candidate.',
        model,
      };
    }
    const verdict = coerceVerdict(scored.verdict);
    if (!verdict) {
      // An unrecognised verdict is not a judgement, so it must not be recorded
      // as one — and it must not be dropped either, or the candidate silently
      // vanishes from a list they were considered for.
      return {
        ...candidate,
        verdict: 'NEEDS_REVIEW',
        confidence: null,
        reason: `Unrecognised verdict from the model (${JSON.stringify(scored.verdict)}).`,
        model,
      };
    }

    const floored = applyConfidenceFloor({
      verdict,
      confidence: coerceConfidence(scored.confidence),
      reason: scored.reason || null,
    });
    return { ...candidate, ...floored, model };
  });
}

module.exports = {
  shortlist,
  score,
  renderJob,
  searchTerms,
  normaliseRef,
  // Exported for tests: the model's output is unvalidated on an
  // OpenAI-compatible provider, and these are what stand between it and a
  // constraint violation.
  coerceVerdict,
  coerceConfidence,
  PROMPT_VERSION,
  SHORTLIST_SIZE,
};
