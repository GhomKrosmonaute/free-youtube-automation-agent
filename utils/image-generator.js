// Local, free illustration generation on Apple Silicon through mflux (Z-Image Turbo, 4-bit).
// One image per scene, styled by a channel-wide prompt suffix. Nothing leaves the machine.
const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { isOpening } = require('./content-mode');
const { look } = require('./react-profile');

const execFileAsync = promisify(execFile);
const ROOT = path.join(__dirname, '..');

// The illustration style: IMAGE_STYLE_PROMPT, else the react profile's look, else a clean editorial look. The opening
// of a two-part video can have its own (IMAGE_STYLE_PROMPT_OPENING, or the profile's openingImageStyle).
const STANDARD_STYLE = 'detailed editorial illustration, clean composition, soft natural light, balanced colours, cinematic framing, no text, no letters, no watermark';

function localImageEngine() {
  const engine = String(process.env.IMAGE_PROVIDER || '').toLowerCase();
  return engine === 'zimage' || engine === 'mflux' ? 'zimage' : null;
}

function styleSuffix(register = 'main') {
  const main = process.env.IMAGE_STYLE_PROMPT || look().imageStyle || STANDARD_STYLE;
  if (!isOpening(register)) return main;
  return process.env.IMAGE_STYLE_PROMPT_OPENING || look().openingImageStyle || main;
}

// The style is always kept whole: the scene description is shortened instead when the prompt is too long.
async function generateLocalImage({ prompt, outputPath, width = 1280, height = 720, seed = null, steps = null, logger = null, register = 'main' }) {
  const binary = process.env.MFLUX_BIN || path.join(ROOT, '.venv-images', 'bin', 'mflux-generate-z-image-turbo');
  const model = process.env.ZIMAGE_MODEL || 'filipstrand/Z-Image-Turbo-mflux-4bit';
  const style = styleSuffix(register);
  const fullPrompt = `${String(prompt || '').trim().slice(0, Math.max(200, 900 - style.length - 2))}. ${style}`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const args = [
    '--model', model, '--steps', String(steps || process.env.ZIMAGE_STEPS || 8),
    '--width', String(width), '--height', String(height),
    '--seed', String(seed ?? Math.floor(Math.random() * 1e9)),
    '--output', outputPath, '--prompt', fullPrompt
  ];
  const started = Date.now();
  await execFileAsync(binary, args, {
    maxBuffer: 16 * 1024 * 1024,
    timeout: Number(process.env.IMAGE_TIMEOUT_MS || 20 * 60 * 1000),
    env: { ...process.env, PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false' }
  });
  await fs.access(outputPath);
  logger?.info?.(`Local illustration generated in ${((Date.now() - started) / 1000).toFixed(0)}s: ${path.basename(outputPath)}`);
  return outputPath;
}

module.exports = { generateLocalImage, localImageEngine, styleSuffix, STANDARD_STYLE };
