// Corrects one scene's narration text, regenerates its audio (with the studio chain) and its illustrated
// clip, and updates the scene record. Usage: node scripts/repair-scene-text.js <productionId> <sceneId> "<find>" "<replace>"
require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const { Database } = require('../database/db');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { getMediaDuration } = require('../utils/ffmpeg');
const { renderSceneClip } = require('../utils/visualizer');
const { scriptScenes } = require('../utils/scene-repair-service');
(async () => {
  const [productionId, sceneId, find, replace] = process.argv.slice(2);
  const db = new Database(); await db.initialize();
  const bundle = await db.getProductionBundle(productionId);
  const scene = bundle.scenes.find(s => s.id === sceneId);
  if (!scene) throw new Error('scene not found');
  if (!scene.scriptText.includes(find)) throw new Error('text to replace not found in the scene');
  const scriptText = scene.scriptText.replace(find, replace);
  const generator = new AIVideoGenerator(require('../config/credentials.json'), { db });
  const audioDir = path.join(__dirname, '..', 'data', 'audio', 'scenes', productionId);
  const audioPath = path.join(audioDir, `${String(scene.position).padStart(3, '0')}_r${scene.revision + 1}.mp3`);
  await generator.generateTTSAudio(scriptText, audioPath);
  const duration = Number((await getMediaDuration(audioPath)).toFixed(2));
  const clipDir = path.join(__dirname, '..', 'data', 'assets', 'scenes', productionId);
  const image = path.join(clipDir, `${String(scene.position).padStart(3, '0')}_illustration.png`);
  const clipPath = path.join(clipDir, `${String(scene.position).padStart(3, '0')}_r${scene.revision + 1}.mp4`);
  let imagePath = image; try { await fs.access(image); } catch (_e) { imagePath = null; }
  await renderSceneClip({ audioPath, outputPath: clipPath, imagePath, title: bundle.script?.title || '', label: scene.label, text: scriptText, durationSeconds: duration, palette: process.env.VISUAL_PALETTE || 'blood', register: scriptScenes(bundle.script || {})[scene.position]?.register || 'critical', showTitle: scene.position === 0 });
  await db.updateProductionScene(productionId, sceneId, { scriptText, audioPath, duration, assetPath: clipPath, assetType: 'video', status: 'ready', narrationStatus: 'current', narrationError: null, revision: scene.revision + 1, narrationProvider: generator.lastNarrationResult?.provider || scene.narrationProvider, narrationModel: generator.lastNarrationResult?.model || scene.narrationModel, narrationGeneratedAt: new Date().toISOString() });
  console.log(`scene ${scene.position + 1} "${scene.label}" corrected: ${duration}s`);
  if (db.close) await db.close();
})().catch(e => { console.error(e.message.slice(-600)); process.exit(1); });
