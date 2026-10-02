require('dotenv').config();
const path = require('path');
const { Database } = require('../database/db');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { runFFmpeg, getMediaDuration } = require('../utils/ffmpeg');
(async () => {
  const productionId = process.argv[2];
  const db = new Database(); await db.initialize();
  const bundle = await db.getProductionBundle(productionId);
  const generator = new AIVideoGenerator(require('../config/credentials.json'), { db });
  const dir = path.join(__dirname, '..', 'data', 'audio', 'scenes', productionId);
  const segments = [];
  for (const scene of bundle.scenes.sort((a, b) => a.position - b.position)) {
    const out = path.join(dir, `${String(scene.position).padStart(3, '0')}_r${scene.revision + 1}.mp3`);
    const text = String(scene.scriptText || '').trim();
    if (!text) await runFFmpeg(['-y', '-f', 'lavfi', '-t', '1', '-i', 'anullsrc=r=44100:cl=stereo', '-c:a', 'libmp3lame', out]);
    else await generator.generateTTSAudio(text, out);
    const duration = Number((await getMediaDuration(out)).toFixed(2));
    await db.updateProductionScene(productionId, scene.id, { audioPath: out, duration, narrationStatus: 'current', narrationError: null, narrationProvider: 'kokoro', narrationModel: `kokoro-82m:${process.env.TTS_VOICE}`, narrationGeneratedAt: new Date().toISOString(), revision: scene.revision + 1 });
    segments.push({ position: scene.position, label: scene.label, path: out, duration });
    console.log(`scene ${scene.position + 1}/${bundle.scenes.length} ${scene.label.slice(0, 40)} -> ${duration}s`);
  }
  console.log('TOTAL', segments.reduce((s, x) => s + x.duration, 0).toFixed(1), 's');
  if (typeof db.close === 'function') await db.close();
})().catch(e => { console.error(e); process.exit(1); });
