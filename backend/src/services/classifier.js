const { generateJson } = require('./llm');

/**
 * Bump this whenever a prompt or schema below changes. It is stored on every
 * classification row, so you can tell which prompt produced which verdict and
 * diff two versions over the same submissions.
 */
const PROMPT_VERSION = 'v2-two-stage';

const NEEDS_REVIEW_BELOW = parseFloat(process.env.CONFIDENCE_FLOOR || '0.6');

/* ------------------------------------------------------------------ */
/* Stage 1 — routing                                                    */
/* ------------------------------------------------------------------ */

const ROUTER_SYSTEM = `You triage inbound WhatsApp messages for a recruitment agency.

The messages arrive from a shared line used by hiring managers posting roles and
by candidates applying to them. Your only job in this step is to decide what the
message IS. Do not evaluate how good a candidate is — a later step does that.

Categories:
- job_posting: someone is describing a role they want to fill (responsibilities,
  requirements, hiring intent).
- application: someone is presenting themselves as a candidate — describing
  their experience, sending a CV, or asking to be considered for a role.
- chatter: greetings, thanks, acknowledgements, scheduling logistics, questions
  about process. Real messages, but not a posting and not an application.
- unclear: genuinely ambiguous or too fragmentary to categorise.

Two rules that matter more than the rest:

1. The text you receive may be several WhatsApp messages sent in a row and
   joined together, because people split one thought across messages. Judge the
   combined text as a single unit. A fragment like "5 years experience" on its
   own is not chatter if the block it belongs to is clearly an application.

2. Prior messages from the same chat are provided as context. Use them only to
   decide whether this block CONTINUES an earlier application or posting (for
   example, a CV arriving after the introduction). Set continues_previous when
   it does. Do not classify the context itself.

Prefer "unclear" over guessing. A low-confidence guess is worse than an honest
flag, because unclear items get a human review and wrong guesses do not.`;

const ROUTER_SCHEMA = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['job_posting', 'application', 'chatter', 'unclear'],
    },
    confidence: { type: 'number' },
    continues_previous: { type: 'boolean' },
    reason: { type: 'string' },
    person: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
    },
    job: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        posted_by: { type: 'string' },
        requirements: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  required: ['kind', 'confidence', 'continues_previous', 'reason'],
};

function renderContext(contextMessages) {
  if (!contextMessages || contextMessages.length === 0) {
    return '(no earlier messages in this chat)';
  }
  return contextMessages
    .map((m) => {
      const when = new Date(m.sent_at).toISOString();
      const text = m.body || (m.media_type ? `[${m.media_type}]` : '');
      return `[${when}] ${text}`;
    })
    .join('\n');
}

async function route({ text, contextMessages }) {
  const prompt = `# Earlier messages in this chat (context only)
${renderContext(contextMessages)}

# Message block to categorise
${text}`;

  const { data, model, usage } = await generateJson({
    system: ROUTER_SYSTEM,
    prompt,
    schema: ROUTER_SCHEMA,
  });

  return {
    kind: data.kind,
    confidence: typeof data.confidence === 'number' ? data.confidence : null,
    continuesPrevious: Boolean(data.continues_previous),
    reason: data.reason || null,
    person: data.person || {},
    job: data.job || {},
    model,
    usage,
  };
}

/* ------------------------------------------------------------------ */
/* Stage 2 — JD matching                                                */
/* ------------------------------------------------------------------ */

const MATCHER_SYSTEM = `You assess how well a candidate matches open job descriptions.

You will be given one candidate's message (possibly several WhatsApp messages
joined together) and a list of open roles. Pick the single role they are best
suited to, or none if no role fits.

Verdicts:
- STRONG:  meets essentially all stated requirements.
- PARTIAL: meets the core requirement but has a real, nameable gap.
- WEAK:    adjacent background; would need substantial ramp-up.
- NONE:    no open role is a sensible fit for this person.

Evidence is required and it is the point of this task. For every requirement you
judge, quote the exact span of the candidate's message that supports your
judgement, verbatim. If you cannot quote a span, you do not have evidence — say
the requirement is unaddressed rather than inferring it. A candidate who says
"I know frontend" has not told you they know React.

Judge only what the candidate actually claims. Do not infer seniority from tone,
do not assume unstated skills are present because related ones are, and do not
penalise someone for not mentioning something the role does not require.

Set confidence honestly. If the message is too thin to judge — a bare "I'm
interested", a CV you cannot read — say so with low confidence and an empty
evidence list. That routes the case to a human, which is the correct outcome.`;

const MATCHER_SCHEMA = {
  type: 'object',
  properties: {
    jd_external_id: {
      type: 'string',
      description: 'External ID of the best-fitting role, or "NONE".',
    },
    verdict: {
      type: 'string',
      enum: ['STRONG', 'PARTIAL', 'WEAK', 'NONE'],
    },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          requirement: { type: 'string' },
          status: { type: 'string', enum: ['met', 'partial', 'unmet', 'unaddressed'] },
          quote: {
            type: 'string',
            description: 'Verbatim span from the candidate message; empty if unaddressed.',
          },
        },
        required: ['requirement', 'status', 'quote'],
      },
    },
  },
  required: ['jd_external_id', 'verdict', 'confidence', 'reason', 'evidence'],
};

function renderJds(jds) {
  if (jds.length === 0) return '(no open roles)';
  return jds
    .map((jd) => {
      const reqs = Array.isArray(jd.requirements) ? jd.requirements : [];
      const reqBlock = reqs.length
        ? `\nStated requirements:\n${reqs.map((r) => `- ${r}`).join('\n')}`
        : '';
      return `## ${jd.external_id}${jd.title ? ` — ${jd.title}` : ''}
${jd.jd_text}${reqBlock}`;
    })
    .join('\n\n---\n\n');
}

async function match({ text, jds }) {
  if (!jds || jds.length === 0) {
    return {
      jdExternalId: null,
      verdict: 'NONE',
      confidence: 1,
      reason: 'No open roles to match against.',
      evidence: [],
      model: null,
      usage: null,
    };
  }

  const prompt = `# Open roles
${renderJds(jds)}

# Candidate message
${text}`;

  const { data, model, usage } = await generateJson({
    system: MATCHER_SYSTEM,
    prompt,
    schema: MATCHER_SCHEMA,
  });

  const jdExternalId =
    data.jd_external_id && data.jd_external_id !== 'NONE' ? data.jd_external_id : null;

  return {
    jdExternalId,
    verdict: data.verdict,
    confidence: typeof data.confidence === 'number' ? data.confidence : null,
    reason: data.reason || null,
    evidence: Array.isArray(data.evidence) ? data.evidence : [],
    model,
    usage,
  };
}

/**
 * A verdict the model is not confident about is worth less than an honest
 * "someone should look at this" — low-confidence results go to the review
 * queue instead of being presented as a decision.
 */
function applyConfidenceFloor(result) {
  if (result.confidence !== null && result.confidence < NEEDS_REVIEW_BELOW) {
    return { ...result, verdict: 'NEEDS_REVIEW', modelVerdict: result.verdict };
  }
  return { ...result, modelVerdict: result.verdict };
}

module.exports = {
  route,
  match,
  applyConfidenceFloor,
  PROMPT_VERSION,
  NEEDS_REVIEW_BELOW,
  ROUTER_SCHEMA,
  MATCHER_SCHEMA,
};
