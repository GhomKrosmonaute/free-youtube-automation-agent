// Renders the visual inserts as transparent PNG cards with Chromium (Playwright): scripture, quotations, equations
// (native MathML), portraits and images with a caption, key figures. Each card is captured with its soft shadow
// inside a transparent margin, so FFmpeg only has to centre it over the scene.
const fs = require('fs').promises;
const path = require('path');
const { PALETTES, paletteFor } = require('./visualizer');

const MAX_CARD_HEIGHT = 700; // leaves the captions band at the bottom of a 1080p frame free
const escapeHtml = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const hex = value => `#${String(value).replace(/^0x/, '')}`;
const clean = text => String(text || '').replace(/\s+/g, ' ').trim();

// MathML Core elements and presentation attributes only: anything else (scripts, links, HTML, styles) rejects
// the whole formula rather than being rendered.
const MATHML_TAGS = new Set(['math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'mspace', 'mfrac', 'msqrt', 'mroot', 'msup', 'msub',
  'msubsup', 'munder', 'mover', 'munderover', 'mtable', 'mtr', 'mtd', 'mpadded', 'mphantom', 'mstyle']);
const MATHML_ATTRS = new Set(['mathvariant', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'linethickness', 'columnalign',
  'rowspacing', 'columnspacing', 'displaystyle', 'scriptlevel', 'accent', 'accentunder', 'largeop', 'movablelimits', 'width', 'form']);

function sanitizeMathML(markup) {
  const source = String(markup || '').trim();
  if (!/^<math[\s>]/i.test(source) || !/<\/math>$/i.test(source) || /<!|<\?/.test(source)) return null;
  let valid = true;
  const cleaned = source.replace(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g, (_all, closing, tag, attributes, selfClosing) => {
    const name = tag.toLowerCase();
    if (!MATHML_TAGS.has(name)) { valid = false; return ''; }
    if (closing) return `</${name}>`;
    const kept = name === 'math' ? ['display="block"'] : [];
    for (const [, key, value] of attributes.matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) {
      if (MATHML_ATTRS.has(key.toLowerCase())) kept.push(`${key.toLowerCase()}="${escapeHtml(value)}"`);
    }
    return `<${name}${kept.length ? ` ${kept.join(' ')}` : ''}${selfClosing ? '/' : ''}>`;
  });
  return valid && /<m(i|n|o|text)\b/.test(cleaned) ? cleaned : null;
}

function quotes() {
  return String(process.env.CONTENT_LANGUAGE || 'en').startsWith('fr') ? ['« ', ' »'] : ['“', '”'];
}

async function imageDataUri(file) {
  const extension = path.extname(file).toLowerCase();
  const mime = { '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' }[extension] || 'image/jpeg';
  return `data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`;
}

// On-screen credit for images that require attribution; public-domain works are credited in the description only.
function creditLine(credit) {
  if (!credit || /public domain|domaine public|^pd|cc0/i.test(credit.license || '')) return '';
  return `<div class="credit">${escapeHtml([credit.author, credit.license, 'Wikimedia Commons'].filter(Boolean).join(' · '))}</div>`;
}

async function cardBody(card) {
  const [open, close] = quotes();
  switch (card.kind) {
    case 'verse': {
      const numbered = card.verses.length > 1;
      const text = card.verses.map(verse => `${numbered ? `<sup>${verse.number}</sup>` : ''}${escapeHtml(clean(verse.text))}`).join(' ');
      return `<div class="kicker">${escapeHtml(card.reference)}<small>${escapeHtml(card.translation)}</small></div><div class="verse">${open}${text}${close}</div>`;
    }
    case 'quote': {
      // An excerpt that starts mid-sentence is marked as such.
      const text = clean(card.text);
      return `<div class="quote">${open}${/^\p{Ll}/u.test(text) ? '…\u00a0' : ''}${escapeHtml(text)}${close}</div>` +
        `<div class="author">— ${escapeHtml(card.author)}${card.source ? `, <i>${escapeHtml(card.source)}</i>` : ''}</div>`;
    }
    case 'equation':
      return `${card.caption ? `<div class="kicker center">${escapeHtml(card.caption)}</div>` : ''}<div class="math">${card.mathml}</div>`;
    case 'person':
      return `<img class="photo portrait" src="${await imageDataUri(card.image.path)}"><div class="name">${escapeHtml(card.name)}</div>` +
        `${card.caption ? `<div class="caption">${escapeHtml(card.caption)}</div>` : ''}${creditLine(card.image.credit)}`;
    case 'image':
      return `<img class="photo" src="${await imageDataUri(card.image.path)}">` +
        `${card.caption ? `<div class="caption">${escapeHtml(card.caption)}</div>` : ''}${creditLine(card.image.credit)}`;
    case 'figure':
      return `<div class="figure">${escapeHtml(card.value)}</div>${card.caption ? `<div class="caption wide">${escapeHtml(card.caption)}</div>` : ''}`;
    default:
      throw new Error(`Unknown insert kind "${card.kind}"`);
  }
}

// Sizes use --s so a card that is too tall can be scaled down before it is captured.
function pageHtml(body, kind, colors) {
  const centered = ['equation', 'person', 'image', 'figure'].includes(kind);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html, body { margin: 0; background: transparent; }
    body { font-family: Georgia, 'DejaVu Serif', serif; color: ${colors.title}; --s: 1; }
    #frame { display: inline-block; padding: 48px; }
    .card { position: relative; box-sizing: border-box; max-width: 1240px; min-width: 460px; padding: calc(var(--s) * 40px) 56px calc(var(--s) * 44px);
      background: rgba(9, 9, 12, 0.86); border: 1px solid rgba(255, 255, 255, 0.09); border-radius: 10px;
      box-shadow: 0 22px 60px rgba(0, 0, 0, 0.7); text-align: ${centered ? 'center' : 'left'}; }
    .card::before { content: ''; position: absolute; top: 0; left: ${centered ? 'calc(50% - 60px)' : '56px'}; width: 120px; height: 6px; background: ${colors.accent}; }
    .kicker { font-size: calc(var(--s) * 26px); letter-spacing: 0.14em; text-transform: uppercase; font-weight: bold; color: ${colors.accent}; margin-bottom: calc(var(--s) * 18px); }
    .kicker small { margin-left: 16px; font-size: calc(var(--s) * 21px); letter-spacing: 0.04em; text-transform: none; font-weight: normal; color: ${colors.label}; }
    .verse, .quote { font-size: calc(var(--s) * 44px); line-height: 1.38; }
    .verse { font-style: italic; }
    .verse sup { font-size: 0.5em; font-style: normal; font-weight: bold; color: ${colors.accent}; margin: 0 0.25em 0 0.15em; }
    .author { margin-top: calc(var(--s) * 22px); font-size: calc(var(--s) * 28px); color: ${colors.label}; }
    .math math { font-family: 'STIX Two Math', 'Cambria Math', 'Latin Modern Math', math; font-size: calc(var(--s) * 72px); color: ${colors.title}; }
    .photo { display: block; margin: 0 auto; max-width: 1100px; max-height: calc(var(--s) * 540px); border-radius: 4px; }
    .portrait { max-width: 640px; max-height: calc(var(--s) * 500px); }
    .name { margin-top: calc(var(--s) * 22px); font-size: calc(var(--s) * 46px); font-weight: bold; }
    .caption { margin-top: calc(var(--s) * 10px); font-size: calc(var(--s) * 28px); color: ${colors.label}; }
    .caption.wide { font-size: calc(var(--s) * 34px); max-width: 900px; }
    /* Georgia only has old-style figures ("1440" reads "144o" at this size): lining serif faces for numbers. */
    .figure { font-family: Didot, 'Bodoni 72', 'Times New Roman', 'DejaVu Serif', serif; font-size: calc(var(--s) * 150px); line-height: 1; font-weight: bold; color: ${colors.accent}; }
    .credit { margin-top: 12px; font-size: 17px; color: ${colors.label}; opacity: 0.75; }
  </style></head><body><div id="frame"><div class="card">${body}</div></div></body></html>`;
}

function colorsFor(register, palette = process.env.VISUAL_PALETTE) {
  const colors = PALETTES[paletteFor(register, palette)] || PALETTES.blood;
  return { accent: hex(colors.accent), title: hex(colors.title), label: hex(colors.label) };
}

// cards: [{ kind, register, ...content }] → the same cards with { path, width, height } of their PNG, or
// { fits: false } for a card that stays too tall, or whose formula or figure stays too wide (they cannot wrap),
// even scaled down: it is not captured rather than shown cut off.
async function renderCards(cards, { outputDir }) {
  if (!cards.length) return [];
  await fs.mkdir(outputDir, { recursive: true });
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const rendered = [];
    for (const [index, card] of cards.entries()) {
      await page.setContent(pageHtml(await cardBody(card), card.kind, colorsFor(card.register)), { waitUntil: 'load' });
      const fits = await page.evaluate(async maxHeight => {
        await document.fonts.ready;
        const card = document.querySelector('.card');
        const overflows = () => card.getBoundingClientRect().height > maxHeight ||
          [...card.querySelectorAll('.math, .figure')].some(element => element.scrollWidth > element.clientWidth + 1);
        for (let scale = 1; overflows() && scale > 0.5; scale -= 0.05) {
          document.body.style.setProperty('--s', String(scale - 0.05));
        }
        return !overflows();
      }, MAX_CARD_HEIGHT);
      if (!fits) {
        rendered.push({ ...card, fits: false });
        continue;
      }
      const frame = await page.$('#frame');
      const box = await frame.boundingBox();
      const outputPath = path.join(outputDir, `insert_${String(index).padStart(2, '0')}_${card.kind}.png`);
      await frame.screenshot({ path: outputPath, omitBackground: true });
      rendered.push({ ...card, fits: true, path: outputPath, width: Math.round(box.width), height: Math.round(box.height) });
    }
    return rendered;
  } finally {
    await browser.close();
  }
}

module.exports = { renderCards, sanitizeMathML, pageHtml, cardBody, MAX_CARD_HEIGHT };
