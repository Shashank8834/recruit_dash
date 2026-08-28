const { generateJson, promptBudget } = require('./llm');

/**
 * Bump this whenever a prompt or schema below changes. It is stored on every
 * classification row, so you can tell which prompt produced which verdict and
 * diff two versions over the same submissions.
 */
const PROMPT_VERSION = 'v4-budgeted';

const NEEDS_REVIEW_BELOW = parseFloat(process.env.CONFIDENCE_FLOOR || '0.6');

/**
 * Prompt size budget, in characters (~4 per token).
 *
 * Providers meter tokens per minute, and a single oversized request is simply
 * rejected — waiting does not help, only sending less does. The matcher is the
 * expensive call because it carries every open role plus the candidate's full
 * CV, so it degrades gracefully instead of being truncated arbitrarily:
 * requirements are kept (high signal, compact) and free-text descriptions are
 * shortened first.
 */
const PROMPT_BUDGET_CHARS = parseInt(process.env.MATCH_PROMPT_CHARS || '12000', 10);
const JD_TEXT_CHARS = parseInt(process.env.MATCH_JD_TEXT_CHARS || '450', 10);
const CANDIDATE_CHARS = parseInt(process.env.MATCH_CANDIDATE_CHARS || '5000', 10);

/**
 * Stage 1's budget, deliberately much smaller than stage 2's.
 *
 * Routing only decides what a message IS, and that is settled by its opening
 * lines — nobody writes a job posting that reads as chatter for three thousand
 * characters and then reveals itself. Sending an entire 20,000-character CV to
 * answer that question was the largest avoidable cost in the pipeline, and it
 * made stage 1 the request most likely to be rejected outright — on a call
 * that, unlike stage 2, had no way to recover.
 */
const ROUTER_TEXT_CHARS = parseInt(process.env.ROUTER_TEXT_CHARS || '3000', 10);
const ROUTER_CONTEXT_CHARS = parseInt(process.env.ROUTER_CONTEXT_CHARS || '2000', 10);
// One rambling earlier message must not consume the whole context block.
const CONTEXT_MESSAGE_CHARS = parseInt(process.env.ROUTER_CONTEXT_MESSAGE_CHARS || '400', 10);

/** How many times an over-ceiling prompt is halved before giving up. */
const SHRINK_ATTEMPTS = 3;

/**
 * Output budget per stage. Providers reserve max_tokens against
 * tokens-per-minute in full, so a cap sized for the matcher's evidence array
 * would charge the router the same for a five-field answer it never uses.
 */
const ROUTER_OUTPUT_TOKENS = parseInt(process.env.ROUTER_OUTPUT_TOKENS || '512', 10);
const MATCH_OUTPUT_TOKENS = parseInt(process.env.MATCH_OUTPUT_TOKENS || '1024', 10);

function clip(text, max, label) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}
[…${label} truncated]`;
}

/**
 * The largest scale at which `build` fits under the per-request ceiling.
 *
 * Measured before anything is sent. Halving on rejection works, but it learns
 * the ceiling the expensive way — one wasted round trip per halving, and each
 * halving overshoots, throwing away up to half a document to save the few
 * hundred characters that were actually over. A prompt measured against the
 * budget first is sent once, at very nearly the largest size that fits.
 *
 * The ratio is applied repeatedly rather than once because `build` is not
 * linear in scale: the headings, separators and role titles around the text do
 * not shrink with it, so one division lands short and needs correcting. Four
 * passes is far more than the two it takes to converge in practice.
 *
 * If even a fully-shrunk prompt does not fit, the fixed costs alone have
 * filled the ceiling and no prompt of any length would have worked. That is a
 * configuration fault, not a document fault, so it says which knob to turn
 * rather than reporting a token count the operator has to reverse-engineer.
 */
function fitScale({ system, schema, build, label, maxOutputTokens }) {
  const budget = promptBudget({ system, schema, maxOutputTokens });
  if (!Number.isFinite(budget.chars)) return 1;

  let scale = 1;
  for (let pass = 0; pass < 4; pass += 1) {
    const length = build(scale).length;
    if (length <= budget.chars) {
      if (scale < 1) {
        console.warn(
          `[prompt] ${label} trimmed to ${Math.round(scale * 100)}% of its character ` +
          `budget to fit the ${budget.ceiling}-token per-request ceiling`
        );
      }
      return scale;
    }
    if (budget.chars <= 0) break;
    // 0.98 so rounding in the estimate cannot leave it a token over.
    scale *= (budget.chars / length) * 0.98;
  }

  throw new Error(
    `${label} cannot fit under the ${budget.ceiling}-token LLM_MAX_TPM ceiling: the ` +
    `system prompt and the ${maxOutputTokens || '(default)'}-token output reservation ` +
    `alone need ${budget.fixedTokens} tokens, leaving nothing for the text. ` +
    'Raise LLM_MAX_TPM or lower the output budget for this stage.'
  );
}

/**
 * Sends a prompt that fits the per-request token ceiling, halving and
 * retrying if the provider disagrees.
 *
 * fitScale above sizes it before the first call, so the halving here is a
 * backstop rather than the mechanism: it covers the case where the provider's
 * real ceiling is lower than the configured LLM_MAX_TPM, which our own
 * arithmetic has no way to know.
 *
 * Shared with cvExtractor, which faces the same ceiling with a different
 * prompt: the two stages here and the CV extractor are the only callers that
 * assemble a prompt from text of unbounded length.
 *
 * A TOKEN_LIMIT rejection is not a rate limit: the request is too big, so
 * waiting changes nothing and resending it unchanged fails identically. The
 * only move is to send less — and only the caller knows what is safe to drop,
 * hence `build(scale)`, which re-renders the prompt at a fraction of its
 * character budgets rather than blindly truncating the finished string.
 *
 * @param {function(number): string} build  Renders the prompt at a 0-1 scale.
 */
async function generateShrinking({ system, schema, build, label, maxOutputTokens }) {
  let scale = fitScale({ system, schema, build, label, maxOutputTokens });
  let lastError;

  for (let attempt = 1; attempt <= SHRINK_ATTEMPTS; attempt += 1) {
    try {
      return await generateJson({
        system, prompt: build(scale), schema, maxOutputTokens,
      });
    } catch (err) {
      lastError = err;
      if (!/TOKEN_LIMIT/.test(err.message || '') || attempt === SHRINK_ATTEMPTS) throw err;
      scale /= 2;
      console.warn(
        `[prompt] ${label} request over the token ceiling; ` +
        `retrying at ${Math.round(scale * 100)}% of the character budget`
      );
    }
  }
  throw lastError;
}

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

Three rules that matter more than the rest:

1. The text you receive may be several WhatsApp messages sent in a row and
   joined together, because people split one thought across messages. Judge the
   combined text as a single unit. A fragment like "5 years experience" on its
   own is not chatter if the block it belongs to is clearly an application.

2. Prior messages from the same chat are provided as context. Use them only to
   decide whether this block CONTINUES an earlier application or posting (for
   example, a CV arriving after the introduction). Set continues_previous when
   it does. Do not classify the context itself.

3. Attachments appear as a bracketed marker such as "[document: resume.pdf]".
   That marker means the file's text could NOT be read — it is a placeholder,
   not content. A block whose only substance is such a marker is "unclear":
   there is nothing to categorise, and a human needs to open the file. Do not
   assume a PDF named "resume" is an application; that is a guess about a file
   you cannot see. If the marker is accompanied by real text, judge that text
   normally and ignore the marker.

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

/**
 * Context exists only to answer "does this block continue an earlier one?", so
 * it is trimmed from the FRONT when it overflows. The messages immediately
 * before this block are the ones that decide a continuation; the oldest are
 * the ones that can be spared.
 */
function renderContext(contextMessages, budgetChars) {
  if (!contextMessages || contextMessages.length === 0) {
    return '(no earlier messages in this chat)';
  }

  const lines = contextMessages.map((m) => {
    const when = new Date(m.sent_at).toISOString();
    const text = m.body || (m.media_type ? `[${m.media_type}]` : '');
    return `[${when}] ${clip(text, CONTEXT_MESSAGE_CHARS, 'message')}`;
  });

  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    // Always keep the most recent line even if it alone blows the budget: an
    // empty context block would silently disable continuation detection.
    if (used + lines[i].length > budgetChars && kept.length) break;
    kept.unshift(lines[i]);
    used += lines[i].length + 1;
  }

  const dropped = lines.length - kept.length;
  const omitted = dropped ? `[…${dropped} earlier message(s) omitted]\n` : '';
  return omitted + kept.join('\n');
}

async function route({ text, contextMessages }) {
  const build = (scale) => `# Earlier messages in this chat (context only)
${renderContext(contextMessages, Math.floor(ROUTER_CONTEXT_CHARS * scale))}

# Message block to categorise
${clip(text, Math.floor(ROUTER_TEXT_CHARS * scale), 'message')}`;

  const { data, model, usage } = await generateShrinking({
    system: ROUTER_SYSTEM,
    schema: ROUTER_SCHEMA,
    build,
    label: 'routing',
    maxOutputTokens: ROUTER_OUTPUT_TOKENS,
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

/**
 * Renders the open roles within a character budget.
 *
 * Requirements are what the matcher actually grades against, so they are kept
 * in full and the free-text description is shortened first. Dropping whole
 * roles is the last resort: a role the model never sees can never be matched,
 * and its absence is indistinguishable from a genuine NONE verdict.
 *
 * @returns {{text: string, included: number, dropped: number}}
 */
function renderJds(jds, budgetChars, jdTextChars) {
  if (!jds || jds.length === 0) {
    return { text: '(no open roles)', included: 0, dropped: 0 };
  }

  const render = (textChars) =>
    jds.map((jd) => {
      const reqs = Array.isArray(jd.requirements) ? jd.requirements : [];
      const reqBlock = reqs.length
        ? `\nRequirements:\n${reqs.map((r) => `- ${r}`).join('\n')}`
        : '';
      const body = textChars > 0 ? `\n${clip(jd.jd_text, textChars, 'description')}` : '';
      return `## ${jd.external_id}${jd.title ? ` — ${jd.title}` : ''}${body}${reqBlock}`;
    });

  // Shorten descriptions before dropping any role.
  for (const textChars of [jdTextChars, Math.floor(jdTextChars / 2), 0]) {
    const joined = render(textChars).join('\n\n---\n\n');
    if (joined.length <= budgetChars) {
      return { text: joined, included: jds.length, dropped: 0 };
    }
  }

  // Still over budget: keep as many roles as fit on titles and requirements.
  const parts = render(0);
  const kept = [];
  let used = 0;
  for (const part of parts) {
    if (used + part.length > budgetChars) break;
    kept.push(part);
    used += part.length + 8;
  }
  return {
    text: kept.join('\n\n---\n\n'),
    included: kept.length,
    dropped: parts.length - kept.length,
  };
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

  // Stage 2 is the expensive call: every open role plus the candidate's whole
  // CV. Rendering is a function of scale so a rejection can re-render smaller
  // rather than truncate a prompt that is already assembled.
  const build = (scale) => {
    const rendered = renderJds(
      jds,
      Math.floor(PROMPT_BUDGET_CHARS * scale),
      Math.floor(JD_TEXT_CHARS * scale)
    );
    if (rendered.dropped > 0) {
      console.warn(
        `[classifier] prompt budget dropped ${rendered.dropped} role(s); ` +
        'raise MATCH_PROMPT_CHARS or lower MATCH_JD_LIMIT so every open role is considered'
      );
    }
    return `# Open roles
${rendered.text}

# Candidate message
${clip(text, Math.floor(CANDIDATE_CHARS * scale), 'CV')}`;
  };

  const { data, model, usage } = await generateShrinking({
    system: MATCHER_SYSTEM,
    schema: MATCHER_SCHEMA,
    build,
    label: 'matching',
    maxOutputTokens: MATCH_OUTPUT_TOKENS,
  });
  return buildMatchResult(data, model, usage);
}

function buildMatchResult(data, model, usage) {
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
  generateShrinking, // shared with cvExtractor: same ceiling, different prompt
  renderJds, // exported for tests: prompt budgeting is easy to get subtly wrong
  clip,
  applyConfidenceFloor,
  PROMPT_VERSION,
  NEEDS_REVIEW_BELOW,
  ROUTER_SCHEMA,
  MATCHER_SCHEMA,
};
