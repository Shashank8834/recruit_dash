const { GoogleGenAI } = require('@google/genai');
const rateLimiter = require('./rateLimiter');

/**
 * The only file that talks to a model provider. Everything upstream deals in
 * (systemInstruction, prompt, schema) -> parsed JSON, so swapping providers is
 * a change to this file alone.
 *
 * GEMINI_MODEL is env-configurable on purpose: model IDs get renamed and
 * retired, and a 404 here should be a config change, not a code change.
 */
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const MAX_ATTEMPTS = parseInt(process.env.LLM_MAX_ATTEMPTS || '4', 10);

/**
 * Client-side pacing. Gemini's free tier allows 5 requests per minute per
 * model; exceeding it earns a 429 telling you to come back in ~52 seconds,
 * which is far more expensive than simply not sending the request yet.
 *
 * Slots are reserved synchronously, so concurrent callers queue behind each
 * other rather than all discovering the limit at once. Set GEMINI_MAX_RPM to
 * 0 to disable once you are on a paid tier.
 *
 * The budget is shared across processes via Postgres (see rateLimiter.js).
 * It has to be: the API server, the worker and each one-shot script are
 * separate processes on one API key, and an in-process counter resets to zero
 * on every invocation — so a script re-run seconds later would fire straight
 * into a window the previous run had already spent.
 *
 * The default sits just under the documented limit, because the provider's
 * window boundaries need slack and every retry consumes a slot of its own.
 */
const MAX_RPM = parseFloat(process.env.GEMINI_MAX_RPM || '4');

const MAX_BACKOFF_MS = parseInt(process.env.LLM_MAX_BACKOFF_MS || '90000', 10);
const MAX_OUTPUT_TOKENS = parseInt(process.env.LLM_MAX_OUTPUT_TOKENS || '4096', 10);

/**
 * Gemini returns the exact wait it wants in the error body. Honour it —
 * guessing with exponential backoff just burns the retry budget in a
 * fraction of the time the server asked for.
 */
function serverRetryDelayMs(message) {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message || '');
  if (!match) return null;
  return Math.min(Math.ceil(parseFloat(match[1]) * 1000) + 500, MAX_BACKOFF_MS);
}

function isRateLimit(message) {
  return /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(message || '');
}

let client = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

// TRUNCATED_JSON / INVALID_JSON are retryable because the temperature nudge
// above gives the next attempt a genuine chance of landing differently.
const RETRYABLE = /429|500|502|503|504|overloaded|unavailable|deadline|ECONNRESET|ETIMEDOUT|TRUNCATED_JSON|INVALID_JSON/i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls the model with a response schema and returns parsed JSON.
 * @param {object}  opts
 * @param {string}  opts.system      System instruction.
 * @param {string}  opts.prompt      User content.
 * @param {object}  opts.schema      Response schema (JSON-Schema subset).
 * @param {string} [opts.model]      Override the default model.
 * @returns {Promise<{data: object, model: string, usage: object}>}
 */
async function generateJson({ system, prompt, schema, model }) {
  const ai = getClient();
  const modelId = model || MODEL;
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await rateLimiter.acquire(MAX_RPM);
      const response = await ai.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseSchema: schema,
          // Classification wants the same answer for the same input, not
          // variety — but temperature 0 can fall into a degenerate repetition
          // loop that runs until the output cap and truncates the JSON. When
          // that happens, retrying identically reproduces it exactly, so each
          // retry nudges temperature just enough to break the loop.
          temperature: attempt === 1 ? 0 : Math.min(0.1 * (attempt - 1), 0.3),
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      });

      const text = response.text;
      if (!text) throw new Error('empty response from model');

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const finish = response.candidates && response.candidates[0]
          && response.candidates[0].finishReason;
        const truncated = finish === 'MAX_TOKENS' || !/[}\]]\s*$/.test(text.trim());
        throw new Error(
          `${truncated ? 'TRUNCATED_JSON' : 'INVALID_JSON'} (finishReason=${finish || 'unknown'}): ` +
          text.slice(0, 200)
        );
      }

      return {
        data,
        model: modelId,
        usage: response.usageMetadata || null,
      };
    } catch (err) {
      lastError = err;
      const message = err.message || '';
      if (!RETRYABLE.test(message) || attempt === MAX_ATTEMPTS) break;

      // A rate limit carries the server's own retry window; anything else gets
      // ordinary exponential backoff.
      const serverDelay = serverRetryDelayMs(message);
      const backoff = serverDelay !== null
        ? serverDelay
        : Math.min(500 * 2 ** (attempt - 1) + Math.random() * 250, MAX_BACKOFF_MS);

      // Publish the provider's own backoff so sibling processes pause too,
      // rather than each one discovering the same 429 for itself.
      if (isRateLimit(message)) {
        await rateLimiter.recordBackoff(backoff, message.slice(0, 200));
      }

      const reason = isRateLimit(message)
        ? `rate limited (${MAX_RPM || 'unthrottled'} rpm configured)`
        : message.slice(0, 140);
      console.warn(
        `[llm] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${reason}; retrying in ${Math.round(backoff / 1000)}s`
      );
      await sleep(backoff);
    }
  }
  throw lastError;
}

module.exports = { generateJson, MODEL };
