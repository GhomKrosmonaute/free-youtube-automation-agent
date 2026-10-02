#!/usr/bin/env node
// React mode: the watched channels and the reactions (utils/reactive-watch.js, utils/watch-list.js, utils/channel-discovery.js).
//   npm run reactive                              items waiting, being made, or ready for review
//   npm run reactive -- channels                  the watch list (at most 20) and the candidates, with their scores
//   npm run reactive -- watch <channel>           watch a channel now (UC… id, @handle or its address), in place of the
//                                                 weakest automatic one if full
//   npm run reactive -- unwatch <channel>         stop watching it
//   npm run reactive -- transcript <itemId> <file>  passages to quote, from a transcript copied from YouTube
//   npm run reactive -- poll                      look at the watched channels' new videos now
//   npm run reactive -- discover                  search the web for channels to watch now (otherwise every Sunday)
//   npm run reactive -- approve <contentId>       approve and publish now (the server must be running)
//   npm run reactive -- reject <contentId> ["why"]
// Approving attests the factual review and the media rights of the video, as the review studio asks.
require('dotenv').config({ quiet: true });
const http = require('http');
const { Database } = require('../database/db');

const PORT = process.env.PORT || 3456;

function api(pathname, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: { 'x-api-key': process.env.API_KEY || '', 'Content-Type': 'application/json' } }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_error) { /* not JSON */ }
        if (res.statusCode >= 400) {
          const blocking = json?.quality?.blockingFailures || json?.details?.quality?.blockingFailures;
          return reject(new Error(`${json?.error || `HTTP ${res.statusCode}`}${blocking?.length ? ` (contrôles bloquants : ${blocking.join(', ')})` : ''}`));
        }
        resolve(json);
      });
    });
    req.on('error', () => reject(new Error(`Serveur injoignable sur le port ${PORT} : lance npm run auto (ou npm run server), puis réessaie.`)));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const fs = require('fs');

const STATUS = { queued: 'en attente', generating: 'en production', next_part: 'partie suivante à produire', review: 'à valider', published: 'publiée', dismissed: 'écartée', failed: 'échouée', expired: 'expirée' };

async function main() {
  const [command = 'list', reference, ...words] = process.argv.slice(2);
  const db = new Database();
  await db.initialize();

  if (command === 'list') {
    const items = await db.listReactiveItems({ status: ['queued', 'generating', 'next_part', 'review'] });
    if (!items.length) console.log('Aucune vidéo réactive en cours.');
    for (const item of items) {
      // A Short, or a series of Shorts (part 1, part 2...).
      const format = item.parts > 1 ? `série de ${item.parts} Shorts, ${(item.episodes || []).filter(episode => episode.productionId).length} produit(s)` : 'Short';
      console.log(`${item.id}  [${STATUS[item.status] || item.status}]  ${format}  urgence ${item.priority}  « ${item.topic} »${item.productionId ? `  contenu ${item.productionId}` : ''}`);
      console.log(`    affirmation : ${item.claim}${item.technique ? `  (technique : ${item.technique})` : ''}`);
      if (item.video?.url) console.log(`    vidéo examinée : « ${item.video.title} » (${item.video.channel}) ${item.video.url}`);
      for (const passage of item.passages || []) console.log(`      ${passage.timestamp ? `[${passage.timestamp}] ` : ''}« ${passage.text} »`);
    }
    return;
  }
  if (command === 'channels') {
    const { WatchList } = require('../utils/watch-list');
    const watchList = new WatchList(db);
    await watchList.refreshScores();
    const channels = await db.listWatchedChannels({ active: null });
    if (!channels.length) console.log('Aucune chaîne : npm run reactive -- discover en cherche, ou npm run reactive -- watch <channelId>.');
    console.log(`${channels.filter(channel => channel.active).length} chaînes surveillées sur ${watchList.maxChannels()}`);
    for (const channel of channels) {
      const score = channel.score === null ? 'pas encore de score' : `score ${channel.score} %`;
      console.log(`${channel.active ? 'surveillée ' : 'candidate  '} ${channel.channelId}  ${channel.title || ''}  (${channel.origin}${channel.category ? `, ${channel.category}` : ''}, ${score}, ${channel.responses} réponse${channel.responses > 1 ? 's' : ''})${channel.deactivatedReason ? `  — ${channel.deactivatedReason}` : ''}`);
    }
    return;
  }
  if (command === 'watch' || command === 'unwatch') {
    // A UC… id, an @handle, or the channel's address (youtube.com/channel/UC… or youtube.com/@handle).
    const id = String(reference || '').match(/(?:^|\/channel\/)(UC[\w-]{20,})/)?.[1] || null;
    const handle = id ? null : String(reference || '').match(/(?:^|\/)@([\w.-]+)/)?.[1] || null;
    if (!id && !handle) throw new Error(`Usage : npm run reactive -- ${command} <UC… | @pseudo | https://www.youtube.com/@pseudo>`);
    // Its id, name and public subscriber count (1 quota unit); a channel given by its id is watched even if YouTube
    // cannot be reached, one given by its handle needs YouTube to be found.
    let channelId = id;
    let title = null;
    let subscribers = null;
    try {
      const { CredentialManager } = require('../utils/credential-manager');
      const credentials = new CredentialManager();
      await credentials.initialize();
      const { data } = await credentials.getYouTubeClient().channels.list({ part: ['snippet', 'statistics'], ...(id ? { id: [id] } : { forHandle: `@${handle}` }) });
      const channel = data.items?.[0];
      channelId = channel?.id || id;
      title = channel?.snippet?.title || null;
      const count = Number(channel?.statistics?.subscriberCount);
      subscribers = channel?.statistics?.hiddenSubscriberCount || !Number.isFinite(count) ? null : count;
    } catch (error) {
      if (!id) throw new Error(`Chaîne @${handle} introuvable : ${error.message}`);
    }
    if (!channelId) throw new Error(`Chaîne @${handle} introuvable sur YouTube.`);
    if (command === 'unwatch') {
      await db.setWatchedChannelActive(channelId, false, 'retirée à la main');
      console.log(`Chaîne retirée de la surveillance${title ? ` : ${title}` : ''}.`);
      return;
    }
    const { WatchList } = require('../utils/watch-list');
    await db.upsertWatchedChannel({ channelId, title, origin: 'manual', subscribers });
    const result = await new WatchList(db).admit(channelId, { manual: true });
    console.log(result.admitted
      ? `Chaîne surveillée${title ? ` : ${title} (${channelId})` : ''}.${result.evicted ? ` Elle remplace ${result.evicted.title || result.evicted.channelId} (score ${result.evicted.score ?? 'aucun'}).` : ''}`
      : `Chaîne non ajoutée : ${result.reason}.`);
    return;
  }
  if (command === 'transcript') {
    const [file] = words;
    if (!reference || !file) throw new Error('Usage : npm run reactive -- transcript <itemId> <fichier de transcription>');
    const { ReactiveWatch } = require('../utils/reactive-watch');
    const item = await new ReactiveWatch(db).setTranscript(reference, fs.readFileSync(file, 'utf8'));
    console.log(`${item.passages.length} passages retenus :`);
    for (const passage of item.passages) console.log(`  [${passage.timestamp}] « ${passage.text} »`);
    return;
  }
  if (command === 'discover') {
    const { CredentialManager } = require('../utils/credential-manager');
    const { WatchList } = require('../utils/watch-list');
    const { ChannelDiscovery } = require('../utils/channel-discovery');
    const credentials = new CredentialManager();
    await credentials.initialize();
    const discovery = new ChannelDiscovery(db, { youtube: credentials.getYouTubeClient(), watchList: new WatchList(db) });
    const { admitted, skipped } = await discovery.run();
    for (const channel of admitted) console.log(`ajoutée : ${channel.name} (${channel.category})${channel.evicted ? `, à la place de ${channel.evicted}` : ''}`);
    for (const channel of skipped) console.log(`écartée : ${channel.name} — ${channel.why}`);
    if (!admitted.length && !skipped.length) console.log('Aucune nouvelle chaîne trouvée.');
    return;
  }
  if (command === 'poll') {
    const { CredentialManager } = require('../utils/credential-manager');
    const { AITextService } = require('../utils/ai-text-service');
    const { ReactiveWatch } = require('../utils/reactive-watch');
    const credentials = new CredentialManager();
    await credentials.initialize();
    const watch = new ReactiveWatch(db, {
      youtube: credentials.getYouTubeClient(),
      aiText: new AITextService(credentials.credentials || {}),
      logger: { info() {}, warn: message => console.warn(message) }
    });
    const { created } = await watch.poll(await db.getChannelStrategy() || {});
    console.log(created.length ? created.map(item => `En attente : « ${item.topic} »`).join('\n') : 'Aucune vidéo virale à traiter.');
    return;
  }
  if (command === 'approve') {
    if (!reference) throw new Error('Usage : npm run reactive -- approve <contentId>');
    await api(`/api/content/${encodeURIComponent(reference)}/approve`, 'POST', {
      factChecked: true, rightsConfirmed: true, publishTime: new Date().toISOString(), privacyStatus: 'public'
    });
    await api(`/api/content/${encodeURIComponent(reference)}/publish-now`, 'POST', {});
    console.log('Vidéo approuvée : publication en cours.');
    return;
  }
  if (command === 'reject') {
    if (!reference) throw new Error('Usage : npm run reactive -- reject <contentId> ["raison"]');
    await api(`/api/content/${encodeURIComponent(reference)}/reject`, 'POST', { notes: words.join(' ') || 'Vidéo réactive abandonnée' });
    console.log('Vidéo réactive abandonnée.');
    return;
  }
  throw new Error(`Commande inconnue : ${command} (list, channels, watch, unwatch, transcript, poll, discover, approve, reject)`);
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
