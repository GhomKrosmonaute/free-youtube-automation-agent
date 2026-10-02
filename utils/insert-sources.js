// Verified material for the visual inserts: scripture fetched from public APIs (never model-written text) and
// freely licensed images from Wikipedia / Wikimedia Commons, with their credits. Every lookup returns null when
// the material cannot be found or is not free, so an insert is dropped rather than invented.
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { version } = require('../package.json');

// Wikimedia asks every client for a descriptive User-Agent; set WIKIMEDIA_USER_AGENT to add a contact.
const USER_AGENT = process.env.WIKIMEDIA_USER_AGENT || `youtube-automation-agent/${version} (visual inserts)`;
const MAX_VERSES = 4;
const MAX_PASSAGE_CHARS = 340;

// Translations per content language: public-domain Bibles (getbible.net) and alquran.cloud editions.
const EDITIONS = {
  fr: { bible: 'ls1910', quran: 'fr.hamidullah', quranName: 'Coran' },
  en: { bible: 'kjv', quran: 'en.sahih', quranName: 'Quran' }
};
const language = () => String(process.env.CONTENT_LANGUAGE || 'en').slice(0, 2).toLowerCase();
const editions = () => {
  const base = EDITIONS[language()] || EDITIONS.en;
  return { ...base, bible: process.env.BIBLE_TRANSLATION || base.bible, quran: process.env.QURAN_EDITION || base.quran };
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WIKIMEDIA = /(^|\.)(wikipedia|wikidata|wikimedia)\.org$/;
const WIKIMEDIA_SPACING_MS = 800;
let nextWikimediaSlot = 0;

// Wikimedia answers 429 to bursts: requests to its hosts are spaced out, and a 429 is retried after the
// delay it asks for. Other hosts are called directly.
async function request(url, options) {
  const paced = WIKIMEDIA.test(new URL(url).hostname);
  for (let attempt = 1; ; attempt++) {
    if (paced) {
      const wait = nextWikimediaSlot - Date.now();
      nextWikimediaSlot = Math.max(Date.now(), nextWikimediaSlot) + WIKIMEDIA_SPACING_MS;
      if (wait > 0) await sleep(wait);
    }
    try {
      return await axios.get(url, { timeout: 20000, ...options, headers: { 'User-Agent': USER_AGENT, ...options.headers } });
    } catch (error) {
      if (error.response?.status !== 429 || attempt >= 4) throw error;
      const retryAfter = Number(error.response.headers?.['retry-after']);
      await sleep(Math.min(30, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 3 * attempt) * 1000);
    }
  }
}

async function getJson(url, params = {}) {
  return (await request(url, { params, headers: { Accept: 'application/json' } })).data;
}

// Protestant canon in getbible.net order, with the usual French and English spellings.
const BIBLE_BOOKS = [
  'Genèse|Genesis', 'Exode|Exodus', 'Lévitique|Leviticus', 'Nombres|Numbers', 'Deutéronome|Deuteronomy',
  'Josué|Joshua', 'Juges|Judges', 'Ruth', '1 Samuel', '2 Samuel', '1 Rois|1 Kings', '2 Rois|2 Kings',
  '1 Chroniques|1 Chronicles', '2 Chroniques|2 Chronicles', 'Esdras|Ezra', 'Néhémie|Nehemiah', 'Esther',
  'Job', 'Psaumes|Psaume|Psalms|Psalm', 'Proverbes|Proverbs', 'Ecclésiaste|Qohélet|Ecclesiastes',
  'Cantique des cantiques|Cantique|Song of Songs|Song of Solomon', 'Ésaïe|Isaïe|Isaiah', 'Jérémie|Jeremiah',
  'Lamentations', 'Ézéchiel|Ezekiel', 'Daniel', 'Osée|Hosea', 'Joël|Joel', 'Amos', 'Abdias|Obadiah',
  'Jonas|Jonah', 'Michée|Micah', 'Nahum', 'Habacuc|Habakkuk', 'Sophonie|Zephaniah', 'Aggée|Haggai',
  'Zacharie|Zechariah', 'Malachie|Malachi', 'Matthieu|Matthew', 'Marc|Mark', 'Luc|Luke', 'Jean|John',
  'Actes|Actes des Apôtres|Acts', 'Romains|Romans', '1 Corinthiens|1 Corinthians', '2 Corinthiens|2 Corinthians',
  'Galates|Galatians', 'Éphésiens|Ephesians', 'Philippiens|Philippians', 'Colossiens|Colossians',
  '1 Thessaloniciens|1 Thessalonians', '2 Thessaloniciens|2 Thessalonians', '1 Timothée|1 Timothy', '2 Timothée|2 Timothy',
  'Tite|Titus', 'Philémon|Philemon', 'Hébreux|Hebrews', 'Jacques|James', '1 Pierre|1 Peter', '2 Pierre|2 Peter',
  '1 Jean|1 John', '2 Jean|2 John', '3 Jean|3 John', 'Jude', 'Apocalypse|Revelation'
];

// "1Corinthiens", "I Corinthiens" and "1 corinthiens" share a key, as do "Ésaïe" and "esaie". Abbreviations are
// not recognised: the planner is asked for full book names.
function bookKey(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/^(iii|ii|i)\s+/, numeral => `${numeral.trim().length} `)
    .replace(/^(\d)\s*/, '$1 ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
const BOOK_NUMBERS = new Map(BIBLE_BOOKS.flatMap((names, index) => names.split('|').map(name => [bookKey(name), index + 1])));
const QURAN = /^(coran|quran|koran|qur an|sourate|surah|sura)\b/;

// "14", "12-14", "12–14, 16" → [12, 13, 14, 16], at most MAX_VERSES.
function verseNumbers(spec) {
  const numbers = new Set();
  for (const part of String(spec ?? '').split(/[,;]/)) {
    const [from, to] = part.split(/[-–—]/).map(value => parseInt(value, 10));
    if (!Number.isInteger(from) || from < 1) continue;
    const last = Number.isInteger(to) && to >= from ? to : from;
    for (let n = from; n <= last && numbers.size < MAX_VERSES; n++) numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

function verseRange(numbers) {
  const consecutive = numbers.every((n, i) => i === 0 || n === numbers[i - 1] + 1);
  return consecutive && numbers.length > 1 ? `${numbers[0]}-${numbers[numbers.length - 1]}` : numbers.join(', ');
}

// A card must be readable while it is on screen: verses after the first are kept only while the passage stays
// under MAX_PASSAGE_CHARS, and the reference names exactly the verses shown.
function passage(book, chapter, verses, translation, credit) {
  const kept = [];
  let length = 0;
  for (const verse of verses) {
    const text = String(verse.text || '').replace(/\s+/g, ' ').trim();
    if (kept.length && length + text.length > MAX_PASSAGE_CHARS) break;
    kept.push({ number: verse.number, text });
    length += text.length + 1;
  }
  return { reference: `${book} ${chapter}:${verseRange(kept.map(verse => verse.number))}`, verses: kept, translation, credit };
}

async function bibleVerses(book, chapter, verses) {
  const number = BOOK_NUMBERS.get(bookKey(book));
  const wanted = verseNumbers(verses);
  const chapterNumber = parseInt(chapter, 10);
  if (!number || !Number.isInteger(chapterNumber) || !wanted.length) return null;
  const translation = editions().bible;
  const data = await getJson(`https://api.getbible.net/v2/${translation}/${number}/${chapterNumber}.json`);
  const found = (data?.verses || []).filter(verse => wanted.includes(verse.verse) && String(verse.text || '').trim());
  if (found.length !== wanted.length) return null;
  return passage(data.book_name, chapterNumber, found.map(verse => ({ number: verse.verse, text: verse.text })), data.translation || translation,
    { kind: 'text', work: 'Bible', edition: data.translation || translation, url: `https://getbible.net/${translation}/${number}/${chapterNumber}` });
}

async function quranVerses(surah, verses) {
  const surahNumber = parseInt(surah, 10);
  const wanted = verseNumbers(verses);
  if (!Number.isInteger(surahNumber) || surahNumber < 1 || surahNumber > 114 || !wanted.length) return null;
  const { quran, quranName } = editions();
  const found = [];
  let edition = quran;
  for (const verse of wanted) {
    const data = await getJson(`https://api.alquran.cloud/v1/ayah/${surahNumber}:${verse}/${quran}`);
    if (data?.code !== 200 || !String(data.data?.text || '').trim()) return null;
    found.push({ number: verse, text: data.data.text });
    edition = data.data.edition?.englishName || edition;
  }
  return passage(quranName, surahNumber, found, edition, { kind: 'text', work: quranName, edition, url: `https://alquran.cloud/surah/${surahNumber}/${quran}` });
}

// book: a Bible book, or "Coran" / "Quran" with the surah as chapter.
async function scriptureVerses({ book, chapter, verses }) {
  return QURAN.test(bookKey(book)) ? quranVerses(chapter, verses) : bibleVerses(book, chapter, verses);
}

function plainText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

async function wikidataImage(entity) {
  const data = await getJson('https://www.wikidata.org/w/api.php', { action: 'wbgetclaims', format: 'json', entity, property: 'P18' });
  return data?.claims?.P18?.[0]?.mainsnak?.datavalue?.value || null;
}

// A file hosted on Wikimedia Commons (hence freely licensed), downloaded at most 1400 px wide.
async function commonsImage(file, outputDir, minWidth = 300) {
  const data = await getJson('https://commons.wikimedia.org/w/api.php', {
    action: 'query', format: 'json', formatversion: 2, titles: `File:${String(file).replace(/^(File|Fichier):/i, '')}`,
    prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: 1400,
    iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl'
  });
  const page = data?.query?.pages?.[0];
  const info = page?.imageinfo?.[0];
  if (!info || page.missing) return null;
  if (!/^image\/(jpeg|png|webp|gif|tiff|svg\+xml)$/.test(info.mime)) return null;
  if (Math.min(info.width || 0, info.thumbwidth || info.width || 0) < minWidth) return null;
  const license = plainText(info.extmetadata?.LicenseShortName?.value);
  if (!license || /fair use|non-free/i.test(license)) return null;
  const url = info.thumburl || info.url;
  const extension = (path.extname(new URL(url).pathname) || '.jpg').toLowerCase();
  // Named after the Commons file, so a portrait already downloaded for an earlier video is reused.
  const target = path.join(outputDir, `${crypto.createHash('sha1').update(page.title).digest('hex').slice(0, 16)}${extension}`);
  await fs.mkdir(outputDir, { recursive: true });
  const cached = await fs.stat(target).then(stats => stats.size > 0, () => false);
  if (!cached) {
    const response = await request(url, { responseType: 'arraybuffer', timeout: 30000 });
    await fs.writeFile(target, Buffer.from(response.data));
  }
  return {
    path: target,
    width: info.thumbwidth || info.width,
    height: info.thumbheight || info.height,
    credit: {
      kind: 'image', file: page.title, author: plainText(info.extmetadata?.Artist?.value).slice(0, 140) || null,
      license, licenseUrl: info.extmetadata?.LicenseUrl?.value || null, url: info.descriptionurl, shortUrl: info.descriptionshorturl || null
    }
  };
}

const nameWords = text => bookKey(text).split(' ').filter(word => word.length >= 3);

// A search hit is only trusted when it names what was asked for: every significant word of the shorter of the
// two titles appears in the other ("Lorenzo Valla" / "Laurent Valla" share "valla"; "Keith L. Moore" does not
// match "Paroi abdominale", an article that merely cites him).
function sameSubject(asked, found) {
  const a = nameWords(asked);
  const b = nameWords(found);
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const last = short[short.length - 1];
  return long.includes(last) && short.filter(word => long.includes(word)).length >= Math.ceil(short.length / 2);
}

async function articleImage(title, outputDir, lang) {
  const api = `https://${lang}.wikipedia.org/w/api.php`;
  const props = { action: 'query', format: 'json', formatversion: 2, redirects: 1, prop: 'pageimages|pageprops|description', piprop: 'name', ppprop: 'wikibase_item' };
  let page = (await getJson(api, { ...props, titles: title }))?.query?.pages?.[0];
  if (!page || page.missing || page.invalid) {
    page = (await getJson(api, { ...props, generator: 'search', gsrsearch: title, gsrlimit: 1 }))?.query?.pages?.[0];
    if (page && !sameSubject(title, page.title)) return null;
  }
  if (!page || page.missing) return null;
  const file = page.pageimage || (page.pageprops?.wikibase_item ? await wikidataImage(page.pageprops.wikibase_item) : null);
  if (!file) return null;
  const image = await commonsImage(file, outputDir);
  if (!image) return null;
  return { ...image, article: page.title, description: page.description || '', credit: { ...image.credit, article: page.title, articleUrl: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}` } };
}

// The main image of a Wikipedia article (its page image, else its Wikidata image) in the channel's language,
// then in English. pageimages only returns free images by default; Commons hosting is checked anyway.
async function wikipediaImage(title, outputDir, { lang = language() } = {}) {
  for (const wiki of [...new Set([lang, 'en'])]) {
    const image = await articleImage(title, outputDir, wiki);
    if (image) return image;
  }
  return null;
}

module.exports = { scriptureVerses, bibleVerses, quranVerses, wikipediaImage, commonsImage, verseNumbers, bookKey, sameSubject, BOOK_NUMBERS, plainText };
