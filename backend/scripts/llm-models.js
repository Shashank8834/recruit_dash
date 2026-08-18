#!/usr/bin/env node
/**
 * Lists the models the configured provider will actually serve.
 *
 * Model IDs get decommissioned without much warning — llama-3.3-70b-versatile
 * was the obvious Groq choice one month and a 404 the next. Rather than
 * guessing from documentation that may lag, ask the provider.
 *
 *   npm run llm:models
 */
require('dotenv').config();

const PROVIDER = (process.env.LLM_PROVIDER || 'gemini').toLowerCase();

async function listOpenAICompatible() {
  const base = (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY is not set');

  const response = await fetch(`${base}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text().catch(() => '')}`);
  }
  const data = await response.json();
  const models = (data.data || []).map((m) => ({
    id: m.id,
    context: m.context_window || m.context_length || null,
    owner: m.owned_by || null,
  }));

  console.log(`${models.length} model(s) available at ${base}:\n`);
  models
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((m) => {
      const ctx = m.context ? `${(m.context / 1000).toFixed(0)}k ctx` : '';
      console.log(`  ${m.id.padEnd(42)} ${ctx.padEnd(10)} ${m.owner || ''}`);
    });

  console.log('\nSet the one you want as LLM_MODEL in .env.');
  console.log('Prefer a larger instruct-tuned model: this workload has to follow a');
  console.log('JSON schema and quote evidence verbatim, which small models do poorly.');
}

async function listGemini() {
  const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text().catch(() => '')}`);
  }
  const data = await response.json();
  const models = (data.models || []).filter((m) =>
    (m.supportedGenerationMethods || []).includes('generateContent')
  );

  console.log(`${models.length} model(s) supporting generateContent:\n`);
  models.forEach((m) => {
    console.log(`  ${String(m.name).replace(/^models\//, '').padEnd(42)} ${m.displayName || ''}`);
  });
  console.log('\nSet the one you want as GEMINI_MODEL in .env.');
}

(async () => {
  console.log(`Provider: ${PROVIDER}\n`);
  if (PROVIDER === 'gemini') await listGemini();
  else await listOpenAICompatible();
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
