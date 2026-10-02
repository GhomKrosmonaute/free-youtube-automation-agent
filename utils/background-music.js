// Ambient music under the narration, from a local library the operator fills with tracks downloaded from the
// YouTube Studio audio library (never claimed by Content ID). Every folder of data/music/ is an ambiance named after
// it (data/music/calme/ → "calme"); the model picks one per scene (chooseAmbiances). In a two-part video (react
// profile), each part has a default folder (look.music: data/music/opening/ and data/music/main/ unless the profile
// names others) and the music always changes where the main part starts.
// Each run of scenes with the same ambiance gets one track, looped, levelled to BACKGROUND_MUSIC_LUFS when the voice is
// silent, lowered about 12 dB while it speaks (back to the old fixed level), and crossfaded at every change. A text file next to a track (same name, .txt) holds the
// attribution some tracks require.
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { runFFmpeg } = require('./ffmpeg');
const { extractJson } = require('./ai-json');
const { registerOf } = require('./content-mode');
const { look, reactProfile, twoPartVideos } = require('./react-profile');

const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i;
// The default ambiance (folder) of each part of a two-part video.
const defaults = () => look().music;
const CROSSFADE_SECONDS = 4;
const FADE_IN_SECONDS = 3;
const FADE_OUT_SECONDS = 5;
const MIN_AMBIANCE_SECONDS = 60; // an ambiance shorter than this joins its neighbour in the same phase (no zapping)
const ASSUMED_TRACK_LUFS = -14; // mastered music, when a track cannot be measured
const STEREO = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';

const musicDir = () => process.env.BACKGROUND_MUSIC_DIR || path.join(__dirname, '..', 'data', 'music');
const enabled = () => !['off', 'false', '0', 'no'].includes(String(process.env.BACKGROUND_MUSIC || '').toLowerCase());
const targetLufs = () => Number(process.env.BACKGROUND_MUSIC_LUFS || -26); // level in the narration's pauses
const phaseOf = segment => registerOf(segment.register);
const clock = seconds => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;

async function audioFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter(entry => entry.isFile() && AUDIO.test(entry.name)).map(entry => path.join(directory, entry.name)).sort();
}

// Ambiances: the folders of data/music/ holding at least one track.
async function ambiances() {
  const entries = await fs.readdir(musicDir(), { withFileTypes: true }).catch(() => []);
  const names = [];
  for (const entry of entries) {
    if (entry.isDirectory() && (await audioFiles(path.join(musicDir(), entry.name))).length) names.push(entry.name);
  }
  return names.sort();
}

// Tracks for an ambiance in a phase: its folder, else the phase's default folder, else tracks straight in
// data/music/, else the other phase's default folder, else any ambiance.
async function tracksFor(ambiance, phase = 'main') {
  const root = musicDir();
  const other = phase === 'opening' ? defaults().main : defaults().opening;
  const folders = [ambiance, defaults()[phase], '', other, ...(await ambiances())];
  for (const folder of folders) {
    const files = await audioFiles(path.join(root, folder));
    if (files.length) return files;
  }
  return [];
}

// Folder names come back from macOS in decomposed Unicode ("é" as "e" + accent) while a model writes composed text:
// names are compared in NFC and mapped back to the folder's own spelling.
function folderNamed(names, value) {
  const wanted = String(value || '').normalize('NFC').trim();
  return names.find(name => name.normalize('NFC') === wanted) || null;
}

// The same production always gets the same music, so a re-render does not change it.
function pickTrack(tracks, key) {
  return tracks[crypto.createHash('sha1').update(String(key)).digest().readUInt32BE(0) % tracks.length];
}

// Runs of consecutive scenes with the same ambiance in the same phase, with their start and end in seconds.
// available: the ambiances that have tracks. A scene without a usable choice takes its phase default when that folder
// exists, else the ambiance of its nearest neighbour in the same phase. A run shorter than minSeconds joins a
// neighbouring run of the same phase (no zapping). The main part never opens on the opening's ambiance: it switches to
// the main part's default, else to its next ambiance, else to any other ambiance.
function musicRuns(segments, { minSeconds = MIN_AMBIANCE_SECONDS, available = [] } = {}) {
  const phases = segments.map(phaseOf);
  const chosen = segments.map(segment => folderNamed(available, segment.ambiance));
  const effective = segments.map((segment, index) => {
    if (chosen[index]) return chosen[index];
    const fallback = folderNamed(available, defaults()[phases[index]]);
    if (fallback) return fallback;
    for (let distance = 1; distance < segments.length; distance++) {
      for (const other of [index - distance, index + distance]) {
        if (phases[other] === phases[index] && chosen[other]) return chosen[other];
      }
    }
    return defaults()[phases[index]];
  });
  const group = () => {
    const runs = [];
    let cursor = 0;
    for (const [index, segment] of segments.entries()) {
      const duration = Number(segment.duration) || 0;
      const last = runs[runs.length - 1];
      if (last && last.phase === phases[index] && last.ambiance === effective[index]) last.end += duration;
      else runs.push({ phase: phases[index], ambiance: effective[index], start: cursor, end: cursor + duration, indexes: [] });
      runs[runs.length - 1].indexes.push(index);
      cursor += duration;
    }
    return runs.filter(run => run.end > run.start);
  };
  let runs = group();
  for (;;) {
    const short = runs.map((run, index) => ({ run, index }))
      .filter(({ run, index }) => run.end - run.start < minSeconds && [runs[index - 1], runs[index + 1]].some(other => other?.phase === run.phase))
      .sort((a, b) => (a.run.end - a.run.start) - (b.run.end - b.run.start))[0];
    if (!short) break;
    const target = runs[short.index - 1]?.phase === short.run.phase ? runs[short.index - 1] : runs[short.index + 1];
    short.run.indexes.forEach(index => { effective[index] = target.ambiance; });
    runs = group();
  }
  const turn = runs.findIndex((run, index) => index > 0 && run.phase === 'main' && runs[index - 1].phase === 'opening');
  if (turn > 0 && runs[turn].ambiance === runs[turn - 1].ambiance) {
    const opening = runs[turn - 1].ambiance;
    const later = runs.slice(turn + 1).find(run => run.phase === 'main' && run.ambiance !== opening)?.ambiance;
    const replacement = [folderNamed(available, defaults().main), later, ...available].find(name => name && name !== opening);
    if (replacement) {
      runs[turn].indexes.forEach(index => { effective[index] = replacement; });
      runs = group();
    }
  }
  return runs.map(({ phase, ambiance, start, end }) => ({ phase, ambiance, start, end }));
}

// Asks the model for an ambiance per scene among the library's folders. Returns Map(position → ambiance); scenes left
// out or given an unknown name keep their phase default.
async function chooseAmbiances({ aiText, script = {}, segments, names }) {
  const twoPart = twoPartVideos();
  let offset = 0;
  const list = segments.map((segment, index) => {
    const line = `Scene ${index + 1} (${twoPart ? `${phaseOf(segment) === 'opening' ? 'opening' : 'main part'}, ` : ''}${clock(offset)}, ${Math.round(segment.duration)} s) — ${segment.label || ''}\n${String(segment.text || '').slice(0, 600)}`;
    offset += Number(segment.duration) || 0;
    return line;
  }).join('\n\n');
  const folders = defaults();
  const known = Object.values(folders).filter(name => folderNamed(names, name));
  const prompt = `You choose the background music of a documentary YouTube video titled "${script.title || ''}". ${twoPart
    ? reactProfile().look?.musicNote || 'The video has two parts, an opening then the main part after the turn: ambiances that fit each part, and a clear change of ambiance where the main part starts.'
    : 'The music serves what each scene says, without drawing attention to itself.'}

The music library has these ambiances (folder names chosen by the editor): ${names.map(name => `"${name.normalize('NFC')}"`).join(', ')}.${twoPart && known.length ? ` ${known.map(name => `"${name}"`).join(' and ')} ${known.length > 1 ? 'are' : 'is'} the usual music of the ${known.map(name => (name === folders.opening ? 'opening' : 'main part')).join(' and of the ')}.` : ''}

Give every scene the ambiance that fits what it says and how it should feel. Keep the music steady: consecutive scenes usually share an ambiance, and an ambiance should last at least a minute.${twoPart ? ' The first scene of the main part must not use the ambiance of the last opening scene.' : ''}

Return only a JSON array with one object per scene: [{"scene": 1, "ambiance": "..."}].

Scenes:

${list}`;
  const answer = extractJson(await aiText.generateText(prompt, { model: aiText.lightModel(), maxTokens: 2000, temperature: 0.3, purpose: 'music' }), { prefer: 'array' });
  const choices = new Map();
  for (const item of Array.isArray(answer) ? answer : []) {
    const segment = segments[Number(item?.scene) - 1];
    const name = folderNamed(names, item?.ambiance);
    if (segment && name) choices.set(segment.position, name);
  }
  return choices;
}

async function integratedLufs(file) {
  try {
    const { stderr } = await runFFmpeg(['-nostats', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-']);
    const values = [...String(stderr).matchAll(/\bI:\s+(-?\d+(?:\.\d+)?) LUFS/g)];
    return values.length ? Number(values[values.length - 1][1]) : null;
  } catch (_error) {
    return null;
  }
}

async function attribution(file) {
  const text = await fs.readFile(file.replace(/\.[^.]+$/, '.txt'), 'utf8').catch(() => '');
  return text.replace(/\s+/g, ' ').trim() || null;
}

// Writes narration + music to outputPath (FLAC) and returns { path, tracks, credits }, or null without any track.
// segments carry { register, duration, position } and an optional chosen ambiance (a data/music folder name).
// The ducking key is a second read of the narration file rather than an asplit of it: the bundled FFmpeg 6.0 can
// deadlock when one split stream feeds both a sidechain and the final mix.
async function mixSoundtrack({ narrationPath, segments, outputPath, key, minSeconds = MIN_AMBIANCE_SECONDS }) {
  const runs = musicRuns(segments, { minSeconds, available: await ambiances() });
  if (!runs.length) return null;
  const chosen = [];
  for (const run of runs) {
    const tracks = await tracksFor(run.ambiance, run.phase);
    if (!tracks.length) return null;
    chosen.push({ ...run, file: pickTrack(tracks, `${key}:${run.ambiance}`) });
  }
  const total = runs[runs.length - 1].end;
  const crossfade = Math.min(CROSSFADE_SECONDS, ...runs.map(run => (run.end - run.start) / 2));
  const inputs = ['-i', narrationPath, '-i', narrationPath];
  const chain = [`[0:a]${STEREO}[voice]`, `[1:a]${STEREO}[key]`];
  const levels = new Map();
  for (const [index, run] of chosen.entries()) {
    if (!levels.has(run.file)) levels.set(run.file, await integratedLufs(run.file));
    const gain = Math.max(-40, Math.min(6, targetLufs() - (levels.get(run.file) ?? ASSUMED_TRACK_LUFS)));
    // Each piece overlaps its neighbours by half a crossfade on each side, so the crossfades land on the boundaries.
    const length = run.end - run.start + (index > 0 ? crossfade / 2 : 0) + (index < chosen.length - 1 ? crossfade / 2 : 0);
    inputs.push('-stream_loop', '-1', '-i', run.file);
    chain.push(`[${index + 2}:a]${STEREO},atrim=0:${length.toFixed(3)},asetpts=PTS-STARTPTS,volume=${gain.toFixed(1)}dB[m${index}]`);
  }
  let bed = 'm0';
  for (let index = 1; index < chosen.length; index++) {
    chain.push(`[${bed}][m${index}]acrossfade=d=${crossfade.toFixed(3)}:c1=tri:c2=tri[x${index}]`);
    bed = `x${index}`;
  }
  chain.push(
    `[${bed}]afade=t=in:d=${FADE_IN_SECONDS},afade=t=out:st=${Math.max(0, total - FADE_OUT_SECONDS).toFixed(2)}:d=${FADE_OUT_SECONDS}[bed]`,
    // Calibrated on the Azure narration (about -23 LUFS): under the voice the music sits near -38 LUFS, and it comes
    // back up within a second when the voice stops.
    '[bed][key]sidechaincompress=threshold=0.007:ratio=3.5:attack=150:release=900[ducked]',
    '[voice][ducked]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.97:level=0[out]'
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runFFmpeg(['-y', ...inputs, '-filter_complex', chain.join(';'), '-map', '[out]', '-c:a', 'flac', outputPath]);
  const credits = [];
  for (const file of new Set(chosen.map(run => run.file))) {
    const text = await attribution(file);
    if (text) credits.push(text);
  }
  return {
    path: outputPath,
    tracks: chosen.map(run => ({ file: path.basename(run.file), ambiance: run.ambiance, phase: run.phase, start: Number(run.start.toFixed(2)), end: Number(run.end.toFixed(2)) })),
    credits
  };
}

module.exports = { mixSoundtrack, chooseAmbiances, ambiances, tracksFor, musicRuns, pickTrack, enabled, musicDir, defaults, MIN_AMBIANCE_SECONDS };
