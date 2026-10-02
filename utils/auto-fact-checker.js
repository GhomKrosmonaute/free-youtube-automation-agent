// Automated evidence review: Claude verifies every factual claim of a production with web search,
// returns one verdict plus sources per claim, and the result is recorded through the ProvenanceService.
// Supported claims become "supported" with verified sources; anything else stays pending so the
// production is held for a human instead of being published on shaky ground.
const Anthropic = require('@anthropic-ai/sdk');
const claudeCode = require('./claude-code-provider');
const { extractJson } = require('./ai-json');
const aiUsage = require('./ai-usage');

const MODEL = process.env.ANTHROPIC_FACTCHECK_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5';
const TYPE_MAP = { primary: 'official', official: 'official', academic: 'article', reference: 'article', news: 'article', article: 'article', video: 'video', other: 'other' };

function enabled() {
  return String(process.env.AUTO_FACT_CHECK || '').toLowerCase() === 'true'
    && (claudeCode.enabled() || Boolean(process.env.ANTHROPIC_API_KEY));
}

async function verifyClaims(claims, context = {}, logger = null) {
  const client = new Anthropic();
  const lang = process.env.CONTENT_LANGUAGE || 'en';
  const prompt = `You are a rigorous fact-checker for a ${lang === 'fr' ? 'French' : lang} YouTube channel. Verify each claim below with web search, preferring primary texts, academic references (encyclopedias of reference, journal pages), official documents, or reputable news. Use one strong source per claim, two for high-risk claims.
Video title: ${context.title || ''}

Claims (id | risk | text):
${claims.map(c => `${c.id} | ${c.riskLevel} | ${c.text}`).join('\n')}

When done, return ONLY a JSON array (no prose before or after), one object per claim, in this exact shape:
[{"id":"claim_...","verdict":"supported|inaccurate|unverifiable","severity":"minor|major","correction":"corrected sentence in ${lang === 'fr' ? 'French' : lang} or empty string","note":"one ${lang === 'fr' ? 'French' : lang} sentence citing the evidence","sources":[{"url":"https://...","title":"...","publisher":"...","sourceType":"primary|academic|reference|news|video|other"}]}]
severity applies to inaccurate claims: "minor" when the substance is right and only a wording, translation or rounding detail is off; "major" when a date, name, number, attribution or causal claim is wrong or unsupported.
Only cite URLs you actually found through search. Never invent URLs.`;

  if (claudeCode.enabled()) {
    // Headless Claude Code with its own web tools; same JSON contract.
    const text = await claudeCode.runClaudeCode({
      prompt, model: process.env.CLAUDE_CODE_FACTCHECK_MODEL || process.env.CLAUDE_CODE_MODEL || 'opus',
      tools: ['WebSearch', 'WebFetch'],
      purpose: 'fact_check'
    });
    const parsedCc = extractJson(text, { prefer: 'array' });
    if (!Array.isArray(parsedCc)) throw new Error(`Fact-check response was not a JSON array: ${text.slice(0, 200)}`);
    logger?.info?.(`Automated fact-check (Claude Code): ${parsedCc.filter(r => r.verdict === 'supported').length}/${claims.length} claims supported`);
    return parsedCc;
  }

  const messages = [{ role: 'user', content: prompt }];
  const params = {
    model: MODEL,
    max_tokens: 32000,
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: Math.min(40, claims.length * 3) }],
    messages
  };
  let response;
  const finish = aiUsage.start('fact_check');
  const used = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, webSearches: 0 };
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      response = await client.messages.stream(params).finalMessage();
      used.inputTokens += response.usage?.input_tokens || 0;
      used.cacheCreationTokens += response.usage?.cache_creation_input_tokens || 0;
      used.cacheReadTokens += response.usage?.cache_read_input_tokens || 0;
      used.outputTokens += response.usage?.output_tokens || 0;
      used.webSearches += response.usage?.server_tool_use?.web_search_requests || 0;
      if (response.stop_reason === 'refusal') throw new Error(`Claude declined the fact-check (${response.stop_details?.category || 'policy'})`);
      if (response.stop_reason !== 'pause_turn') break;
      // Long server-tool turns pause; resume by echoing the assistant turn back.
      params.messages = [...params.messages, { role: 'assistant', content: response.content }];
    }
    finish({ provider: 'anthropic', model: MODEL, ...used, ok: true });
  } catch (error) {
    finish({ provider: 'anthropic', model: MODEL, ...used, ok: false, error: String(error.message).slice(0, 200) });
    throw error;
  }
  const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
  let parsed;
  try {
    parsed = extractJson(text, { prefer: 'array' });
  } catch (error) {
    throw new Error(`Fact-check response had no JSON array: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`Fact-check response was not a JSON array: ${text.slice(0, 200)}`);
  logger?.info?.(`Automated fact-check: ${parsed.filter(r => r.verdict === 'supported').length}/${claims.length} claims supported (${response.usage?.input_tokens || 0} in / ${response.usage?.output_tokens || 0} out tokens)`);
  return parsed;
}

// Turns verdicts into a provenance review payload the ProvenanceService accepts.
function buildReviewPayload(existing, verdicts) {
  const sources = new Map((existing.sources || []).map(s => [s.url, s]));
  const byId = new Map(verdicts.map(v => [v.id, v]));
  const stamp = new Date().toISOString().slice(0, 10);
  const claims = (existing.claims || []).map(claim => {
    const verdict = byId.get(claim.id);
    if (!verdict) return claim;
    const ids = [];
    for (const src of verdict.sources || []) {
      const url = String(src.url || '').replace(/&amp;/g, '&').trim();
      if (!/^https?:\/\//.test(url)) continue;
      if (!sources.has(url)) {
        sources.set(url, {
          id: `source_auto_${sources.size + 1}`, url,
          title: String(src.title || url).slice(0, 300), publisher: String(src.publisher || '').slice(0, 200),
          sourceType: TYPE_MAP[String(src.sourceType || 'other').toLowerCase()] || 'other',
          status: 'verified', notes: `Vérifié automatiquement le ${stamp} (Claude + recherche web).`
        });
      }
      ids.push(sources.get(url).id);
    }
    const supported = verdict.verdict === 'supported' && ids.length > 0;
    // A minor inaccuracy (wording/translation nuance with the substance right) is waived with the
    // correction on record; anything major or unverifiable stays pending for a human.
    const minor = verdict.verdict === 'inaccurate' && String(verdict.severity || '').toLowerCase() === 'minor'
      && String(process.env.AUTO_FACT_CHECK_WAIVE_MINOR ?? 'true').toLowerCase() === 'true';
    return {
      ...claim,
      sourceIds: [...new Set([...(claim.sourceIds || []), ...ids])],
      status: supported ? 'supported' : minor ? 'waived' : 'pending',
      notes: [minor ? 'Imprécision mineure levée automatiquement.' : '', verdict.note, verdict.correction ? `Correction proposée : ${verdict.correction}` : ''].filter(Boolean).join(' ').slice(0, 1000)
    };
  });
  return { sources: [...sources.values()], claims, containsSyntheticMedia: existing.containsSyntheticMedia === true };
}

async function autoReview(provenanceService, productionId, context = {}, logger = null) {
  const existing = await provenanceService.db.getContentProvenance(productionId);
  const pending = (existing?.claims || []).filter(claim => claim.status === 'pending');
  if (!pending.length) return existing;
  const verdicts = await verifyClaims(pending, context, logger);
  const payload = buildReviewPayload(existing, verdicts);
  await provenanceService.review(productionId, payload);
  return provenanceService.db.getContentProvenance(productionId);
}

module.exports = { enabled, verifyClaims, buildReviewPayload, autoReview };
