// Reactions (react mode) are vertical Shorts, which also go to TikTok and Instagram Reels. The production's narrated
// scenes are laid out by the Shorts montage (utils/shorts-repurposing-service.js) over the whole narration, instead of
// being cut out of a 16:9 video. A reaction too long for one Short is a series (part 1, part 2...); once every part is
// published, the parts are joined end to end into one 16:9 video, each vertical frame over a blurred copy of itself.
const fs = require('fs').promises;
const path = require('path');
const { sceneTimeline, srtTime } = require('./narration-timing');
const { runFFmpeg: defaultRunFFmpeg, getMediaDuration } = require('./ffmpeg');

// YouTube counts a vertical video of up to three minutes as a Short.
const MAX_SHORT_SECONDS = 180;
const FR = (process.env.CONTENT_LANGUAGE || 'fr') === 'fr';

function isShortForm(strategy) {
  return strategy?.format === 'short';
}

function isVertical(video) {
  return video?.aspectRatio === '9:16';
}

// Where a part stands in its series: { part, parts }, 1 of 1 for a single Short.
function seriesOf(strategy = {}) {
  const parts = Math.max(1, Math.round(Number(strategy.parts) || 1));
  const part = Math.min(parts, Math.max(1, Math.round(Number(strategy.part) || 1)));
  return { part, parts };
}

const round = value => Math.round(Number(value) * 100) / 100;

// The vertical Short of a production, from its narrated scenes: the Shorts montage over the whole narration (the
// illustrations, word-timed captions, music), the subscribe card over the spoken call to action and, before the last
// part of a series, the part that follows. Without the scene illustrations, the 16:9 render stands in the middle of a
// blurred copy of itself. Returns the video asset, with the captions of the Short.
async function renderShort(production, scenes, options = {}) {
  const shorts = options.shorts || new (require('./shorts-repurposing-service').ShortsRepurposingService)(options.db || null, {
    ...(options.runFFmpeg ? { runFFmpeg: options.runFFmpeg } : {})
  });
  const directory = options.directory || path.join(__dirname, '..', 'data', 'videos');
  await fs.mkdir(directory, { recursive: true });
  const timeline = sceneTimeline(scenes);
  const total = timeline.reduce((sum, scene) => sum + scene.duration, 0);
  const { part, parts } = seriesOf(production.strategy);
  const last = timeline[timeline.length - 1];
  const clip = {
    id: `${production.id}_short`,
    title: production.script?.title || '',
    segments: [{ start: 0, end: total }],
    cta: null,
    closingAt: timeline.length > 1 ? last.startSeconds : null,
    endLine: part < parts ? (FR ? `SUITE : PARTIE ${part + 1}` : `NEXT: PART ${part + 1}`) : null
  };
  // A repaired Short gets new files (options.suffix), so the previous one stays as it was.
  const name = `${production.id}_short${options.suffix || ''}`;
  const outputPath = path.join(directory, `${name}.mp4`);
  const captionsPath = path.join(directory, `${name}.srt`);
  const native = Boolean(production.assets?.audio?.path) && await shorts.hasIllustrations(scenes, scenes);
  let duration = total;
  let captions = null;
  if (native) {
    const result = await shorts.renderMontage({ id: production.id, scenes, script: production.script, assets: production.assets }, clip, outputPath, captionsPath);
    await shorts.verifyRender(outputPath, result);
    duration = result.total;
    captions = captionsPath;
  } else {
    const source = production.assets?.finalVideo?.path;
    if (!source) throw new Error('No video to lay out as a Short');
    await shorts.runFFmpeg([
      '-y', '-i', source, '-filter_complex', shorts.videoFilter('blur'), '-map', '[shortv]', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', outputPath
    ]);
    captions = production.assets?.captions?.path || null;
  }
  return {
    path: outputPath,
    format: 'mp4',
    aspectRatio: '9:16',
    resolution: `${shorts.width}x${shorts.height}`,
    duration: round(duration),
    layout: native ? 'montage' : 'blur',
    captionsPath: captions
  };
}

function parseSrt(text) {
  const seconds = value => {
    const [h, m, rest] = value.split(':');
    return Number(h) * 3600 + Number(m) * 60 + Number(rest.replace(',', '.'));
  };
  return String(text || '').replace(/\r/g, '').split(/\n{2,}/).map(block => {
    const lines = block.trim().split('\n');
    const timing = lines.findIndex(line => line.includes('-->'));
    if (timing < 0) return null;
    const [start, end] = lines[timing].split('-->').map(value => seconds(value.trim().split(' ')[0]));
    return { start, end, text: lines.slice(timing + 1).join('\n') };
  }).filter(cue => cue && Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.text);
}

// The parts of a series joined end to end in 16:9: each vertical frame, full height, over a blurred and darkened copy
// of itself instead of black bars; one caption track, each part's captions moved to where the part starts.
async function compileSeries(videos, outputPath, options = {}) {
  if (!videos.length) throw new Error('A series needs at least one part');
  const runFFmpeg = options.runFFmpeg || defaultRunFFmpeg;
  const measure = options.getMediaDuration || getMediaDuration;
  const width = options.width || 1920;
  const height = options.height || 1080;
  const chain = videos.map((_, index) => [
    `[${index}:v]split[back${index}][front${index}]`,
    `[back${index}]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=28:3,eq=brightness=-0.22:saturation=0.8,setsar=1[bg${index}]`,
    `[front${index}]scale=-2:${height},setsar=1[fg${index}]`,
    `[bg${index}][fg${index}]overlay=(W-w)/2:0,fps=30,format=yuv420p,setsar=1[v${index}]`,
    `[${index}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`
  ].join(';'));
  chain.push(`${videos.map((_, index) => `[v${index}][a${index}]`).join('')}concat=n=${videos.length}:v=1:a=1[outv][outa]`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await runFFmpeg([
    '-y', ...videos.flatMap(video => ['-i', video.path]), '-filter_complex', chain.join(';'), '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outputPath
  ]);

  let offset = 0;
  const cues = [];
  for (const video of videos) {
    const measured = Number(await measure(video.path).catch(() => NaN));
    const duration = Number.isFinite(measured) && measured > 0 ? measured : Number(video.duration) || 0;
    if (video.captionsPath) {
      const text = await fs.readFile(video.captionsPath, 'utf8').catch(() => '');
      for (const cue of parseSrt(text)) cues.push({ start: cue.start + offset, end: Math.min(cue.end, duration) + offset, text: cue.text });
    }
    offset += duration;
  }
  let captionsPath = null;
  if (cues.length) {
    captionsPath = outputPath.replace(/\.mp4$/i, '.srt');
    await fs.writeFile(captionsPath, `${cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}`).join('\n\n')}\n`, 'utf8');
  }
  return { path: outputPath, format: 'mp4', aspectRatio: '16:9', resolution: `${width}x${height}`, duration: round(offset), captionsPath };
}

module.exports = { renderShort, compileSeries, parseSrt, isShortForm, isVertical, seriesOf, MAX_SHORT_SECONDS };
