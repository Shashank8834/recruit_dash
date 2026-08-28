const rateLimiter = require('./rateLimiter');

/**
 * The only file that talks to a model provider. Everything upstream deals in
 * (system, prompt, schema) -> parsed JSON, so switching providers is a config
 * change rather than a code change.
 *
 * Two backends:
 *
 *   gemini   Google's native API, via @google/genai. Enforces the response
 *            schema server-side.
 *
 *   openai   Any OpenAI-compatible /chat/completions endpoint — Groq,
 *            OpenRouter, Cerebras, Together, a local Ollama. One
 *            implementation covers all of them because they share a wire
 *            format. JSON is requested via response_format and the schema is
 *            stated in the system prompt, because schema enforcement is not
 *            universally supported; the shape is then checked below.
 *
 * The request budget is shared across processes via Postgres (rateLimiter.js).
 * It has to be: the API server, the worker and each one-shot script are
 * separate processes on one key, and an in-process counter resets to zero on
 * every invocation.
 */
const PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

const MAX_ATTEMPTS = parseInt(process.env.LLM_MAX_ATTEMPTS || '4', 10);
const MAX_BACKOFF_MS = parseInt(process.env.LLM_MAX_BACKOFF_MS || '90000', 10);
// Providers count the RESERVED output budget against tokens-per-minute, not
// just what is actually generated, so an oversized max_tokens silently halves
// the room available for the prompt. Our schemas need far less than 4k.
const MAX_OUTPUT_TOKENS = parseInt(process.env.LLM_MAX_OUTPUT_TOKENS || '2048', 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.LLM_TIMEOUT_MS || '120000', 10);

// The GEMINI_* names came first; they are still honoured so existing .env
// files keep working after a provider switch.
const MAX_RPM = parseFloat(process.env.LLM_MAX_RPM || process.env.GEMINI_MAX_RPM || '4');

// Tokens per minute, defaulted per provider because the two free tiers fail in
// opposite directions.
//
// Groq allows roughly 8000 TPM against 30 rpm: one classification costs a few
// thousand tokens, so the token budget is spent after about two calls, and
// pacing on requests alone sends a burst that is rejected on arrival. The
// default sits under 8000 to leave room at window boundaries, since the
// reservation is made on an estimate.
//
// Gemini is the reverse — hundreds of thousands of tokens a minute against 5
// rpm per project — so a token ceiling there would throttle a limit that was
// never going to bind, and requests-per-minute is left to do the work.
//
// Set explicitly to override either way; 0 disables, as with MAX_RPM.
const MAX_TPM = parseFloat(
  process.env.LLM_MAX_TPM || (PROVIDER === 'gemini' ? '0' : '6000')
);

/**
 * The system message as it actually goes over the wire.
 *
 * Not the same string the caller passed. On an OpenAI-compatible provider the
 * schema is appended to the system prompt, because response_format guarantees
 * valid JSON but not the right shape — and that appendix is real, metered
 * characters, over a thousand of them for the CV schema. Estimating from the
 * caller's `system` alone under-counted every request by roughly 300 tokens,
 * in the one direction the comment below says it must never lean.
 *
 * Gemini takes the schema as a separate `responseSchema` field, so there the
 * two strings are the same.
 */
function wireSystem(system, schema) {
  if (PROVIDER === 'gemini' || !schema) return system || '';
  return `${system || ''}\n\n${describeSchema(schema)}`;
}

/**
 * What this request will cost against the token budget, before sending it.
 *
 * Two deliberate biases, both upward. Four characters per token is the usual
 * English approximation and JSON-heavy prompts run slightly denser than that;
 * and the RESERVED output budget is counted in full, because providers meter
 * max_tokens against TPM whether or not the model generates that much. An
 * estimate that is a little high costs a few seconds of idling. One that is
 * low costs a 429, and 429s are what this whole file exists to avoid.
 */
function estimateTokens(system, prompt, maxOutputTokens = MAX_OUTPUT_TOKENS, schema = null) {
  const chars = wireSystem(system, schema).length + (prompt || '').length;
  return Math.ceil(chars / 4) + maxOutputTokens;
}

/**
 * Absorbs the difference between four-characters-per-token and what the
 * tokeniser actually does. Small: the point is to stop a prompt landing one
 * token over the line, not to reserve a second budget.
 */
const ESTIMATE_MARGIN_TOKENS = 128;

/**
 * How much room a prompt has, given everything that is charged alongside it.
 *
 * The per-request ceiling is spent before the caller's text is even
 * considered: the system prompt, the schema appended to it, and the output
 * budget reserved in full are all fixed costs. What remains is what the prompt
 * may occupy — and a caller that measures it up front never has to learn it
 * from a rejection.
 *
 * `chars` is Infinity when no token ceiling is configured (the Gemini
 * default), which callers read as "no need to shrink anything".
 *
 * @returns {{chars: number, fixedTokens: number, ceiling: number}}
 */
function promptBudget({ system, schema, maxOutputTokens }) {
  const cap = maxOutputTokens || MAX_OUTPUT_TOKENS;
  const fixedTokens = Math.ceil(wireSystem(system, schema).length / 4) + cap;
  if (!MAX_TPM || MAX_TPM <= 0) {
    return { chars: Infinity, fixedTokens, ceiling: MAX_TPM };
  }
  const spare = MAX_TPM - fixedTokens - ESTIMATE_MARGIN_TOKENS;
  return { chars: spare * 4, fixedTokens, ceiling: MAX_TPM };
}

/** Tokens the provider says it actually charged, across both wire formats. */
function actualTokens(usage) {
  if (!usage) return null;
  return (
    usage.total_tokens ||
    usage.totalTokenCount ||
    (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) ||
    null
  );
}

// Falling back to a Gemini model id while pointed at an OpenAI-compatible
// endpoint yields a confusing 404 about a model that was never going to exist
// there, so each provider gets its own default.
const MODEL =
  PROVIDER === 'gemini'
    ? (process.env.LLM_MODEL || process.env.GEMINI_MODEL || 'gemini-3.5-flash')
    : (process.env.LLM_MODEL || 'openai/gpt-oss-120b');

const RETRYABLE =
  /429|500|502|503|504|overloaded|unavailable|deadline|ECONNRESET|ETIMEDOUT|TRUNCATED_JSON|INVALID_JSON|SCHEMA_MISMATCH/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Providers state how long to wait when they rate limit. Honour it — guessing
 * with exponential backoff burns the retry budget in a fraction of the window
 * the server actually asked for.
 */
function serverRetryDelayMs(message) {
  const match =
    // Gemini: {"retryDelay": "52s"}
    /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message || '') ||
    // Groq states it in prose: "Please try again in 31.0125s". Without this the
    // backoff fell through to the exponential guess and retried after ~1s,
    // inside a window the server had just said was exhausted for half a minute.
    /try again in\s*(\d+(?:\.\d+)?)\s*s/i.exec(message || '') ||
    /retry[- ]after[:= ]+(\d+(?:\.\d+)?)/i.exec(message || '');
  if (!match) return null;
  return Math.min(Math.ceil(parseFloat(match[1]) * 1000) + 500, MAX_BACKOFF_MS);
}

/**
 * A single request that exceeds the ceiling, as opposed to too many requests.
 *
 * The distinction matters because the two look identical on the wire — Groq
 * returns 429 for both — but the remedies are opposites. A rate limit clears
 * by waiting. An oversized request does not: the same request re-sent a minute
 * later is still oversized, so retrying it burns quota to reproduce the same
 * failure, and pausing every sibling process on its behalf stalls work that
 * would have succeeded. Only sending less helps, and only the caller can do
 * that — so this fails fast up to classifier.match, which shrinks and retries.
 */
function isTokenLimit(message) {
  return /TOKEN_LIMIT/.test(message || '');
}

/**
 * Decides, from a provider's error response, whether the request was too big
 * or the minute's budget was simply spent.
 *
 * These are hard to tell apart and expensive to confuse. Groq describes both
 * with the same "on tokens per minute (TPM)" wording and, for a period,
 * returned 429 for both:
 *
 *   too large:  "Request too large for model X ... Limit 8000, Requested 8222,
 *                please reduce your message size and try again"
 *   exhausted:  "Rate limit reached for model X ... Limit 8000, Used 7311,
 *                Requested 4824. Please try again in 31.0125s"
 *
 * Matching on the TPM phrase tagged the second as the first, so the classifier
 * halved a prompt that was never oversized and retried immediately into a
 * window the server had said was exhausted for the next 31 seconds — failing
 * repeatedly while shrinking the prompt toward uselessness.
 *
 * The instruction the provider gives is the signal that separates them:
 * *reduce* versus *wait*. Note that the exhausted message also contains
 * "Requested", so any test on the numbers alone matches both.
 *
 * Unrecognised errors fall through to the rate-limit path deliberately. That
 * is the safer default: waiting on a genuinely oversized request costs a
 * pause, while shrinking on a genuine rate limit spends quota reproducing the
 * same failure and degrades the prompt on the way.
 */
function isOversizedRequest(status, body) {
  if (status === 413) return true;
  return /request too large|reduce your message size|context length|maximum context/i.test(
    body || ''
  );
}

function isRateLimit(message) {
  if (isTokenLimit(message)) return false;
  return /\b429\b|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(message || '');
}

/* ------------------------------------------------------------------ */
/* Gemini                                                              */
/* ------------------------------------------------------------------ */

let geminiClient = null;
function getGemini() {
  if (!geminiClient) {
    const { GoogleGenAI } = require('@google/genai');
    const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY (or LLM_API_KEY) is not set');
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

async function callGemini({ system, prompt, schema, model, attempt, maxOutputTokens }) {
  const response = await getGemini().models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction: system,
      responseMimeType: 'application/json',
      responseSchema: schema,
      // Temperature 0 can fall into a repetition loop that runs to the output
      // cap and truncates the JSON; an identical retry reproduces it exactly,
      // so each retry nudges just enough to break the loop.
      temperature: attempt === 1 ? 0 : Math.min(0.1 * (attempt - 1), 0.3),
      maxOutputTokens,
    },
  });

  const finishReason =
    response.candidates && response.candidates[0] && response.candidates[0].finishReason;
  return { text: response.text, finishReason, usage: response.usageMetadata || null };
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible (Groq, OpenRouter, Cerebras, Together, Ollama)     */
/* ------------------------------------------------------------------ */

function describeSchema(schema) {
  return (
    'Reply with a single JSON object and nothing else — no prose, no code ' +
    'fences. It must conform to this JSON Schema:\n' +
    JSON.stringify(schema, null, 2)
  );
}

/**
 * Reasoning models spend completion tokens thinking before they answer, and
 * that thinking is charged against the same `max_tokens` as the answer.
 *
 * gpt-oss-120b at Groq's default effort routinely burned several hundred
 * tokens before emitting a character of JSON, so a 512-token routing call ran
 * out mid-object and came back as `json_validate_failed` — "max completion
 * tokens reached before generating a valid document". Raising the cap would
 * only pay for the thinking twice, since reserved output counts against
 * tokens-per-minute in full.
 *
 * Neither of our stages benefits from extended reasoning. Routing decides what
 * a message is; matching quotes spans from a text sitting in the prompt. Both
 * are extraction, not deduction, so the budget is better spent on the answer.
 *
 * Sent only to models known to accept it — providers reject unknown parameters
 * outright, so this cannot be set unconditionally.
 */
function reasoningEffortFor(model) {
  const effort = process.env.LLM_REASONING_EFFORT || 'low';
  if (effort === 'none') return {};
  return /gpt-oss|deepseek-r1|qwen3|magistral/i.test(model || '')
    ? { reasoning_effort: effort }
    : {};
}

async function callOpenAICompatible({ system, prompt, schema, model, attempt, maxOutputTokens }) {
  const base = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          // The schema goes in the system prompt: response_format json_object
          // guarantees valid JSON but not the right shape, and json_schema is
          // not supported by every compatible provider.
          { role: 'system', content: `${system}\n\n${describeSchema(schema)}` },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
        temperature: attempt === 1 ? 0 : Math.min(0.1 * (attempt - 1), 0.3),
        max_tokens: maxOutputTokens,
        ...reasoningEffortFor(model),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const retryAfter = response.headers.get('retry-after');
      // Groq validates JSON server-side, so a reply that ran out of tokens
      // mid-object arrives as a 400 `json_validate_failed` rather than as a
      // truncated body with finishReason=length. Same failure, different
      // envelope — and the 400 skipped the retry path entirely, killing the
      // whole submission on what is a transient, recoverable outcome. Tag it
      // as the truncation it is so the existing retry (with a raised cap)
      // handles it.
      if (/json_validate_failed|max completion tokens reached/i.test(body)) {
        throw new Error(`TRUNCATED_JSON (${response.status}): ${body.slice(0, 240)}`);
      }
      if (isOversizedRequest(response.status, body)) {
        // Distinct from a rate limit: waiting cannot help, because a single
        // request exceeds the ceiling. The caller has to send less.
        throw new Error(`TOKEN_LIMIT ${response.status} ${body.slice(0, 240)}`);
      }
      // Providers retire model ids regularly. A bare 404 sends people hunting
      // through docs; name the cause and the command that resolves it.
      const hint =
        response.status === 404 || /model_not_found|does not exist/i.test(body)
          ? `
  Model "${model}" is not available at ${base}. ` +
            'Run `npm run llm:models` to list what is, then set LLM_MODEL.'
          : '';
      throw new Error(
        `${response.status} ${body.slice(0, 300)}` +
        (retryAfter ? ` retry-after: ${retryAfter}` : '') + hint
      );
    }

    const data = await response.json();
    const choice = data.choices && data.choices[0];
    return {
      text: choice && choice.message && choice.message.content,
      finishReason: choice && choice.finish_reason,
      usage: data.usage || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */

/**
 * Shape check for providers that cannot enforce the schema themselves. Only
 * top-level required fields are verified — enough to catch a model that
 * answered in prose or invented its own envelope, without reimplementing a
 * JSON Schema validator.
 */
function assertShape(data, schema) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('SCHEMA_MISMATCH: expected a JSON object');
  }
  const required = (schema && schema.required) || [];
  const missing = required.filter((key) => data[key] === undefined);
  if (missing.length) {
    throw new Error(`SCHEMA_MISMATCH: missing required field(s) ${missing.join(', ')}`);
  }
}

/**
 * Calls the configured provider and returns parsed JSON.
 *
 * `maxOutputTokens` is worth setting per call site rather than globally.
 * Providers reserve it against tokens-per-minute in full, whether or not the
 * model generates that much, so a one-size cap sized for the largest schema
 * charges every small call the same. The router answers in a handful of
 * fields; the matcher returns an evidence array. Sizing each to its own
 * schema is free throughput on a metered tier.
 *
 * @returns {Promise<{data: object, model: string, usage: object}>}
 */
async function generateJson({ system, prompt, schema, model, maxOutputTokens }) {
  const modelId = model || MODEL;
  // Grows on a truncated reply. Retrying at the cap that just proved too small
  // reproduces the truncation exactly, burning the retry budget and the tokens
  // with it. Starts at the call site's own estimate so the common case stays
  // cheap, since reserved output is charged against TPM whether used or not.
  let outputCap = maxOutputTokens || MAX_OUTPUT_TOKENS;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const estimated = estimateTokens(system, prompt, outputCap, schema);
      const { logId } = await rateLimiter.acquire(MAX_RPM, {
        maxTpm: MAX_TPM,
        estimatedTokens: estimated,
      });

      const call = PROVIDER === 'gemini' ? callGemini : callOpenAICompatible;
      const { text, finishReason, usage } = await call({
        system, prompt, schema, model: modelId, attempt, maxOutputTokens: outputCap,
      });

      // Correct the reservation now that the provider has told us the real
      // cost. Done before the response is parsed, so a malformed reply still
      // charges the window for the tokens it genuinely consumed.
      await rateLimiter.recordActual(logId, actualTokens(usage));

      if (!text) throw new Error('empty response from model');

      let data;
      try {
        // Some providers wrap JSON in a code fence despite being asked not to.
        const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
        data = JSON.parse(cleaned);
      } catch {
        const truncated =
          finishReason === 'MAX_TOKENS' ||
          finishReason === 'length' ||
          !/[}\]]\s*$/.test(text.trim());
        throw new Error(
          `${truncated ? 'TRUNCATED_JSON' : 'INVALID_JSON'} ` +
          `(finishReason=${finishReason || 'unknown'}): ${text.slice(0, 200)}`
        );
      }

      if (PROVIDER !== 'gemini') assertShape(data, schema);

      return { data, model: modelId, usage };
    } catch (err) {
      lastError = err;
      const message = err.message || '';
      // Checked before RETRYABLE, which would otherwise match the 429 that
      // Groq returns for an oversized request and retry it identically.
      if (isTokenLimit(message)) break;
      if (!RETRYABLE.test(message) || attempt === MAX_ATTEMPTS) break;

      // A truncated reply is the one failure the next attempt can be set up to
      // avoid: the cap was too small, so raise it rather than re-running the
      // identical request. Bounded, because output is reserved against TPM in
      // full and an unbounded cap would starve the prompt of room.
      if (/TRUNCATED_JSON/.test(message)) {
        const raised = Math.min(outputCap * 2, MAX_OUTPUT_TOKENS);
        if (raised > outputCap) {
          console.warn(
            `[llm] reply truncated at ${outputCap} output tokens; retrying at ${raised}`
          );
          outputCap = raised;
        }
      }

      const serverDelay = serverRetryDelayMs(message);
      const backoff =
        serverDelay !== null
          ? serverDelay
          : Math.min(500 * 2 ** (attempt - 1) + Math.random() * 250, MAX_BACKOFF_MS);

      // Publish the provider's backoff so sibling processes pause too, rather
      // than each discovering the same limit for itself.
      if (isRateLimit(message)) {
        await rateLimiter.recordBackoff(backoff, message.slice(0, 200));
      }

      console.warn(
        `[llm] attempt ${attempt}/${MAX_ATTEMPTS} failed: ` +
        `${isRateLimit(message) ? `rate limited (${MAX_RPM || 'unthrottled'} rpm configured)` : message.slice(0, 140)}; ` +
        `retrying in ${Math.round(backoff / 1000)}s`
      );
      await sleep(backoff);
    }
  }
  throw lastError;
}

module.exports = {
  generateJson,
  estimateTokens,
  // How much room a prompt has before the provider rejects it. Callers that
  // assemble text of unbounded length fit to this rather than discovering the
  // ceiling from a rejection.
  promptBudget,
  wireSystem,
  // Exported for tests. Both are one word away from their opposite and both
  // failed silently in production before they were pinned.
  isOversizedRequest,
  serverRetryDelayMs,
  reasoningEffortFor,
  MODEL,
  PROVIDER,
  MAX_RPM,
  MAX_TPM,
};
