// Word-level narration timing shared by the video captions and the Shorts cutter.
// A TTS provider that returns timestamps (ElevenLabs) writes <audio>.words.json next to the audio file;
// every other provider leaves no sidecar and timings are estimated from the text instead.
const fs = require('fs').promises;

function wordsPath(audioPath) {
  return String(audioPath).replace(/\.[a-z0-9]+$/i, '') + '.words.json';
}

async function readWordTimings(audioPath) {
  if (!audioPath) return null;
  try {
    const data = JSON.parse(await fs.readFile(wordsPath(audioPath), 'utf8'));
    const words = (data.words || []).filter(word => word && word.text && Number.isFinite(word.start) && Number.isFinite(word.end));
    return words.length ? words : null;
  } catch (_error) {
    return null;
  }
}

async function writeWordTimings(audioPath, payload) {
  await fs.writeFile(wordsPath(audioPath), JSON.stringify(payload), 'utf8');
}

async function clearWordTimings(audioPath) {
  if (audioPath) await fs.unlink(wordsPath(audioPath)).catch(() => {});
}

// Groups characters from an ElevenLabs alignment into words, shifted by `offset` seconds.
function wordsFromAlignment(alignment, offset = 0) {
  const chars = alignment?.characters || [];
  const starts = alignment?.character_start_times_seconds || [];
  const ends = alignment?.character_end_times_seconds || [];
  const words = [];
  let current = null;
  for (let i = 0; i < chars.length; i++) {
    if (/\s/.test(chars[i])) {
      if (current) words.push(current);
      current = null;
      continue;
    }
    if (!current) current = { text: '', start: offset + Number(starts[i] || 0), end: offset + Number(ends[i] || 0) };
    current.text += chars[i];
    current.end = offset + Number(ends[i] || current.end - offset);
  }
  if (current) words.push(current);
  return words;
}

function splitSentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
    .split(/(?<=[.!?…])\s+(?=[«"“A-ZÀ-ÖØ-Þ0-9])/u)
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

// Splits a long narration on sentence boundaries into chunks of at most `limit` characters (one TTS request each).
function chunkText(text, limit) {
  const chunks = [];
  let current = '';
  for (const sentence of splitSentences(text)) {
    if (current && current.length + sentence.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}

// Sentences with start/end seconds inside one narrated scene. Uses word timings when present,
// otherwise spreads the scene duration proportionally to sentence length.
function timedSentences(text, durationSeconds, words = null) {
  const sentences = splitSentences(text);
  if (!sentences.length) return [];
  const duration = Math.max(0.1, Number(durationSeconds) || 0.1);
  if (words && words.length) {
    const result = [];
    let cursor = 0;
    for (const sentence of sentences) {
      const count = sentence.split(' ').filter(Boolean).length;
      const slice = words.slice(cursor, cursor + count);
      cursor += count;
      if (!slice.length) break;
      result.push({ text: sentence, start: slice[0].start, end: slice[slice.length - 1].end, words: slice });
    }
    if (result.length === sentences.length) return result;
  }
  const weights = sentences.map(sentence => sentence.length + 8);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return sentences.map((sentence, index) => {
    const span = (weights[index] / total) * duration;
    const item = { text: sentence, start: cursor, end: Math.min(duration, cursor + span), words: null };
    cursor += span;
    return item;
  });
}

// Caption cues that break on punctuation first and on length second, never in the middle of a clause
// when it can be avoided. With word timings the cues follow the voice exactly.
function captionCues(text, durationSeconds, { words = null, maxWords = 8, maxChars = 44 } = {}) {
  const duration = Math.max(0.1, Number(durationSeconds) || 0.1);
  const tokens = words && words.length
    ? words.map(word => ({ text: word.text, start: word.start, end: word.end }))
    : String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).map(word => ({ text: word }));
  if (!tokens.length) return [];
  const groups = [];
  let group = [];
  const length = items => items.reduce((sum, item) => sum + item.text.length + 1, 0);
  for (const token of tokens) {
    if (group.length && (group.length >= maxWords || length(group) + token.text.length > maxChars)) {
      groups.push(group);
      group = [];
    }
    group.push(token);
    const strong = /[.!?…:;]["»”)]?$/.test(token.text);
    const soft = /[,–—]["»”)]?$/.test(token.text);
    if (strong || (soft && group.length >= Math.ceil(maxWords / 2))) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length) {
    // A one-word orphan reads badly on screen: fold it into the previous cue when there is room.
    const previous = groups[groups.length - 1];
    if (group.length === 1 && previous && length(previous) + group[0].text.length <= maxChars + 8) previous.push(group[0]);
    else groups.push(group);
  }
  if (tokens[0].start !== undefined) {
    return groups.map((items, index) => {
      const next = groups[index + 1];
      const end = next ? Math.min(next[0].start, items[items.length - 1].end + 0.6) : Math.min(duration, items[items.length - 1].end + 0.6);
      return { start: Math.max(0, items[0].start), end: Math.max(items[0].start + 0.3, end - 0.02), text: items.map(item => item.text).join(' ') };
    });
  }
  const weights = groups.map(items => length(items) + 6);
  const total = weights.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return groups.map((items, index) => {
    const span = (weights[index] / total) * duration;
    const cue = { start: cursor, end: Math.min(duration, cursor + span - 0.05), text: items.map(item => item.text).join(' ') };
    cursor += span;
    return cue;
  });
}

// Word timings estimated from the text when the provider returned none: the duration is spread by word length.
function estimatedWords(text, durationSeconds) {
  const tokens = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const duration = Math.max(0.1, Number(durationSeconds) || 0.1);
  const total = tokens.reduce((sum, token) => sum + token.length + 1, 0) || 1;
  let cursor = 0;
  return tokens.map(token => {
    const span = ((token.length + 1) / total) * duration;
    const word = { text: token, start: cursor, end: cursor + span * 0.92 };
    cursor += span;
    return word;
  });
}

async function sceneWords(scene) {
  return await readWordTimings(scene.audioPath) || estimatedWords(scene.scriptText, scene.duration);
}

// Scenes are narrated and concatenated in order: each one starts where the previous one ends.
function sceneTimeline(scenes) {
  let cursor = 0;
  return [...scenes].sort((a, b) => a.position - b.position).map(scene => {
    const duration = Math.max(0, Number(scene.duration) || 0);
    const item = { ...scene, startSeconds: cursor, duration };
    cursor += duration;
    return item;
  });
}

// The words heard in a cut of the narration. `segments` are ranges of the source timeline ({ start, end } in
// seconds) played back to back, each one starting at its `at` in the cut. A word belongs to the range that
// contains its middle; its times are moved onto the cut.
async function retimedWords(segments, scenes) {
  const timeline = sceneTimeline(scenes);
  const words = [];
  for (const segment of segments) {
    for (const scene of timeline) {
      if (scene.startSeconds >= segment.end || scene.startSeconds + scene.duration <= segment.start) continue;
      for (const word of await sceneWords(scene)) {
        const start = scene.startSeconds + word.start;
        const end = scene.startSeconds + word.end;
        const middle = (start + end) / 2;
        // Exclusive at the start: a punctuation mark closing the previous sentence sits exactly on it.
        if (middle <= segment.start || middle > segment.end) continue;
        const shift = segment.at - segment.start;
        words.push({
          text: word.text,
          start: Math.max(segment.at, start + shift),
          end: Math.min(segment.at + (segment.end - segment.start), end + shift)
        });
      }
    }
  }
  return words;
}

function srtTime(seconds) {
  const milliseconds = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor((milliseconds % 3600000) / 60000);
  const secs = Math.floor((milliseconds % 60000) / 1000);
  const millis = milliseconds % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function cuesToSrt(cues) {
  return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`).join('\n');
}

// Closed captions of a whole video, scene after scene on the measured timeline, following the voice word by word
// when the provider returned timings. Two short lines per cue at most, as YouTube recommends.
async function srtFromScenes(scenes) {
  const cues = [];
  for (const scene of sceneTimeline(scenes)) {
    const words = await readWordTimings(scene.audioPath);
    for (const cue of captionCues(scene.scriptText, scene.duration, { words, maxWords: 12, maxChars: 64 })) {
      cues.push({ start: scene.startSeconds + cue.start, end: scene.startSeconds + Math.min(cue.end, scene.duration), text: cue.text });
    }
  }
  return cuesToSrt(cues);
}

module.exports = {
  wordsPath, readWordTimings, writeWordTimings, clearWordTimings,
  wordsFromAlignment, splitSentences, chunkText, timedSentences, captionCues,
  estimatedWords, sceneWords, sceneTimeline, retimedWords, srtTime, cuesToSrt, srtFromScenes
};
