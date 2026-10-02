// Visual track rendered entirely with FFmpeg. Two looks:
//  - "spectrum": animated dark gradient, mirrored frequency spectrum with glow, thin waveform, grain, vignette.
//  - "illustrated": a still image (e.g. locally generated) with a slow Ken Burns move, darkened.
// Both burn a title card (first scene only), a chapter card with the section title (first seconds of each
// scene; internal labels such as "Hook" are never shown), a progress bar and ASS captions sized for 1920x1080.
// Captions follow the narration's word timings when the TTS provider returned them.
const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { captionCues, readWordTimings } = require('./narration-timing');
const { isOpening } = require('./content-mode');
const { look } = require('./react-profile');

const FONT_DIR = path.join(__dirname, '..', 'data', 'fonts');
const FONT_BOLD = path.join(FONT_DIR, 'title-bold.ttf');
const FONT_REGULAR = path.join(FONT_DIR, 'title-regular.ttf');
const SYSTEM_FONTS = {
  bold: ['/System/Library/Fonts/Supplemental/Georgia Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf', 'C:\\Windows\\Fonts\\georgiab.ttf'],
  regular: ['/System/Library/Fonts/Supplemental/Georgia.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf', 'C:\\Windows\\Fonts\\georgia.ttf']
};

// Fonts are not redistributable, so they are copied from the system on first use (or set VIZ_FONT_BOLD / VIZ_FONT_REGULAR).
async function ensureFonts() {
  await fs.mkdir(FONT_DIR, { recursive: true });
  for (const [kind, target] of [['bold', FONT_BOLD], ['regular', FONT_REGULAR]]) {
    const override = process.env[kind === 'bold' ? 'VIZ_FONT_BOLD' : 'VIZ_FONT_REGULAR'];
    if (override) continue;
    try { await fs.access(target); continue; } catch (_error) { /* copy below */ }
    for (const candidate of SYSTEM_FONTS[kind]) {
      try { await fs.copyFile(candidate, target); break; } catch (_error) { /* try next */ }
    }
  }
  return {
    bold: process.env.VIZ_FONT_BOLD || FONT_BOLD,
    regular: process.env.VIZ_FONT_REGULAR || FONT_REGULAR
  };
}

const PALETTES = {
  blood: { bg0: '0x08080b', bg1: '0x2b0a10', bg2: '0x0e0e14', accent: '0xd11a2a', accent2: '0x7a0f19', title: '0xefe9df', label: '0xa39e96', cqt: '0.85|0.1|0.14|1|0.55|0.5' },
  ash: { bg0: '0x0b0b0b', bg1: '0x242424', bg2: '0x0b0b0b', accent: '0xe6e1d8', accent2: '0x8a8580', title: '0xffffff', label: '0xa0a0a0', cqt: '0.9|0.88|0.84|1|1|1' },
  abyss: { bg0: '0x05070c', bg1: '0x0b1a33', bg2: '0x05070c', accent: '0x4fa3ff', accent2: '0x1d4f8f', title: '0xeaf1ff', label: '0x9fb3cc', cqt: '0.3|0.6|1|0.9|0.95|1' },
  // A warm look, the default of the opening part of a two-part video.
  parchment: { bg0: '0x0f0c08', bg1: '0x2a2116', bg2: '0x120e09', accent: '0xc9a45c', accent2: '0x7d6534', title: '0xf4ecdc', label: '0xcbbd9f', cqt: '0.85|0.7|0.4|1|0.9|0.7' }
};

// Palette for a scene: the opening part of a two-part video has its own (react profile, warm by default); otherwise
// the palette set (VISUAL_PALETTE), else the profile's, else a neutral blue.
function paletteFor(register, palette) {
  return isOpening(register) ? look().openingPalette : (palette || look().palette);
}

// Internal scene labels are pipeline vocabulary, not chapter titles.
const INTERNAL_LABELS = /^(hook|introduction|conclusion|call to action|cta|scene\s*\d*|video)$/i;
function displayLabel(label) {
  const text = String(label || '').trim();
  return text && !INTERNAL_LABELS.test(text) ? text : '';
}

function assTime(seconds) {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Captions for one scene: word-timed when timings exist, otherwise spread by length; cues break on punctuation.
function sceneCues(text, durationSeconds, words = null) {
  return captionCues(text, durationSeconds, { words, maxWords: 8, maxChars: 46 });
}

// A translucent box behind each caption keeps it readable on bright engravings (BorderStyle 3 = opaque box,
// drawn with OutlineColour; Outline is the padding).
function assDocument(cues, {
  fontName = 'Georgia', fontSize = 54, primary = '&H00F2EFE9', outline = '&H5A000000', back = '&H00000000',
  borderStyle = 3, outlineWidth = 10, shadow = 0, playResX = 1920, playResY = 1080, marginH = 260, marginV = 70, bold = 0
} = {}) {
  const header = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${playResX}`, `PlayResY: ${playResY}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${fontName},${fontSize},${primary},&H000000FF,${outline},${back},${bold},0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadow},2,${marginH},${marginH},${marginV},1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const events = cues.map(cue => `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Caption,,0,0,0,,${cue.text.replace(/\n/g, ' ')}`);
  return header.concat(events).join('\n') + '\n';
}

// French typography puts a space before ? ! : ; and inside « »: glue those with a non-breaking space so a
// wrapped line never starts with a lone punctuation mark. Split the result on plain spaces only.
function glueTypography(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().replace(/ ([?!:;»])/g, '\u00a0$1').replace(/« /g, '«\u00a0');
}

function wrapTitle(text, max) {
  const words = glueTypography(text).split(' ').filter(Boolean);
  const lines = [''];
  for (const word of words) {
    if (lines[lines.length - 1].length + word.length + 1 > max && lines[lines.length - 1]) lines.push(word);
    else lines[lines.length - 1] = (lines[lines.length - 1] + ' ' + word).trim();
  }
  return lines.slice(0, 2).join('\n');
}

function filterPath(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'").replace(/,/g, '\\,').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

// Fade-in / hold / fade-out alpha for a card visible during the first `seconds` of the clip.
function cardAlpha(seconds) {
  const s = seconds.toFixed(2);
  return `if(lt(t,0.4),t/0.4,if(lt(t,${s}-0.5),1,max(0,(${s}-t)/0.5)))`;
}

// options.showTitle: burn the video title as an opening card (first scene only).
// options.register: "opening" switches to the opening palette, "main" keeps `palette`.
// options.inserts: [{ path, start, end }] transparent PNG cards (agents/visual-insert-agent.js) centred over the
// scene between `start` and `end` seconds, under the captions.
async function renderSceneClip(options) {
  const {
    audioPath, outputPath, title = '', label = '', text = '', durationSeconds = null,
    palette = process.env.VISUAL_PALETTE, register = 'main', imagePath = null, width = 1920, height = 1080,
    showTitle = false, titleSeconds = 5, labelSeconds = 4, inserts = []
  } = options;
  const colors = PALETTES[paletteFor(register, palette)] || PALETTES.blood;
  const fonts = await ensureFonts();
  const duration = durationSeconds || Number(await getMediaDuration(audioPath));
  const frames = Math.ceil(duration * 30) + 1;
  const workDir = path.join(path.dirname(outputPath), `.viz_${path.basename(outputPath, '.mp4')}`);
  await fs.mkdir(workDir, { recursive: true });
  const cardFile = path.join(workDir, 'card.txt');
  const assFile = path.join(workDir, 'captions.ass');
  // One card per scene: the title on the opening scene, otherwise the chapter (section) title.
  const cardText = showTitle && title ? wrapTitle(String(title).toUpperCase(), 40) : wrapTitle(displayLabel(label).toUpperCase(), 40);
  const cardSeconds = Math.min(duration, showTitle && title ? titleSeconds : labelSeconds);
  const cardLines = cardText ? cardText.split('\n').length : 0;
  const cardSize = showTitle && title ? 58 : 46;
  const ruleY = 90 + (cardSize + 12) * cardLines + 8;
  if (cardText) await fs.writeFile(cardFile, cardText);
  const words = await readWordTimings(audioPath);
  await fs.writeFile(assFile, assDocument(sceneCues(text, duration, words)));

  const inputs = ['-i', audioPath];
  const chain = [];
  if (imagePath) {
    // Ken Burns: slow push-in on the illustration, darkened so text and captions stay readable.
    inputs.push('-loop', '1', '-framerate', '30', '-i', imagePath);
    chain.push(
      `[1:v]scale=${width * 1.25}:${height * 1.25}:force_original_aspect_ratio=increase,crop=${width * 1.25}:${height * 1.25},` +
      `zoompan=z='min(1.0+on*0.00035,1.28)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${width}x${height}:fps=30,` +
      `eq=brightness=-0.08:contrast=1.08:saturation=0.85,vignette=PI/3.2,format=rgba[bg]`
    );
  } else {
    chain.push(`gradients=s=${width}x${height}:c0=${colors.bg0}:c1=${colors.bg1}:c2=${colors.bg2}:x0=${Math.round(width * 0.1)}:y0=${Math.round(height * 0.1)}:x1=${Math.round(width * 0.9)}:y1=${Math.round(height * 0.95)}:speed=0.012:r=30:d=${duration.toFixed(2)},format=rgba[bg]`);
  }
  if (!imagePath) {
    // Spectrum look only: scrolling spectrogram texture, mirrored frequency band and waveform. The illustrated
    // look keeps the image clean (a band over the illustration read as a glitch).
    const bandHeight = 2 * Math.round((height * 0.2) / 2);
    const bandY = Math.round(height / 2) - bandHeight;
    chain.push(
      `[0:a]showspectrum=s=${width}x${2 * Math.round(height * 0.25)}:slide=scroll:mode=combined:color=fire:scale=log:fscale=log:legend=0:overlap=0.9,format=rgba,gblur=sigma=2,colorchannelmixer=aa=0.42[tex]`,
      `[bg][tex]overlay=0:${Math.round(height * 0.25)}:shortest=1[bgt]`,
      `[0:a]showfreqs=s=${width}x${bandHeight}:mode=bar:ascale=log:fscale=log:win_size=4096:averaging=3:colors=${colors.accent}|${colors.accent2},format=rgba[bars]`,
      '[bars]split[ba][bb]', '[bb]vflip[bbf]', '[ba][bbf]vstack[mirror]',
      '[mirror]split[m1][m2]',
      `[m2]scale=iw/2:ih/2,gblur=sigma=9,scale=${width}:${bandHeight * 2}[glow]`,
      `[m1][glow]blend=all_mode=screen,colorkey=0x000000:0.22:0.12,colorchannelmixer=aa=0.9[spec]`,
      `[bgt][spec]overlay=0:${bandY}:shortest=1[v1]`,
      `[0:a]showwaves=s=${width}x110:mode=cline:rate=30:colors=${colors.title}|${colors.accent}:scale=sqrt:draw=full,format=rgba,colorchannelmixer=aa=0.85[wave]`,
      `[v1][wave]overlay=0:${Math.round(height / 2) - 55}:shortest=1[v2]`
    );
  } else {
    chain.push('[bg]null[v2]');
  }
  if (cardText) {
    const alpha = cardAlpha(cardSeconds);
    chain.push(
      `[v2]drawbox=x=80:y=${ruleY}:w=140:h=5:color=${colors.accent}@0.95:t=fill:enable='lt(t,${(cardSeconds - 0.3).toFixed(2)})'[v3]`,
      `[v3]drawtext=fontfile='${filterPath(fonts.bold)}':textfile='${filterPath(cardFile)}':fontcolor=${colors.title}:fontsize=${cardSize}:line_spacing=12:x=80:y=90:alpha='${alpha}':shadowcolor=0x000000@0.7:shadowx=3:shadowy=3:enable='lt(t,${cardSeconds.toFixed(2)})'[v5]`
    );
  } else {
    chain.push('[v2]null[v5]');
  }
  chain.push(
    `[v5]drawbox=x=0:y=${height - 6}:w='iw*t/${duration.toFixed(2)}':h=6:color=${colors.accent}@0.9:t=fill[v6]`,
    `[v6]noise=alls=7:allf=t+u,vignette=PI/4.5[v7]`
  );
  // Each card fades in while rising a few pixels, holds, and fades out; it is shifted to its start time and the
  // scene passes through untouched outside its window.
  let visual = 'v7';
  for (const [index, insert] of inserts.entries()) {
    const start = Math.max(0, insert.start);
    const length = Math.min(insert.end, duration) - start;
    if (length < 1) continue;
    const input = inputs.filter(argument => argument === '-i').length;
    inputs.push('-loop', '1', '-framerate', '30', '-t', length.toFixed(2), '-i', insert.path);
    chain.push(
      `[${input}:v]format=rgba,fade=t=in:st=0:d=0.4:alpha=1,fade=t=out:st=${(length - 0.45).toFixed(2)}:d=0.45:alpha=1,setpts=PTS-STARTPTS+${start.toFixed(2)}/TB[card${index}]`,
      `[${visual}][card${index}]overlay=x=(W-w)/2:y='(H-h)/2-40+max(0,14*(1-(t-${start.toFixed(2)})/0.5))':eof_action=pass:enable='between(t,${start.toFixed(2)},${(start + length).toFixed(2)})'[vc${index}]`
    );
    visual = `vc${index}`;
  }
  chain.push(`[${visual}]ass='${filterPath(assFile)}'[vout]`);
  try {
    await runFFmpeg([
      '-y', ...inputs, '-filter_complex', chain.join(';'),
      '-map', '[vout]', '-map', '0:a', '-t', duration.toFixed(2),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outputPath
    ]);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
  return { path: outputPath, duration };
}

module.exports = { renderSceneClip, sceneCues, assDocument, ensureFonts, filterPath, paletteFor, displayLabel, glueTypography, PALETTES };
