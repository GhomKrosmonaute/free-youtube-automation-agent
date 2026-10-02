// Rebuilds the thumbnail of an existing production from its thumbnail (or hook) illustration and records it as the thumbnail asset.
require('dotenv').config();
const path = require('path');
const fs = require('fs').promises;
const { Database } = require('../database/db');
const { composeThumbnail } = require('../utils/thumbnail-composer');
(async () => {
  const productionId = process.argv[2];
  const db = new Database(); await db.initialize();
  const bundle = await db.getProductionBundle(productionId);
  const dir = path.join(__dirname, '..', 'data', 'assets', 'scenes', productionId);
  const candidates = ['thumbnail_illustration.png', '000_illustration.png', '001_illustration.png'].map(f => path.join(dir, f));
  let image = null;
  for (const c of candidates) { try { await fs.access(c); image = c; break; } catch (_e) { /* next */ } }
  if (!image) throw new Error('No illustration found for the thumbnail');
  const out = path.join(__dirname, '..', 'data', 'thumbnails', `${productionId}_thumbnail.jpg`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await composeThumbnail({ imagePath: image, title: bundle.script?.title || '', text: bundle.script?.thumbnailText || '', outputPath: out });
  const stats = await fs.stat(out);
  const assets = { ...bundle.assets, thumbnail: { ...(bundle.assets?.thumbnail || {}), path: out, originalPath: image, dimensions: { width: 1280, height: 720 }, fileSize: stats.size, generatedWith: 'illustration+ffmpeg', simulated: false } };
  await db.updateProductionData({ id: bundle.id, status: bundle.status, assets, timeline: bundle.timeline, scheduledPublishTime: bundle.scheduled_publish_time, priority: bundle.priority });
  console.log('thumbnail:', out, stats.size, 'bytes');
  if (typeof db.close === 'function') await db.close();
})().catch(e => { console.error(e.message.slice(-800)); process.exit(1); });
