const { GoogleGenAI } = require('@google/genai');

/**
 * The only file that talks to a model provider. Everything upstream deals in
 * (systemInstruction, prompt, schema) -> parsed JSON, so swapping providers is
 * a change to this file alone.
 *
 * GEMINI_MODEL is env-configurable on purpose: model IDs get renamed and
 * retired, and a 404 here should be a config change, not a code change.
 */
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const MAX_ATTEMPTS = parseInt(process.env.LLM_MAX_ATTEMPTS || '3', 10);

let client = null;
function getClient() {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

const RETRYABLE = /429|500|502|503|504|overloaded|unavailable|deadline|ECONNRESET|ETIMEDOUT/i;

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
      const response = await ai.models.generateContent({
        model: modelId,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: 'application/json',
          responseSchema: schema,
          // Classification wants the same answer for the same input, not variety.
          temperature: 0,
        },
      });

      const text = response.text;
      if (!text) throw new Error('empty response from model');

      let data;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new Error(`model returned non-JSON: ${text.slice(0, 300)}`);
      }

      return {
        data,
        model: modelId,
        usage: response.usageMetadata || null,
      };
    } catch (err) {
      lastError = err;
      const retryable = RETRYABLE.test(err.message || '');
      if (!retryable || attempt === MAX_ATTEMPTS) break;
      const backoff = 500 * 2 ** (attempt - 1) + Math.random() * 250;
      console.warn(`[llm] attempt ${attempt} failed (${err.message}); retrying in ${Math.round(backoff)}ms`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

module.exports = { generateJson, MODEL };
