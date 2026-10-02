#!/usr/bin/env node
// Where the model quota goes, from data/ai-usage.jsonl (written by every Claude Code and Anthropic call).
//   npm run ai-usage                  the last 7 days, by purpose, by model and per video
//   npm run ai-usage -- --days 30
//   npm run ai-usage -- --all
require('dotenv').config({ quiet: true });
const aiUsage = require('../utils/ai-usage');

const args = process.argv.slice(2);
const daysIndex = args.indexOf('--days');
const days = args.includes('--all') ? null : Math.max(1, Number(daysIndex >= 0 ? args[daysIndex + 1] : 7) || 7);
const since = days ? new Date(Date.now() - days * 86400000).toISOString() : null;

const decimal = (value, digits) => value.toFixed(digits).replace('.', ',');
const tokens = value => (value >= 1e6 ? `${decimal(value / 1e6, 2)} M` : value >= 1e3 ? `${decimal(value / 1e3, 1)} k` : String(value));
const dollars = value => `${decimal(value, 2)} $`;
const duration = ms => {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')}` : `${seconds} s`;
};

function table(rows, columns) {
  const widths = columns.map(([title], index) => Math.max(title.length, ...rows.map(row => String(columns[index][1](row)).length)));
  const line = cells => cells.map((cell, index) => (columns[index][2] === 'left' ? String(cell).padEnd(widths[index]) : String(cell).padStart(widths[index]))).join('  ');
  console.log(line(columns.map(([title]) => title)));
  for (const row of rows) console.log(line(columns.map(([, value]) => value(row))));
}

const entries = aiUsage.read({ since });
if (!entries.length) {
  const file = aiUsage.logPath();
  console.log(file
    ? `Aucun appel mesuré${days ? ` sur les ${days} derniers jours` : ''} (${file}). La mesure commence au prochain appel du serveur, après son redémarrage.`
    : 'La mesure est désactivée (AI_USAGE_LOG=off).');
  process.exit(0);
}

const total = aiUsage.summarize(entries, () => 'total')[0];
console.log(`${days ? `${days} derniers jours` : 'Depuis le début'} : ${total.calls} appels, ${tokens(total.inputTokens + total.outputTokens)} tokens, ${dollars(total.costUsd)} au prix catalogue de l'API`);
console.log('(sur un abonnement claude.ai ce montant n\'est pas facturé : c\'est la mesure de ce que chaque usage prend au quota)\n');

const share = group => (total.costUsd ? `${Math.round((group.costUsd / total.costUsd) * 100)} %` : '-');
table(aiUsage.summarize(entries), [
  ['Usage', group => group.name, 'left'],
  ['Appels', group => group.calls],
  ['Échecs', group => group.failures || ''],
  ['Entrée/appel', group => tokens(Math.round(group.inputTokens / group.calls))],
  ['Sortie', group => tokens(group.outputTokens)],
  ['Recherches', group => group.webSearches || ''],
  ['Coût', group => dollars(group.costUsd)],
  ['Part', share],
  ['Durée moy.', group => duration(group.durationMs / group.calls)]
]);

console.log('');
table(aiUsage.summarize(entries, entry => entry.model || entry.provider), [
  ['Modèle', group => group.name, 'left'],
  ['Appels', group => group.calls],
  ['Coût', group => dollars(group.costUsd)],
  ['Part', share]
]);

const videos = aiUsage.summarize(entries.filter(entry => entry.jobId), entry => entry.jobId);
if (videos.length) {
  const average = videos.reduce((sum, video) => sum + video.costUsd, 0) / videos.length;
  console.log(`\nPar vidéo : ${videos.length} vidéo${videos.length > 1 ? 's' : ''}, ${dollars(average)} en moyenne, au plus ${dollars(videos[0].costUsd)} (${videos[0].name}, ${videos[0].calls} appels)`);
}
