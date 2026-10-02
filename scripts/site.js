#!/usr/bin/env node
// The public verification site (utils/claims-site.js): one page per published video, technique, the corrections.
//   npm run site                      build, commit and push to GitHub Pages (SITE_REPO: owner/name of the GitHub Pages repository)
//   npm run site -- --dry [--out dir] build only, into SITE_DIR (default data/site) or the folder given
// The server also rebuilds it a minute after each publication, every night, and after an erratum.
require('dotenv').config({ quiet: true });
const path = require('path');
const { Database } = require('../database/db');
const { deploySite } = require('../utils/claims-site');

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const out = args.indexOf('--out');
  const db = new Database();
  await db.initialize();
  const result = await deploySite(db, { directory: out >= 0 ? path.resolve(args[out + 1]) : undefined, push: !dry });
  if (dry) {
    console.log(`Site construit dans ${result.directory} : ${result.videos} vidéo${result.videos > 1 ? 's' : ''}, ${result.pages} fichiers.`);
  } else if (result.deployed) {
    await db.setSetting('site_rebuild_needed', 'false');
    console.log(`Site publié : ${result.videos} vidéo${result.videos > 1 ? 's' : ''}.`);
  } else {
    if (result.reason === 'no change') await db.setSetting('site_rebuild_needed', 'false');
    console.log(`Rien à publier (${result.reason === 'no change' ? 'aucun changement' : result.reason}).`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
