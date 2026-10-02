// Visual insert agent: decides where a card in the middle of the screen makes the narration clearer (a scripture
// passage, an equation, a person's portrait, a document or place, a quotation, a key figure), fetches verified
// material for it (scripture APIs, free Wikipedia / Commons images, never model-written verse text), and times
// each card on the narration's word timings. Most of the video stays on the background illustration: cards are
// spaced out and capped to a share of the running time.
const path = require('path');
const { Logger } = require('../utils/logger');
const { AITextService } = require('../utils/ai-text-service');
const { extractJson } = require('../utils/ai-json');
const { readWordTimings } = require('../utils/narration-timing');
const { displayLabel } = require('../utils/visualizer');
const { scriptureVerses, wikipediaImage } = require('../utils/insert-sources');
const { renderCards, sanitizeMathML } = require('../utils/insert-cards');

const KINDS = ['verse', 'equation', 'person', 'image', 'quote', 'figure'];
// Lower is more important: what must be shown wins a conflict over what merely can be.
const PRIORITY = { verse: 0, equation: 0, person: 1, quote: 1, image: 2, figure: 2 };
const MAX_SHARE = 0.3; // at most 30 % of the running time under a card
const MIN_GAP_SECONDS = 8; // background-only time between two cards
const LEAD_SECONDS = 0.25; // a card appears just before its first word
const MAX_DELAY_SECONDS = 5; // how late a card may appear after its anchor (waiting for the chapter card)
const MIN_SECONDS = 3;
const TITLE_CARD_SECONDS = 5; // renderSceneClip's opening title card (first scene)
const CHAPTER_CARD_SECONDS = 4; // renderSceneClip's chapter card (every scene with a displayable label)
const WIKI_LANGUAGES = { fr: 'French', en: 'English', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese' };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const normalizeToken = token => String(token || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

// Index of the token where `anchor` (a few words copied from the narration) starts, or -1. Punctuation-only tokens
// ("?", "—", "«") are skipped on both sides. When the model altered a word, the anchor's first four and first
// three words are tried too, but a shortened anchor must match only once.
function findAnchor(tokens, anchor) {
  const keys = tokens.map(normalizeToken);
  const wanted = String(anchor || '').split(/\s+/).map(normalizeToken).filter(Boolean);
  if (!wanted.length) return -1;
  const matchesAt = probe => {
    const found = [];
    for (let i = 0; i < keys.length; i++) {
      if (!keys[i]) continue;
      let j = i;
      let k = 0;
      while (j < keys.length && k < probe.length) {
        if (!keys[j]) { j++; continue; }
        if (keys[j] !== probe[k]) break;
        j++;
        k++;
      }
      if (k === probe.length) found.push(i);
    }
    return found;
  };
  const full = matchesAt(wanted);
  if (full.length) return full[0];
  for (const size of [4, 3]) {
    if (wanted.length <= size) continue;
    const found = matchesAt(wanted.slice(0, size));
    if (found.length === 1) return found[0];
  }
  return -1;
}

// Seconds into the scene where the anchor is spoken: the word timing when the TTS provided one, otherwise the
// anchor's position in the text spread over the scene duration.
function anchorSeconds(text, durationSeconds, words, anchor) {
  if (words && words.length) {
    const index = findAnchor(words.map(word => word.text), anchor);
    return index === -1 ? null : words[index].start;
  }
  const tokens = String(text || '').split(/\s+/).filter(Boolean);
  const index = findAnchor(tokens, anchor);
  if (index === -1) return null;
  const before = tokens.slice(0, index).join(' ').length;
  return (before / Math.max(1, tokens.join(' ').length)) * durationSeconds;
}

// How long a card stays: long enough to read it, never so long it becomes a slide.
function holdSeconds(card) {
  const words = text => String(text || '').split(/\s+/).filter(Boolean).length;
  switch (card.kind) {
    case 'verse': return clamp(2.5 + words(card.verses.map(verse => verse.text).join(' ')) / 3, 5, 12);
    case 'quote': return clamp(2.5 + words(card.text) / 3, 4.5, 10);
    case 'equation': return clamp(4.5 + 1.5 * (card.mathml.match(/<mtr\b/g) || [1]).length, 6, 10);
    case 'person': return 5.5;
    case 'image': return 6;
    default: return 4.5;
  }
}

// The opening seconds of a scene already carry the title or chapter card.
function openingCardSeconds(segment, title) {
  if (segment.position === 0 && title) return TITLE_CARD_SECONDS;
  return displayLabel(segment.label) ? CHAPTER_CARD_SECONDS : 0;
}

// Scene-relative window for a card, or null when it cannot be shown close enough to its anchor. A subject
// introduced in the scene's first words waits for the chapter card to clear: the narration is still on it.
function cardWindow({ anchorAt, hold, sceneDuration, openingCard }) {
  let start = Math.max(0, anchorAt - LEAD_SECONDS);
  if (openingCard && start < openingCard + 0.3) {
    start = openingCard + 0.3;
    if (start - anchorAt > MAX_DELAY_SECONDS) return null;
  }
  const end = Math.min(start + hold, sceneDuration - 0.3);
  return end - start >= MIN_SECONDS ? { start, end } : null;
}

// Keeps the most important cards first, then in time order, as long as each one leaves MIN_GAP_SECONDS of
// background around it and the total stays under MAX_SHARE of the video. Cards carry global times (at, until).
function selectCards(cards, totalSeconds) {
  const budget = totalSeconds * MAX_SHARE;
  const kept = [];
  let used = 0;
  const ordered = cards.slice().sort((a, b) => (PRIORITY[a.kind] - PRIORITY[b.kind]) || (a.at - b.at));
  for (const card of ordered) {
    const length = card.until - card.at;
    if (used + length > budget) continue;
    if (kept.some(other => card.at < other.until + MIN_GAP_SECONDS && other.at < card.until + MIN_GAP_SECONDS)) continue;
    kept.push(card);
    used += length;
  }
  return kept.sort((a, b) => a.at - b.at);
}

const subjectOf = item => String(item.name || item.wikipedia || (item.book ? `${item.book} ${item.chapter}:${item.verses}` : '') || item.author || item.value || item.caption || '').slice(0, 50);

// The same person, image or passage is shown once.
function subjectKey(item) {
  if (item.kind === 'verse') return `verse:${normalizeToken(item.book)}:${item.chapter}:${item.verses}`;
  if (item.kind === 'person' || item.kind === 'image') return `wiki:${normalizeToken(item.wikipedia || item.name)}`;
  return null;
}

class VisualInsertAgent {
  constructor({ credentials = {}, aiTextService = null, logger = null } = {}) {
    this.credentials = credentials;
    this.aiText = aiTextService;
    this.logger = logger || new Logger('VisualInserts');
  }

  static enabled() {
    return !['off', 'false', '0', 'no'].includes(String(process.env.VISUAL_INSERTS || '').toLowerCase());
  }

  buildPrompt(script, scenes, totalSeconds) {
    const language = String(process.env.CONTENT_LANGUAGE || 'en').slice(0, 2);
    const wiki = WIKI_LANGUAGES[language] || 'English';
    const maxCards = Math.max(3, Math.round(totalSeconds / 30));
    const list = scenes.map(scene => `Scene ${scene.number} (starts at ${clock(scene.offset)}, ${Math.round(scene.duration)} s)${displayLabel(scene.label) ? ` — ${scene.label}` : ''}\n${scene.text}`).join('\n\n');
    return `You are the visual editor of a documentary YouTube video titled "${script.title || ''}". While the narrator speaks, a card can appear in the middle of the screen for a few seconds to show what is being talked about: it makes the video more concrete and more engaging. Illustrate what can be shown, and above all what must be: about one card every 30 to 40 seconds wherever the narration offers something concrete, up to ${maxCards} cards for this ${Math.round(totalSeconds / 60)}-minute video, never two within 20 seconds of each other, so that the background illustration still carries most of the video. Never add a card that only repeats a vague idea.

Show a card when the narration dwells on:
- a scripture passage that is quoted, paraphrased or analysed (Bible or Quran) → "verse".
- a formula, equation, calculation, probability, expected value, comparison of quantities or any quantitative reasoning → "equation". The narration is written to be read aloud, so it spells formulas out in words ("une chance sur deux", "le double de", "multiplié par"): write the equation or the calculation it describes. Most important kind with verses.
- a historical or public figure the narration talks about (not a passing mention in a list) → "person", once per person.
- a document, book, artwork, artefact, manuscript, place or event whose ${wiki} Wikipedia article has a representative image → "image".
- a short quotation attributed to a named author, when the narration says it word for word → "quote".
- a date or number that carries the argument → "figure".

Each card is a JSON object with:
- "scene": the scene number;
- "anchor": 3 to 8 consecutive words copied exactly, character for character, from that scene's narration, where the card must appear (the first words of the sentence that introduces the subject);
- "kind" and its fields:
  - verse: "book" (the Bible book's name in ${wiki}, e.g. "Genèse", "1 Corinthiens", or "Coran" for the Quran), "chapter" (the surah number for the Quran), "verses" ("14" or "12-14": the one to three verses that matter most). The verse text is fetched from a reference translation: do not write it.
  - equation: "mathml": one <math> element in MathML Core (mi, mn, mo, mtext, mrow, mfrac, msup, msub, msqrt, mroot, munderover; an mtable with one mtr per step for a calculation of up to 3 steps), "caption": a label of at most 5 words. Write a real formula with symbols and one-letter variables (e.g. v = d / t); words only as short mtext labels of 1 to 3 words, never a sentence. A formula cannot wrap: keep each line under about 25 symbols and put a longer calculation or a comparison on several mtr rows.
  - person: "wikipedia": the exact title of the person's ${wiki} Wikipedia article, "name": the name to display, "caption": dates and role in at most 8 words (e.g. "1867–1934 · physicienne et chimiste").
  - image: "wikipedia": the exact title of the ${wiki} Wikipedia article whose main image shows it, "caption": at most 10 words.
  - quote: "text": the quotation exactly as the narration says it, "author", "source" (work and year, optional).
  - figure: "value": the date or number as it should be displayed (e.g. "1440", "3 %", "40 jours"), "caption": at most 8 words.

Everything written on a card must come from the narration. Return only a JSON array ordered by scene, or [] if nothing deserves a card.

Scenes:

${list}`;
  }

  // Picking moments in a finished script is a light task (AITextService.lightModel). VISUAL_INSERTS_MODEL overrides
  // it with a Claude Code alias or an API model id.
  planModel() {
    return process.env.VISUAL_INSERTS_MODEL || this.aiText.lightModel();
  }

  async plan(script, scenes, totalSeconds) {
    this.aiText = this.aiText || new AITextService(this.credentials?.credentials || this.credentials || {});
    this.model = this.planModel();
    const response = await this.aiText.generateText(this.buildPrompt(script, scenes, totalSeconds), { model: this.model, maxTokens: 6000, temperature: 0.4, purpose: 'visual_inserts' });
    const items = extractJson(response, { prefer: 'array' });
    return Array.isArray(items) ? items : [];
  }

  // Verified content for one planned card, or null (unknown reference, no free image, altered quotation...).
  async resolve(item, scene, cacheDir) {
    switch (item.kind) {
      case 'verse': {
        const passage = await scriptureVerses(item);
        return passage && { kind: 'verse', ...passage };
      }
      case 'equation': {
        const mathml = sanitizeMathML(item.mathml);
        return mathml && { kind: 'equation', mathml, caption: String(item.caption || '').slice(0, 60) };
      }
      case 'person':
      case 'image': {
        const image = await wikipediaImage(String(item.wikipedia || item.name || ''), cacheDir);
        if (!image) return null;
        const name = item.kind === 'person' ? String(item.name || image.article).slice(0, 60) : undefined;
        return { kind: item.kind, image, name, caption: String(item.caption || '').slice(0, 90) };
      }
      case 'quote': {
        // A quotation is shown only if the narration really says it word for word.
        const words = String(item.text || '').split(/\s+/).filter(Boolean);
        if (words.length < 3 || !item.author || !normalizeToken(scene.text).includes(words.map(normalizeToken).join(''))) return null;
        return { kind: 'quote', text: String(item.text).trim(), author: String(item.author).slice(0, 60), source: item.source ? String(item.source).slice(0, 80) : '' };
      }
      case 'figure': {
        const value = String(item.value || '').trim();
        return value && value.length <= 14 ? { kind: 'figure', value, caption: String(item.caption || '').slice(0, 70) } : null;
      }
      default:
        return null;
    }
  }

  // segments: the narrated scenes ({ position, label, text, register, path, duration }).
  // Returns the cards per scene position ([{ path, start, end, kind }], scene-relative seconds) and the credits.
  async prepare({ script = {}, segments = [], outputDir, cacheDir }) {
    const empty = { byScene: new Map(), items: [], credits: [] };
    if (!segments.length) return empty;
    let offset = 0;
    const scenes = [];
    for (const [index, segment] of segments.entries()) {
      scenes.push({
        ...segment, number: index + 1, offset, text: String(segment.text || ''),
        words: await readWordTimings(segment.path), openingCard: openingCardSeconds(segment, script.title)
      });
      offset += Number(segment.duration) || 0;
    }
    const totalSeconds = offset;

    const planned = await this.plan(script, scenes, totalSeconds);
    const candidates = [];
    const dropped = [];
    const drop = (item, reason) => dropped.push(`${item?.kind || '?'} "${subjectOf(item || {})}" (${reason})`);
    const seen = new Set();
    for (const item of planned) {
      const scene = scenes[Number(item?.scene) - 1];
      if (!scene || !KINDS.includes(item.kind)) { drop(item, 'invalid'); continue; }
      const key = subjectKey(item);
      if (key && seen.has(key)) { drop(item, 'duplicate'); continue; }
      const anchorAt = anchorSeconds(scene.text, scene.duration, scene.words, item.anchor);
      if (anchorAt === null) { drop(item, `anchor not in scene ${scene.number}`); continue; }
      let card = null;
      try {
        card = await this.resolve(item, scene, cacheDir);
      } catch (error) {
        drop(item, error.message.slice(0, 80));
        continue;
      }
      if (!card) { drop(item, 'no verified source'); continue; }
      const window = cardWindow({ anchorAt, hold: holdSeconds(card), sceneDuration: scene.duration, openingCard: scene.openingCard });
      if (!window) { drop(item, 'no room in the scene'); continue; }
      if (key) seen.add(key);
      candidates.push({ ...card, item, register: scene.register, position: scene.position, ...window, at: scene.offset + window.start, until: scene.offset + window.end });
    }

    const selected = selectCards(candidates, totalSeconds);
    for (const card of candidates) if (!selected.includes(card)) drop(card.item, 'spacing or screen-time cap');
    const rendered = [];
    for (const card of await renderCards(selected, { outputDir })) {
      if (card.fits) rendered.push(card);
      else drop(card.item, 'too wide or too tall for the screen');
    }
    const byScene = new Map();
    for (const card of rendered) {
      if (!byScene.has(card.position)) byScene.set(card.position, []);
      byScene.get(card.position).push({ path: card.path, start: card.start, end: card.end, kind: card.kind });
    }
    // One credit per image file, and one per scripture translation however many passages it supplied.
    const creditKey = credit => (credit.kind === 'text' ? `text:${credit.work}:${credit.edition}` : credit.url);
    const credits = [];
    for (const card of rendered) {
      const credit = card.kind === 'verse' ? card.credit : card.image?.credit;
      if (credit && !credits.some(existing => creditKey(existing) === creditKey(credit))) credits.push(credit);
    }
    const items = rendered.map(card => ({
      kind: card.kind, position: card.position, start: Number(card.start.toFixed(2)), end: Number(card.end.toFixed(2)),
      at: Number(card.at.toFixed(2)), until: Number(card.until.toFixed(2)),
      subject: card.reference || card.name || card.caption || card.value || card.author || '', path: path.basename(card.path)
    }));
    const counts = KINDS.map(kind => [kind, items.filter(item => item.kind === kind).length]).filter(([, count]) => count).map(([kind, count]) => `${count} ${kind}`);
    if (dropped.length) this.logger.info(`Visual inserts dropped: ${dropped.join('; ')}`);
    this.logger.info(`Visual inserts (${this.model}): ${planned.length} proposed, ${candidates.length} verified, ${items.length} kept (${counts.join(', ') || 'none'}), ${Math.round(items.reduce((sum, item) => sum + item.end - item.start, 0))} s on screen out of ${Math.round(totalSeconds)} s`);
    return { byScene, items, credits };
  }
}

module.exports = { VisualInsertAgent, findAnchor, anchorSeconds, holdSeconds, cardWindow, selectCards, openingCardSeconds, MAX_SHARE, MIN_GAP_SECONDS };
