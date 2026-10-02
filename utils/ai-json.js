// Extracts the first JSON object or array from a model response that may contain
// prose, markdown fences, or trailing commentary. Throws when nothing parses.
function extractJson(response, options = {}) {
  const text = String(response || '').trim();
  const candidates = [];
  const unfenced = text.replace(/```(?:json)?/gi, '').trim();
  candidates.push(unfenced);
  if (options.prefer === 'array') {
    // Prose around the array: try every '[' start until one parses.
    let from = 0;
    while ((from = unfenced.indexOf('[', from)) !== -1 && candidates.length < 12) {
      candidates.push(unfenced.slice(from, unfenced.lastIndexOf(']') + 1));
      from += 1;
    }
  }
  const shapes = options.prefer === 'array' ? [['[', ']'], ['{', '}']] : [['{', '}'], ['[', ']']];
  for (const [open, close] of shapes) {
    const start = unfenced.indexOf(open);
    const end = unfenced.lastIndexOf(close);
    if (start !== -1 && end > start) candidates.push(unfenced.slice(start, end + 1));
    // Commentary after the JSON may hold braces of its own: the first complete value stops at its own closing.
    const first = start === -1 ? null : balanced(unfenced, start, open, close);
    if (first) candidates.push(first);
    // A model sometimes stops right before the last closing bracket(s): close what is still open.
    const closed = start === -1 ? null : closeTruncated(unfenced, start);
    if (closed) candidates.push(closed);
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('No JSON found in model response');
}

// The complete JSON value opening at `start`, skipping brackets inside strings; null when it never closes.
function balanced(text, start, open, close) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === open) {
      depth++;
    } else if (char === close && --depth === 0) {
      return text.slice(start, index + 1);
    }
  }
  return null;
}

// The value opening at `start` with its missing closing brackets added, when the text ends outside a string with
// brackets still open; null otherwise.
function closeTruncated(text, start) {
  const closers = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      closers.push(char === '{' ? '}' : ']');
    } else if (char === '}' || char === ']') {
      closers.pop();
      if (!closers.length) return null;
    }
  }
  if (inString || !closers.length) return null;
  return `${text.slice(start).trimEnd()}${closers.reverse().join('')}`;
}

module.exports = { extractJson };
