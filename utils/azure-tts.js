// Azure Speech narration (the free F0 tier includes 0.5 M characters of neural voices per month).
// The text goes in SSML with the chosen French voice and an optional prosody rate. WordBoundary events give
// word timings (<audio>.words.json) for exact captions and clean Short cuts, as with ElevenLabs.
const fs = require('fs').promises;
const path = require('path');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { chunkText, writeWordTimings } = require('./narration-timing');

const DEFAULT_VOICE = 'fr-FR-RemyMultilingualNeural';
// Keeps each request well under the service's 10-minute audio limit.
const CHUNK_LIMIT = 3000;
const TICKS_PER_SECOND = 1e7;
const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

function config(auth = {}) {
  const env = process.env;
  const voice = auth.voice || env.AZURE_SPEECH_VOICE || DEFAULT_VOICE;
  return {
    key: auth.key || env.AZURE_SPEECH_KEY,
    region: auth.region || env.AZURE_SPEECH_REGION,
    voice,
    language: voice.split('-').slice(0, 2).join('-'),
    rate: env.AZURE_SPEECH_RATE || '',
    pricePer1M: Number(env.AZURE_SPEECH_PRICE_PER_1M || 0)
  };
}

// SSML for one chunk, plus a map from each character of the escaped text back to the original text,
// so that WordBoundary offsets (reported against the SSML) land on the right word.
function buildSsml(text, cfg) {
  const open = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${cfg.language}"><voice name="${cfg.voice}">`
    + (cfg.rate ? `<prosody rate="${cfg.rate}">` : '');
  const close = (cfg.rate ? '</prosody>' : '') + '</voice></speak>';
  let escaped = '';
  const map = [];
  for (let index = 0; index < text.length; index++) {
    const replacement = XML_ESCAPES[text[index]] || text[index];
    for (let k = 0; k < replacement.length; k++) map.push(index);
    escaped += replacement;
  }
  return { ssml: open + escaped + close, prefix: open.length, map };
}

function speak(ssml, cfg) {
  return new Promise((resolve, reject) => {
    const speechConfig = sdk.SpeechConfig.fromSubscription(cfg.key, cfg.region);
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio48Khz192KBitRateMonoMp3;
    // No audio output device: the audio comes back in memory.
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
    const boundaries = [];
    synthesizer.wordBoundary = (_sender, event) => {
      if (event.boundaryType !== sdk.SpeechSynthesisBoundaryType.Word) return;
      boundaries.push({
        start: event.audioOffset / TICKS_PER_SECOND,
        end: (event.audioOffset + event.duration) / TICKS_PER_SECOND,
        textOffset: event.textOffset
      });
    };
    synthesizer.speakSsmlAsync(ssml, result => {
      synthesizer.close();
      if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
        return resolve({ audio: Buffer.from(result.audioData), boundaries });
      }
      const details = sdk.CancellationDetails.fromResult(result);
      reject(new Error(`Azure TTS failed: ${details.errorDetails || details.reason}`));
    }, error => {
      synthesizer.close();
      reject(new Error(`Azure TTS failed: ${error}`));
    });
  }).catch(error => {
    // A wrong key or region surfaces as a closed websocket (1006) rather than a 401.
    if (/1006|Unable to contact server/i.test(error.message)) {
      error.message = `${error.message.replace(/\s+/g, ' ').trim()} (check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION)`;
    }
    throw error;
  });
}

// Word timings for the original text's space-separated tokens, shifted by `offset` seconds. Tokens the
// service does not time on their own (a lone "?" or "—" in French typography) inherit the previous end.
function wordsFromBoundaries(text, boundaries, built, offset) {
  const tokens = [];
  const pattern = /\S+/g;
  let match;
  while ((match = pattern.exec(text))) tokens.push({ text: match[0], from: match.index, to: match.index + match[0].length, start: null, end: null });
  const ssmlRelative = boundaries.length > 0 && boundaries[0].textOffset >= built.prefix;
  let cursor = 0;
  for (const boundary of boundaries) {
    const position = ssmlRelative ? built.map[boundary.textOffset - built.prefix] : boundary.textOffset;
    if (position === undefined) continue;
    while (cursor < tokens.length && tokens[cursor].to <= position) cursor++;
    const token = tokens[cursor];
    if (!token || position < token.from) continue;
    token.start = token.start === null ? boundary.start : Math.min(token.start, boundary.start);
    token.end = token.end === null ? boundary.end : Math.max(token.end, boundary.end);
  }
  let previousEnd = 0;
  return tokens.map(token => {
    const start = token.start ?? previousEnd;
    const end = Math.max(start, token.end ?? start);
    previousEnd = end;
    return { text: token.text, start: offset + start, end: offset + end };
  });
}

async function speakWithRetry(ssml, cfg) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await speak(ssml, cfg);
    } catch (error) {
      const transient = /429|throttl|too many|timeout|timed out|unavailable/i.test(error.message);
      if (!transient || attempt >= 3) throw error;
      await new Promise(resolve => setTimeout(resolve, attempt * 4000));
    }
  }
}

// Synthesizes `text` into `outputPath` (MP3) and writes the word timings next to it.
// `key` / `region` / `voice` override the AZURE_SPEECH_* environment variables.
async function synthesize(text, outputPath, { key = null, region = null, voice = null } = {}) {
  const cfg = config({ key, region, voice });
  if (!cfg.key || !cfg.region) throw new Error('AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are required');
  const chunks = chunkText(text, CHUNK_LIMIT);
  if (!chunks.length) throw new Error('Nothing to narrate');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const base = outputPath.replace(/\.[a-z0-9]+$/i, '');
  const parts = [];
  const words = [];
  let offset = 0;
  try {
    for (const [index, chunk] of chunks.entries()) {
      const built = buildSsml(chunk, cfg);
      const { audio, boundaries } = await speakWithRetry(built.ssml, cfg);
      const partPath = chunks.length === 1 ? outputPath : `${base}.part${index}.mp3`;
      await fs.writeFile(partPath, audio);
      words.push(...wordsFromBoundaries(chunk, boundaries, built, offset));
      parts.push(partPath);
      if (chunks.length > 1) offset += Number(await getMediaDuration(partPath)) || 0;
    }
    if (parts.length > 1) {
      const listPath = `${base}.parts.txt`;
      await fs.writeFile(listPath, parts.map(part => `file '${part.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
      try {
        await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '160k', outputPath]);
      } finally {
        await fs.unlink(listPath).catch(() => {});
      }
    }
  } finally {
    if (parts.length > 1) await Promise.all(parts.map(part => fs.unlink(part).catch(() => {})));
  }
  await writeWordTimings(outputPath, { provider: 'azure', model: cfg.voice, text, words });
  const characters = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return {
    path: outputPath,
    model: cfg.voice,
    characters,
    cost: { amount: Number(((characters / 1e6) * cfg.pricePer1M).toFixed(4)), currency: 'USD' }
  };
}

async function listVoices({ key = null, region = null, locale = 'fr-FR' } = {}) {
  const cfg = config({ key, region });
  if (!cfg.key || !cfg.region) throw new Error('AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are required');
  const synthesizer = new sdk.SpeechSynthesizer(sdk.SpeechConfig.fromSubscription(cfg.key, cfg.region), null);
  try {
    const result = await synthesizer.getVoicesAsync(locale);
    if (result.reason !== sdk.ResultReason.VoicesListRetrieved) throw new Error(`Azure voice list failed: ${result.errorDetails}`);
    return result.voices;
  } finally {
    synthesizer.close();
  }
}

module.exports = { synthesize, listVoices, buildSsml, wordsFromBoundaries, DEFAULT_VOICE };
