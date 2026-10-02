// Text generation through the local Claude Code CLI in headless mode (`claude -p`).
// Runs on the user's Claude Code login instead of API credits. Prompts go through stdin,
// the system prompt through --append-system-prompt, optional tools through --allowedTools. The JSON output carries the
// answer and what the call used, recorded per purpose (utils/ai-usage.js).
const { spawn } = require('child_process');
const aiUsage = require('./ai-usage');

function enabled() {
  return String(process.env.TEXT_PROVIDER || '').toLowerCase() === 'claude-code';
}

function binary() {
  return process.env.CLAUDE_CODE_BIN || 'claude';
}

function runClaudeCode({ prompt, system = '', model = null, tools = [], timeoutMs = null, purpose = null }) {
  const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
  if (model) args.push('--model', model);
  if (system) args.push('--append-system-prompt', system);
  if (tools.length) args.push('--allowedTools', tools.join(','));
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  // The CLI must use the claude.ai login, never an API key or token from the pipeline's environment.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_PROFILE;
  const finish = aiUsage.start(purpose);
  return new Promise((resolve, reject) => {
    const child = spawn(binary(), args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error, measured = {}) => {
      if (settled) return;
      settled = true;
      finish({ provider: 'claude-code', ...measured, model: measured.model || model, ok: false, error: error.message.slice(0, 200) });
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`Claude Code timed out after ${Math.round((timeoutMs || 0) / 1000)}s`));
    }, timeoutMs || Number(process.env.CLAUDE_CODE_TIMEOUT_MS || 15 * 60 * 1000));
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); fail(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const output = stdout.trim();
      let result = null;
      try {
        result = output ? JSON.parse(output) : null;
      } catch (_error) {
        // Not the JSON result (an older CLI): the output is the answer.
      }
      const measured = result ? aiUsage.fromClaudeCode(result) : {};
      if (code !== 0 || result?.is_error) {
        const reason = String((result?.is_error && (result.result || result.subtype)) || stderr).trim();
        return fail(new Error(`Claude Code ${code !== 0 ? `exited with code ${code}` : 'failed'}: ${reason.slice(-400)}`), measured);
      }
      const text = result ? String(result.result ?? '').trim() : output;
      if (!text) return fail(new Error(`Claude Code returned an empty response${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}`), measured);
      settled = true;
      finish({ provider: 'claude-code', ...measured, model: measured.model || model, ok: true });
      resolve(text);
    });
    child.stdin.end(prompt);
  });
}

module.exports = { enabled, runClaudeCode };
