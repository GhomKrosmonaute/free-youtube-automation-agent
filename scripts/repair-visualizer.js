// Renders audio-reactive visualizer clips for every scene of an existing production and marks them as scene assets.
require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const { Database } = require('../database/db');
const { renderSceneClip } = require('../utils/visualizer');
const { scriptScenes } = require('../utils/scene-repair-service');
(async () => {
  const productionId = process.argv[2];
  const db = new Database(); await db.initialize();
  const bundle = await db.getProductionBundle(productionId);
  const dir = path.join(__dirname, '..', 'data', 'assets', 'scenes', productionId);
  await fs.mkdir(dir, { recursive: true });
  const registers = scriptScenes(bundle.script || {}).map(blueprint => blueprint.register);
  for (const scene of bundle.scenes.sort((a, b) => a.position - b.position)) {
    const out = path.join(dir, `${String(scene.position).padStart(3, '0')}_r${scene.revision}.mp4`);
    const started = Date.now();
    await renderSceneClip({ audioPath: scene.audioPath, outputPath: out, title: bundle.script?.title || '', label: scene.label, text: scene.scriptText, durationSeconds: Number(scene.duration), palette: process.env.VISUAL_PALETTE || 'blood', register: registers[scene.position] || 'critical', showTitle: scene.position === 0 });
    await db.updateProductionScene(productionId, scene.id, { assetPath: out, assetType: 'video', assetOrigin: 'generated', provider: 'visualizer', model: 'ffmpeg-showwaves', status: 'ready', containsSyntheticMedia: false, rightsConfirmed: true });
    console.log(`clip ${scene.position + 1}/${bundle.scenes.length} ${scene.label.slice(0, 40)} ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  if (typeof db.close === 'function') await db.close();
})().catch(e => { console.error(e); process.exit(1); });
