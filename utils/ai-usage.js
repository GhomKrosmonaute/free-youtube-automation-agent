// Measures what every text-model call costs, to know where the Claude Code quota goes before changing anything.
// One JSON line per call in data/ai-usage.jsonl (AI_USAGE_LOG moves it, AI_USAGE_LOG=off stops it): what the call was
// for, the model, the tokens (cache included), the cost Claude Code reports at list price, the duration, and the
// generation job it served. `npm run ai-usage` sums it up.
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

const context = new AsyncLocalStorage();

function logPath() {
  const configured = String(process.env.AI_USAGE_LOG || '').trim();
  if (configured.toLowerCase() === 'off') return null;
  return configured || path.join(__dirname, '..', 'data', 'ai-usage.jsonl');
}

// Everything called inside fn (awaited or not) is attributed to ctx, e.g. { jobId }.
function withContext(ctx, fn) {
  return context.run({ ...(context.getStore() || {}), ...ctx }, fn);
}

// A call without a purpose is named after the first frame outside the text services.
function caller() {
  const frames = String(new Error().stack || '').split('\n').slice(1);
  const frame = frames.find(line => /\(?\//.test(line) && !/ai-usage\.js|ai-text-service\.js|claude-code-provider\.js|node:/.test(line));
  const match = frame?.match(/at (?:async )?(?:(\S+) \()?.*?([^/\s]+\.js):(\d+)/);
  return match ? `${match[1] ? `${match[1]} ` : ''}${match[2]}:${match[3]}` : 'unknown';
}

// Called when a request starts, while its caller is still on the stack; returns the function that records it once
// done. Never throws: a measurement must not break the generation it measures.
function start(purpose = null) {
  const begun = Date.now();
  const store = context.getStore() || {};
  const base = { purpose: purpose || caller(), ...(store.jobId ? { jobId: store.jobId } : {}) };
  return (entry = {}) => {
    const file = logPath();
    if (!file) return;
    try {
      const line = { at: new Date(begun).toISOString(), ...base, durationMs: Date.now() - begun, ...entry };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
    } catch (_error) {
      // Measurement is best effort.
    }
  };
}

// What `claude -p --output-format json` reports, in the shape recorded.
function fromClaudeCode(result = {}) {
  const usage = result.usage || {};
  return {
    model: Object.keys(result.modelUsage || {}).join('+') || null,
    inputTokens: usage.input_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    webSearches: usage.server_tool_use?.web_search_requests || 0,
    costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
    turns: result.num_turns || null
  };
}

function read({ since = null, file = logPath() } = {}) {
  if (!file || !fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try {
      const entry = JSON.parse(line);
      return !since || entry.at >= since ? [entry] : [];
    } catch (_error) {
      return [];
    }
  });
}

// Totals per purpose (or any key), the most expensive first.
function summarize(entries, key = entry => entry.purpose) {
  const groups = new Map();
  for (const entry of entries) {
    const name = key(entry) || 'unknown';
    const group = groups.get(name) || {
      name, calls: 0, failures: 0, inputTokens: 0, cacheTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0, durationMs: 0
    };
    group.calls += 1;
    if (entry.ok === false) group.failures += 1;
    group.inputTokens += (entry.inputTokens || 0) + (entry.cacheCreationTokens || 0) + (entry.cacheReadTokens || 0);
    group.cacheTokens += (entry.cacheCreationTokens || 0) + (entry.cacheReadTokens || 0);
    group.outputTokens += entry.outputTokens || 0;
    group.webSearches += entry.webSearches || 0;
    group.costUsd += entry.costUsd || 0;
    group.durationMs += entry.durationMs || 0;
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => b.costUsd - a.costUsd || b.inputTokens - a.inputTokens);
}

module.exports = { withContext, start, fromClaudeCode, read, summarize, logPath };
