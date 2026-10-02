// Builds a YouTube thumbnail (1280x720 JPEG) from an illustration plus a short headline, FFmpeg only.
// The illustration is generated with its subject on the right, so the headline sits on a left-hand gradient
// and never covers it. The headline is a 2-4 word complement to the title, not a copy of it.
const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg } = require('./ffmpeg');
const { ensureFonts, filterPath, glueTypography } = require('./visualizer');

function wrap(text, max) {
  const words = glueTypography(text).split(' ').filter(Boolean);
  const lines = [''];
  for (const word of words) {
    if (lines[lines.length - 1].length + word.length + 1 > max && lines[lines.length - 1]) lines.push(word);
    else lines[lines.length - 1] = `${lines[lines.length - 1]} ${word}`.trim();
  }
  return lines;
}

// Narrow lines make bigger letters: wrap as tight as the longest word allows while staying within 3 lines.
function layoutLines(label) {
  const longest = Math.max(...glueTypography(label).split(' ').map(word => word.length));
  for (let max = Math.max(7, longest); max < 40; max++) {
    const lines = wrap(label, max);
    if (lines.length <= 3) return lines;
  }
  return wrap(label, 40).slice(0, 3);
}

// Fallback headline when the script has no thumbnail text: the part of the title before the colon,
// cut to four words so it stays legible on a phone.
function headline(title) {
  const raw = String(title || '').trim();
  const cut = raw.split(/\s[:–—]\s|:\s/)[0];
  const words = (cut.length >= 12 ? cut : raw).split(/\s+/).filter(Boolean);
  return words.slice(0, 4).join(' ').replace(/[,;:]$/, '').toUpperCase();
}

async function composeThumbnail({ imagePath, title, text = '', outputPath, accent = '0xd11a2a' }) {
  const bold = (await ensureFonts()).bold;
  const workDir = path.join(path.dirname(outputPath), `.thumb_${path.basename(outputPath, path.extname(outputPath))}`);
  await fs.mkdir(workDir, { recursive: true });
  const label = String(text || '').trim() ? String(text).trim().toUpperCase() : headline(title);
  const lines = layoutLines(label);
  const widest = Math.max(...lines.map(line => line.length));
  // Keep the block inside the left ~57% of the frame (bold serif capitals average ~0.72 em wide).
  const size = Math.max(64, Math.min(150, Math.floor(730 / (widest * 0.72))));
  const lineHeight = Math.round(size * 1.04);
  const blockHeight = lines.length * lineHeight;
  const top = Math.round(Math.max(90, (720 - blockHeight) / 2 + 40));
  const chain = [
    `[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,eq=contrast=1.1:saturation=0.95[base]`,
    // Left-hand gradient: dense behind the text, gone before the right third where the subject stands.
    `color=c=black:s=1280x720,format=rgba,geq=r=0:g=0:b=0:a='235*pow(max(0\\,1-X/(W*0.66))\\,1.3)'[shade]`,
    `[base][shade]overlay=0:0[v1]`,
    `[v1]drawbox=x=64:y=${top - 34}:w=150:h=10:color=${accent}@1:t=fill[v2]`
  ];
  let prev = 'v2';
  for (const [index, line] of lines.entries()) {
    const file = path.join(workDir, `line${index}.txt`);
    await fs.writeFile(file, line);
    const y = top + index * lineHeight;
    chain.push(`[${prev}]drawtext=fontfile='${filterPath(bold)}':textfile='${filterPath(file)}':fontcolor=0xF6F1E7:fontsize=${size}:x=60:y=${y}:shadowcolor=black@0.85:shadowx=5:shadowy=5:borderw=2:bordercolor=black@0.6[t${index}]`);
    prev = `t${index}`;
  }
  chain.push(`[${prev}]vignette=PI/6,format=yuvj420p[out]`);
  try {
    await runFFmpeg(['-y', '-i', imagePath, '-filter_complex', chain.join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '2', outputPath]);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
  return outputPath;
}

module.exports = { composeThumbnail, headline };
