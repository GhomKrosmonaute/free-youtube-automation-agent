#!/usr/bin/env node
// Claims widely defended on YouTube and rarely answered: what the planner covers first (utils/topic-gap-finder.js).
//   npm run gaps                          open gaps, widest first
//   npm run gaps -- all                   every gap, with its status
//   npm run gaps -- refresh [--limit N]   measures N new candidates now (default 12), within the daily search budget
//   npm run gaps -- dismiss <gapId>       never plan this one
require('dotenv').config({ quiet: true });
const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { AITextService } = require('../utils/ai-text-service');
const { TopicGapFinder } = require('../utils/topic-gap-finder');
const { YouTubeSearchBudget, dailyLimit } = require('../utils/youtube-search-budget');

const views = value => (value >= 1e6 ? `${(value / 1e6).toFixed(1)} M` : value >= 1e3 ? `${Math.round(value / 1e3)} k` : String(value));

function print(gaps) {
  if (!gaps.length) console.log('Aucun écart mesuré.');
  for (const gap of gaps) {
    console.log(`${gap.id}  score ${gap.score.toFixed(2)}  ${views(gap.demandViews)} vues pour / ${views(gap.supplyViews)} contre  [${gap.status}]`);
    console.log(`    « ${gap.claim} »${gap.pillar ? `  (${gap.pillar})` : ''}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const [command = 'list', reference] = args;
  const db = new Database();
  await db.initialize();
  if (command === 'list' || command === 'all') {
    print(await db.listTopicGaps({ status: command === 'list' ? 'open' : null, limit: 50 }));
    return;
  }
  if (command === 'dismiss') {
    if (!reference || !(await db.getTopicGap(reference))) throw new Error('Usage : npm run gaps -- dismiss <gapId>');
    await db.updateTopicGap(reference, { status: 'dismissed' });
    console.log('Écart écarté : il ne sera plus planifié.');
    return;
  }
  if (command !== 'refresh') throw new Error(`Commande inconnue : ${command} (list, all, refresh, dismiss)`);
  const limitIndex = args.indexOf('--limit');
  const limit = Math.max(1, Number(limitIndex >= 0 ? args[limitIndex + 1] : 12) || 12);
  const strategy = await db.getChannelStrategy();
  if (!strategy) throw new Error('Aucune stratégie de chaîne : lance npm run walkthrough');
  const credentials = new CredentialManager();
  await credentials.initialize();
  const budget = new YouTubeSearchBudget(db);
  console.log(`Recherches YouTube disponibles aujourd'hui : ${await budget.remaining()} sur ${dailyLimit()}`);
  const finder = new TopicGapFinder(db, {
    youtube: credentials.getYouTubeClient(),
    aiText: new AITextService(credentials.credentials || {}),
    budget,
    logger: { info() {}, warn: message => console.warn(message) }
  });
  const { gaps } = await finder.refresh(strategy, { limit });
  print(gaps);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
