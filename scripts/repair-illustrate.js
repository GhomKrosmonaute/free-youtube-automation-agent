// For an existing production: ask Claude for one English illustration prompt per scene, generate the
// images locally (Z-Image Turbo), render illustrated clips, register them as scene assets.
require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const { Database } = require('../database/db');
const { AITextService } = require('../utils/ai-text-service');
const { extractJson } = require('../utils/ai-json');
const { generateLocalImage } = require('../utils/image-generator');
const { renderSceneClip } = require('../utils/visualizer');
const { scriptScenes } = require('../utils/scene-repair-service');

(async () => {
  const productionId = process.argv[2];
  const db = new Database(); await db.initialize();
  const bundle = await db.getProductionBundle(productionId);
  const scenes = bundle.scenes.sort((a, b) => a.position - b.position);
  const text = new AITextService(require('../config/credentials.json'));
  const prompt = `You write image prompts for a video titled "${bundle.script?.title}". For each scene below, return one concrete, visual English sentence describing a symbolic, text-free illustration (objects, figures, places, symbols, light; no lettering; no living public figures). Return only a JSON array of strings, one per scene, in order.\n\n${scenes.map((s, i) => `${i + 1}. [${s.label}] ${String(s.scriptText || '').slice(0, 400)}`).join('\n')}`;
  const prompts = extractJson(await text.generateText(prompt, { maxTokens: 2000, temperature: 0.7, purpose: 'repair_illustrate' }));
  if (!Array.isArray(prompts) || prompts.length !== scenes.length) throw new Error(`Expected ${scenes.length} prompts, got ${Array.isArray(prompts) ? prompts.length : typeof prompts}`);
  const dir = path.join(__dirname, '..', 'data', 'assets', 'scenes', productionId);
  await fs.mkdir(dir, { recursive: true });
  const registers = scriptScenes(bundle.script || {}).map(blueprint => blueprint.register);
  for (const [i, scene] of scenes.entries()) {
    const register = registers[scene.position] || 'critical';
    const image = path.join(dir, `${String(scene.position).padStart(3, '0')}_illustration.png`);
    const clip = path.join(dir, `${String(scene.position).padStart(3, '0')}_r${scene.revision}.mp4`);
    const started = Date.now();
    await generateLocalImage({ prompt: prompts[i], outputPath: image, seed: 1000 + i, register });
    await renderSceneClip({ audioPath: scene.audioPath, outputPath: clip, imagePath: image, title: bundle.script?.title || '', label: scene.label, text: scene.scriptText, durationSeconds: Number(scene.duration), palette: process.env.VISUAL_PALETTE || 'blood', register, showTitle: scene.position === 0 });
    await db.updateProductionScene(productionId, scene.id, { assetPath: clip, assetType: 'video', assetOrigin: 'generated', provider: 'visualizer', model: 'zimage-turbo+ffmpeg', prompt: prompts[i], status: 'ready', containsSyntheticMedia: false, rightsConfirmed: true });
    console.log(`scene ${i + 1}/${scenes.length} ${scene.label.slice(0, 40)} -> ${((Date.now() - started) / 1000).toFixed(0)}s | ${prompts[i].slice(0, 90)}`);
  }
  if (typeof db.close === 'function') await db.close();
})().catch(e => { console.error(e); process.exit(1); });
