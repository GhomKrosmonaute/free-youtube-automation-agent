// Jev (TypeSafe), a "System One" model: typed answers about a text (the probability of a yes, a choice among options, a
// score on levels) and no generated text, for a fraction of a cent. Used where a quick judgment spares a Claude call:
// the first sort of the expert review (utils/expert-review-service.js). TYPESAFE_API_KEY enables it, JEV=off turns it off.
// Each request is recorded in the usage measurement (npm run ai-usage).
const axios = require('axios');
const aiUsage = require('./ai-usage');

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Launch price, input only: $0.042 per million tokens; output is free.
const PRICE_PER_INPUT_TOKEN = 0.042 / 1e6;
// Rate limited, overloaded or briefly down: worth another try.
const RETRYABLE = [429, 500, 502, 503, 529];

function enabled() {
  return Boolean(String(process.env.TYPESAFE_API_KEY || '').trim()) && String(process.env.JEV || '').trim().toLowerCase() !== 'off';
}

// questions: { key: { type: 'noul' | 'choice' | 'score', instructions, criteria } }; returns the answers by key.
async function ask({ state, questions, purpose = null, http = axios, retries = 2, delayMs = 1000 }) {
  const finish = aiUsage.start(purpose);
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data } = await http.post(ENDPOINT, { state, model: process.env.JEV_MODEL || 'jev-latest', questions }, {
        headers: { Authorization: `Bearer ${String(process.env.TYPESAFE_API_KEY || '').trim()}` },
        timeout: 30000
      });
      const inputTokens = data?.usage?.input_tokens || 0;
      finish({
        provider: 'jev',
        model: data?.model || null,
        inputTokens,
        outputTokens: data?.usage?.output_tokens || 0,
        costUsd: inputTokens * PRICE_PER_INPUT_TOKEN,
        ok: true
      });
      return data?.answers || {};
    } catch (error) {
      lastError = error;
      if (!RETRYABLE.includes(error.response?.status) || attempt === retries) break;
      await new Promise(resolve => setTimeout(resolve, delayMs * 2 ** attempt));
    }
  }
  const reason = lastError.response?.status ? `HTTP ${lastError.response.status}` : lastError.message;
  finish({ provider: 'jev', ok: false, error: String(reason).slice(0, 200) });
  throw new Error(`Jev request failed: ${reason}`);
}

module.exports = { enabled, ask, PRICE_PER_INPUT_TOKEN };
