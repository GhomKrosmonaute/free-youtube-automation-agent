// YouTube chapters from the measured scene timeline. YouTube only shows chapters when the description lists at
// least three timestamps in ascending order, the first one at 0:00, each chapter lasting at least ten seconds.
const { displayLabel } = require('./visualizer');
const { extractJson } = require('./ai-json');
const { registerOf } = require('./content-mode');
const { reactProfile, twoPartVideos } = require('./react-profile');

const MIN_CHAPTER_SECONDS = 10;
const MIN_CHAPTERS = 3;
const MAX_TITLE_LENGTH = 60;
const TIMESTAMP_LINE = /^\s*\(?(\d{1,2}(?::\d{2}){1,2})\)?\s*[-–—:]?\s+(\S.*)$/;
const HEADINGS = /^\s*(?:⏱️\s*)?(?:CHAPITRES|CHAPTERS|TIMESTAMPS|HORODATAGES)\s*:?\s*$/i;
const NEXT_BLOCKS = /^(SOURCES|MUSIQUE|MUSIC|IMAGES ET TEXTES CITÉS|IMAGE AND TEXT CREDITS)\b/;

function language() {
  return (process.env.CONTENT_LANGUAGE || 'en') === 'fr' ? 'fr' : 'en';
}

function formatTimestamp(seconds, withHours = false) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return withHours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${String(minutes + hours * 60).padStart(2, '0')}:${secs}`;
}

function parseTimestamp(value) {
  return String(value).split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}

// Chapters as spans of scenes: the hook opens the first chapter at 0:00, scenes without a title of their own
// (the call to action, internal labels) close the chapter they follow, and a chapter shorter than ten seconds
// (on the whole seconds YouTube reads) is folded into its neighbour.
function chapterSpans(scenes, { registers = [] } = {}) {
  const spans = [];
  let cursor = 0;
  for (const scene of [...scenes].sort((a, b) => a.position - b.position)) {
    const duration = Math.max(0, Number(scene.duration) || 0);
    const title = displayLabel(scene.label);
    const text = String(scene.scriptText || '').trim();
    const current = spans[spans.length - 1];
    if (title && !(current && !current.title)) {
      spans.push({ start: cursor, end: cursor + duration, title, sceneIds: [scene.id], text, register: registers[scene.position] || null });
    } else if (current) {
      // An untitled opening (the hook) takes the title of the first titled scene; any other untitled scene joins.
      if (title) {
        current.title = title;
        current.register = registers[scene.position] || current.register;
      }
      current.end = cursor + duration;
      current.sceneIds.push(scene.id);
      current.text = `${current.text} ${text}`.trim();
    } else {
      spans.push({ start: cursor, end: cursor + duration, title: '', sceneIds: [scene.id], text, register: registers[scene.position] || null });
    }
    cursor += duration;
  }
  const length = span => Math.floor(span.end) - Math.floor(span.start);
  let merged = true;
  while (merged && spans.length > 1) {
    merged = false;
    const index = spans.findIndex(span => length(span) < MIN_CHAPTER_SECONDS);
    if (index === -1) break;
    const into = index === 0 ? 1 : index - 1;
    const [first, second] = index === 0 ? [spans[0], spans[1]] : [spans[into], spans[index]];
    const combined = {
      start: first.start, end: second.end,
      title: (index === 0 ? second.title : first.title) || first.title || second.title,
      sceneIds: [...first.sceneIds, ...second.sceneIds],
      text: `${first.text} ${second.text}`.trim(),
      register: (index === 0 ? second.register : first.register) || first.register || second.register
    };
    spans.splice(Math.min(index, into), 2, combined);
    merged = true;
  }
  if (spans.length) spans[0].start = 0;
  return spans.map(span => ({ ...span, duration: span.end - span.start }));
}

// Errors that would stop YouTube from showing the chapters (an empty list means they are valid).
function validateChapters(chapters, totalDuration = null) {
  const errors = [];
  if (chapters.length < MIN_CHAPTERS) errors.push(`at least ${MIN_CHAPTERS} chapters are required (${chapters.length})`);
  if (chapters.length && Math.floor(chapters[0].start) !== 0) errors.push('the first chapter must start at 00:00');
  const seen = new Set();
  chapters.forEach((chapter, index) => {
    const start = Math.floor(chapter.start);
    const next = index + 1 < chapters.length
      ? Math.floor(chapters[index + 1].start)
      : (Number.isFinite(Number(totalDuration)) && totalDuration !== null ? Math.floor(Number(totalDuration)) : null);
    if (next !== null && next - start < MIN_CHAPTER_SECONDS) {
      errors.push(`chapter ${index + 1} lasts ${Math.max(0, next - start)}s (minimum ${MIN_CHAPTER_SECONDS}s)`);
    }
    const title = String(chapter.title || '').trim();
    if (!title) errors.push(`chapter ${index + 1} has no title`);
    else if (!displayLabel(title)) errors.push(`chapter ${index + 1} has an internal label as title ("${title}")`);
    if (title.length > 100) errors.push(`chapter ${index + 1} title is too long`);
    const key = title.toLowerCase();
    if (title && seen.has(key)) errors.push(`chapter ${index + 1} repeats the title "${title}"`);
    seen.add(key);
  });
  return errors;
}

function formatChapterBlock(chapters, { totalDuration = 0, lang = language() } = {}) {
  if (validateChapters(chapters, totalDuration || null).length) return '';
  const withHours = Number(totalDuration) >= 3600 || chapters.some(chapter => chapter.start >= 3600);
  return `${lang === 'fr' ? 'CHAPITRES' : 'CHAPTERS'}\n${chapters.map(chapter => `${formatTimestamp(chapter.start, withHours)} ${String(chapter.title).trim()}`).join('\n')}`;
}

// The first run of timestamp lines in a description, as YouTube reads it.
function parseChapters(description) {
  const chapters = [];
  for (const line of String(description || '').split('\n')) {
    const match = line.match(TIMESTAMP_LINE);
    if (match) {
      chapters.push({ start: parseTimestamp(match[1]), title: match[2].trim() });
    } else if (chapters.length && line.trim()) {
      break;
    }
  }
  return chapters;
}

// Removes every chapter list from a description: headed blocks, stray timestamp lines and the one-line form left
// by the old upload path that dropped line breaks ("CHAPITRES 00:00 Titre 01:33 Titre SOURCES …").
function stripTimestamps(description) {
  const lines = String(description || '').replace(/\r\n?/g, '\n').split('\n')
    .filter(line => !HEADINGS.test(line) && !TIMESTAMP_LINE.test(line))
    .map(line => line.replace(/(?:^|\s)(?:CHAPITRES|CHAPTERS)\s*:?\s+\d{1,2}:\d{2}(?::\d{2})?\s.*?(?=\s(?:SOURCES|MUSIQUE|MUSIC|IMAGES ET TEXTES CITÉS|IMAGE AND TEXT CREDITS)\b|$)/, '').trimEnd());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Replaces the chapter list of a description with `block`, where the old list was, or before the sources and
// credits, or at the end.
function replaceChapterBlock(description, block) {
  const text = String(description || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const headingIndex = lines.findIndex((line, index) => HEADINGS.test(line) && TIMESTAMP_LINE.test(lines[index + 1] || ''));
  const stripped = stripTimestamps(text);
  if (!block) return stripped;
  const paragraphs = stripped ? stripped.split('\n\n') : [];
  let at = paragraphs.findIndex(paragraph => NEXT_BLOCKS.test(paragraph.trim()));
  if (headingIndex !== -1) {
    // Count the paragraphs that came before the old heading.
    const before = stripTimestamps(lines.slice(0, headingIndex).join('\n'));
    at = before ? before.split('\n\n').length : 0;
  }
  if (at === -1) at = paragraphs.length;
  paragraphs.splice(at, 0, block);
  return paragraphs.join('\n\n');
}

// Titles that name what each chapter actually explains, read from its narration. The scene's on-screen title is
// the hint; it is kept when it is already accurate. Without a text model the scene titles stay.
async function titleChapters(spans, aiTextService, { lang = language(), logger = null, model = null } = {}) {
  const fallback = spans.map(span => span.title || firstWords(span.text));
  if (!spans.length || !aiTextService?.isAvailable?.()) return fallback;
  const twoPart = twoPartVideos();
  const listing = spans.map((span, index) =>
    `[${index + 1}] (${formatTimestamp(span.start)}${twoPart ? `, ${registerOf(span.register)}` : ''}) on-screen title: "${span.title || ''}"\nNarration: «${truncate(span.text, 1600)}»`
  ).join('\n\n');
  const prompt = `You write the chapter titles of a YouTube video's description. YouTube shows them on the progress bar and viewers use them to jump to a part, so each title must say what that chapter actually explains.
Rules for every title, written in the language with ISO code "${lang}":
- 3 to 8 words, at most 50 characters.
- Specific to what the narration of that chapter says: the experiment, author, text, concept or claim it deals with. A viewer reading only the title knows what they will hear.
- No teaser that the chapter does not deliver, no clickbait, no emoji, no numbering, no quotation marks around the whole title. A question only if the chapter is built around that question and answers it.
${twoPart ? `- ${reactProfile().script?.openingChapterRule || 'Chapters marked "opening" belong to the first part of the video: describe what they say, never the conclusion that comes later.'}\n` : ''}- All titles are different.
The on-screen title is a hint: keep it unchanged when it already names the chapter's content accurately.

${listing}

Return only JSON: {"titles": ["…"]} with exactly ${spans.length} titles in the order above.`;
  try {
    const response = await aiTextService.generateText(prompt, { ...(model ? { model } : {}), maxTokens: 1200, temperature: 0.2, purpose: 'chapter_titles' });
    const parsed = extractJson(response);
    const titles = Array.isArray(parsed) ? parsed : parsed?.titles;
    if (!Array.isArray(titles) || titles.length !== spans.length) throw new Error('wrong number of titles');
    const seen = new Set();
    return titles.map((value, index) => {
      let title = String(value || '').replace(/\s+/g, ' ').trim();
      // Quotation marks around the whole title go; a quotation inside it keeps both of its marks.
      if (/^[«"“][^«"“»”]*[»"”]$/.test(title)) title = title.slice(1, -1).trim();
      const usable = title && title.length <= MAX_TITLE_LENGTH && displayLabel(title) && !seen.has(title.toLowerCase());
      const chosen = usable ? title : fallback[index];
      seen.add(String(chosen).toLowerCase());
      return chosen;
    });
  } catch (error) {
    logger?.warn?.(`Chapter titles kept from the scenes: ${String(error.message).slice(0, 200)}`);
    return fallback;
  }
}

function truncate(value, maximum) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
}

function firstWords(text) {
  const sentence = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s/)[0] || '';
  return sentence.length > 50 ? `${sentence.slice(0, 49).replace(/\s+\S*$/, '')}…` : sentence.replace(/[.!…]+$/, '');
}

module.exports = {
  MIN_CHAPTER_SECONDS, MIN_CHAPTERS,
  chapterSpans, titleChapters, validateChapters, formatChapterBlock, formatTimestamp,
  parseChapters, stripTimestamps, replaceChapterBlock
};
