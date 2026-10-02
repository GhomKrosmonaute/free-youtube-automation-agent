#!/usr/bin/env node
// Expert review of scripts on highly specialised subjects, from the terminal (the server must be running).
//   npm run expert                                   pending reviews
//   npm run expert -- show [id]                      the script to have checked, passages first
//   npm run expert -- approve [id] [--by "Nom"] [--note "..."]
//   npm run expert -- revise [id] "corrections" [--by "Nom"] [--file corrections.txt]
//   npm run expert -- reject [id] ["raison"] [--by "Nom"]
//   npm run expert -- reassess [id] [--jev]          assessed again under the current rules (every pending review without an id);
//                                                    --jev lets Jev's first sort decide again whether the subject is specialised
// Without an id, the only pending review is used.
require('dotenv').config();
const fs = require('fs');
const http = require('http');

const PORT = process.env.PORT || 3456;
const KEY = process.env.API_KEY || '';

function api(pathname, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_error) { /* not JSON */ }
        if (res.statusCode >= 400) return reject(new Error(json?.error || `HTTP ${res.statusCode}`));
        resolve(json);
      });
    });
    req.on('error', () => reject(new Error(`Serveur injoignable sur le port ${PORT} : lance npm run auto (ou npm run server), puis réessaie.`)));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return null;
  const [, value] = args.splice(index, 2);
  return value ?? null;
}

const STATUS = { pending: 'en attente', approved: 'validé', revision_requested: 'corrections demandées', rejected: 'abandonné' };

async function resolveId(positional) {
  if (positional[0]?.startsWith('expert_')) return positional.shift();
  const { result } = await api('/api/expert-reviews?status=pending');
  if (result.length === 1) return result[0].id;
  throw new Error(result.length ? `${result.length} revues en attente : précise l'id (npm run expert pour la liste).` : 'Aucune revue en attente.');
}

async function main() {
  const by = option('by');
  const note = option('note');
  const file = option('file');
  const [command = 'list', ...positional] = args;

  if (command === 'list') {
    const { result } = await api('/api/expert-reviews');
    const pending = result.filter(review => review.status === 'pending');
    if (!pending.length) console.log('Aucune revue experte en attente.');
    for (const review of pending) {
      console.log(`${review.id}  « ${review.title} »  (${review.domain || 'domaine non déterminé'}, révision ${review.revision}, depuis ${review.createdAt})`);
      if (review.assessment?.expertProfile) console.log(`    à faire relire par : ${review.assessment.expertProfile}`);
      if (review.scriptPath) console.log(`    script : ${review.scriptPath}`);
      if (review.notifyError) console.log(`    alerte non envoyée : ${review.notifyError}`);
    }
    const decided = result.filter(review => review.status !== 'pending').slice(0, 5);
    if (decided.length) {
      console.log('\nDernières décisions :');
      for (const review of decided) console.log(`${review.id}  « ${review.title} »  ${STATUS[review.status] || review.status}${review.decidedBy ? ` par ${review.decidedBy}` : ''}`);
    }
    return;
  }

  if (command === 'show') {
    const id = await resolveId(positional);
    const { result } = await api(`/api/expert-reviews/${encodeURIComponent(id)}`);
    console.log(result.markdown);
    return;
  }

  if (command === 'reassess') {
    const triage = args.includes('--jev');
    if (triage) positional.splice(positional.indexOf('--jev'), 1);
    const ids = positional[0]?.startsWith('expert_')
      ? [positional.shift()]
      : (await api('/api/expert-reviews?status=pending')).result.map(review => review.id);
    if (!ids.length) console.log('Aucune revue en attente.');
    for (const id of ids) {
      const { result } = await api(`/api/expert-reviews/${encodeURIComponent(id)}/reassess`, 'POST', { triage });
      const passages = result.review.assessment?.passages || [];
      console.log(result.autoValidated
        ? `${id} : validé automatiquement (${result.review.decisionNotes}). ${result.resumed ? 'La production reprend.' : 'La production reprendra au prochain passage de l\'ordonnanceur.'}`
        : `${id} : ${passages.length} passage${passages.length > 1 ? 's' : ''} sous le seuil de confiance, à faire relire ; ${result.review.notifiedAt ? 'alerte renvoyée' : 'alerte renvoyée au prochain passage de l\'ordonnanceur'}.`);
    }
    return;
  }

  const decisions = { approve: 'approve', revise: 'revise', reject: 'reject' };
  if (!decisions[command]) throw new Error(`Commande inconnue : ${command} (list, show, approve, revise, reject, reassess)`);
  const id = await resolveId(positional);
  const notes = file ? fs.readFileSync(file, 'utf8') : note || positional.join(' ');
  const { result } = await api(`/api/expert-reviews/${encodeURIComponent(id)}/decision`, 'POST', {
    decision: decisions[command], notes, reviewer: by || undefined
  });
  const messages = {
    approve: 'Script validé.',
    revise: 'Corrections enregistrées : le script va être réécrit puis te reviendra pour relecture.',
    reject: 'Vidéo abandonnée.'
  };
  console.log(`${messages[command]} ${result.resumed ? 'La production reprend.' : command === 'reject' ? '' : 'La production reprendra au prochain passage de l\'ordonnanceur (10 min au plus).'}`.trim());
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
