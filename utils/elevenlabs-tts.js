// ElevenLabs narration through /v1/text-to-speech/{voice}/with-timestamps.
// Long texts are split on sentence boundaries under the model's per-request limit, and the neighbouring
// text goes in previous_text / next_text so the prosody flows across chunks and across scenes.
// The character alignment is turned into word timings (<audio>.words.json) for exact captions and Short cuts.
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { chunkText, wordsFromAlignment, writeWordTimings } = require('./narration-timing');

const DEFAULT_MODEL = 'eleven_v4';
const CHUNK_LIMITS = { eleven_v3: 4500, eleven_v4: 9000, eleven_multilingual_v2: 9000, eleven_flash_v2_5: 9000 };
// Optional fields a model rejected once; they are not sent again to that model in this process.
const unsupported = new Set();

function config(auth = {}) {
  const env = process.env;
  return {
    apiKey: auth.apiKey || env.ELEVENLABS_API_KEY,
    voiceId: auth.voiceId || env.ELEVENLABS_VOICE_ID,
    model: env.ELEVENLABS_MODEL || env.ELEVENLABS_TTS_MODEL || DEFAULT_MODEL,
    baseUrl: (env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io').replace(/\/+$/, ''),
    languageCode: env.ELEVENLABS_LANGUAGE_CODE || env.CONTENT_LANGUAGE || null,
    pricePer1k: Number(env.ELEVENLABS_PRICE_PER_1K_CHARS || 0.08),
    voiceSettings: {
      stability: Number(env.ELEVENLABS_STABILITY ?? 0.5),
      similarity_boost: Number(env.ELEVENLABS_SIMILARITY ?? 0.75),
      style: Number(env.ELEVENLABS_STYLE ?? 0),
      speed: Number(env.ELEVENLABS_SPEED ?? 1),
      use_speaker_boost: String(env.ELEVENLABS_SPEAKER_BOOST ?? 'true') !== 'false'
    }
  };
}



function errorDetail(error) {
  const data = error.response?.data;
  const detail = data?.detail;
  const message = typeof detail === 'string' ? detail : detail?.message || data?.message || error.message;
  return `${error.response?.status ? `HTTP ${error.response.status}: ` : ''}${message}`;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestChunk(cfg, body) {
  const url = `${cfg.baseUrl}/v1/text-to-speech/${encodeURIComponent(cfg.voiceId)}/with-timestamps?output_format=mp3_44100_128`;
  const payload = { ...body };
  for (const field of ['previous_text', 'next_text', 'language_code']) {
    if (unsupported.has(`${cfg.model}:${field}`) || payload[field] === null || payload[field] === '') delete payload[field];
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await axios.post(url, payload, {
        headers: { 'xi-api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: Number(process.env.ELEVENLABS_TIMEOUT_MS || 180000),
        maxBodyLength: Infinity, maxContentLength: Infinity
      });
      if (!response.data?.audio_base64) throw new Error('ElevenLabs returned no audio');
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const detail = errorDetail(error);
      // A model that does not accept an optional field: drop it and retry immediately.
      const rejected = [400, 422].includes(status) && ['previous_text', 'next_text', 'language_code'].find(field => field in payload && detail.includes(field));
      if (rejected) {
        unsupported.add(`${cfg.model}:${rejected}`);
        delete payload[rejected];
        continue;
      }
      const retryable = !status || status === 429 || status >= 500;
      if (retryable && attempt < 3) {
        await wait(attempt * 3000);
        continue;
      }
      throw new Error(`ElevenLabs TTS failed: ${detail}`);
    }
  }
}

// Synthesizes `text` into `outputPath` (MP3) and writes the word timings next to it.
// `previousText` / `nextText` are the neighbouring scenes' narration, used only for prosody.
// `apiKey` / `voiceId` override the ELEVENLABS_* environment variables.
async function synthesize(text, outputPath, { previousText = '', nextText = '', apiKey = null, voiceId = null } = {}) {
  const cfg = config({ apiKey, voiceId });
  if (!cfg.apiKey || !cfg.voiceId) throw new Error('ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required');
  const chunks = chunkText(text, CHUNK_LIMITS[cfg.model] || 9000);
  if (!chunks.length) throw new Error('Nothing to narrate');
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const base = outputPath.replace(/\.[a-z0-9]+$/i, '');
  const parts = [];
  const words = [];
  let offset = 0;
  try {
    for (const [index, chunk] of chunks.entries()) {
      const data = await requestChunk(cfg, {
        text: chunk,
        model_id: cfg.model,
        language_code: cfg.model.startsWith('eleven_multilingual_v2') ? null : cfg.languageCode,
        voice_settings: cfg.voiceSettings,
        previous_text: (index > 0 ? chunks[index - 1] : previousText).slice(-1500) || null,
        next_text: (index < chunks.length - 1 ? chunks[index + 1] : nextText).slice(0, 1500) || null
      });
      const partPath = chunks.length === 1 ? outputPath : `${base}.part${index}.mp3`;
      await fs.writeFile(partPath, Buffer.from(data.audio_base64, 'base64'));
      words.push(...wordsFromAlignment(data.alignment, offset));
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
  await writeWordTimings(outputPath, { provider: 'elevenlabs', model: cfg.model, voiceId: cfg.voiceId, text, words });
  const characters = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return {
    path: outputPath,
    model: cfg.model,
    characters,
    cost: { amount: Number(((characters / 1000) * cfg.pricePer1k).toFixed(4)), currency: 'USD' }
  };
}

async function listVoices() {
  const cfg = config();
  if (!cfg.apiKey) throw new Error('ELEVENLABS_API_KEY is required');
  const response = await axios.get(`${cfg.baseUrl}/v1/voices`, { headers: { 'xi-api-key': cfg.apiKey }, timeout: 30000 });
  return response.data?.voices || [];
}

module.exports = { synthesize, listVoices, DEFAULT_MODEL };
