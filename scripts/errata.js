#!/usr/bin/env node
// Errors found after publication. They are shown on the public verification site (and on the video's page there);
// the published video itself is never modified.
//   npm run errata                                          every correction, newest first
//   npm run errata -- add <productionId|youtubeId> "texte"  records one; the site is rebuilt within 10 minutes
require('dotenv').config({ quiet: true });
const { Database } = require('../database/db');

async function productionOf(db, reference) {
  const production = await db.getRow('SELECT id FROM productions WHERE id = ?', [reference]);
  if (production) return production.id;
  const rows = await db.getAllRows("SELECT production_id, metadata FROM publish_schedule WHERE youtube_id = ?", [reference]);
  // Not a Short cut out of a video: the video itself (a Short that stands alone has its own production).
  const video = rows.find(row => !JSON.parse(row.metadata || '{}').shortClipId);
  return video?.production_id || null;
}

async function main() {
  const [command = 'list', reference, ...words] = process.argv.slice(2);
  const db = new Database();
  await db.initialize();
  if (command === 'list') {
    const corrections = await db.listCorrections();
    if (!corrections.length) console.log('Aucune correction.');
    for (const item of corrections) console.log(`${item.createdAt}  ${item.productionId}  ${item.text}`);
    return;
  }
  if (command !== 'add') throw new Error(`Commande inconnue : ${command} (list, add)`);
  const text = words.join(' ').trim();
  if (!reference || text.length < 10) throw new Error('Usage : npm run errata -- add <productionId|youtubeId> "la correction (10 caractères au moins)"');
  const productionId = await productionOf(db, reference);
  if (!productionId) throw new Error(`Aucune vidéo trouvée pour ${reference}`);
  await db.addCorrection({ productionId, text: text.slice(0, 2000) });
  await db.setSetting('site_rebuild_needed', 'true');
  console.log('Correction enregistrée : elle sera en ligne au prochain passage du serveur (10 min au plus), ou tout de suite avec npm run site.');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
