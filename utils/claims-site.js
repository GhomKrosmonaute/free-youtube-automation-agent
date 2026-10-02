// The public verification site: one page per published video (the verified facts with their sources, how it was
// reviewed, its corrections; in react mode, the claim it examines and its verdict), one per technique of the react
// profile, the errata, the method, and the same data as open JSON (CC BY 4.0). Static HTML with relative links, built from the database and
// pushed to a GitHub Pages repository (deploySite). Only the fields picked below are published: never a reviewer's
// name, the planner's notes, a local path or anything from the review studio.
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { execFile } = require('child_process');
const { techniques, getTechnique } = require('./techniques');
const { isAutomaticDecision, confidenceThreshold } = require('./expert-review-service');
const siteFeeds = require('./site-feeds');
const { isReactMode } = require('./content-mode');
const { verdicts, reactProfile } = require('./react-profile');

// The site's wording that depends on the channel's role (react profile `site`).
function siteText() {
  const site = reactProfile().site || {};
  return {
    techniquesTitle: site.techniquesTitle || 'Techniques',
    techniquesIntro: site.techniquesIntro || 'Les techniques que la chaîne enseigne, et les vidéos où elles apparaissent.',
    reactsTo: site.reactsTo || 'une vidéo'
  };
}

// The labels of the react profile's verdicts ({} without a verdict scale).
function verdictLabels() {
  return Object.fromEntries(Object.entries(verdicts() || {}).map(([id, verdict]) => [id, verdict.label || id]));
}
// Everything the build writes at the root of the site folder; the rest (.git, README, CNAME) is left alone.
const GENERATED = ['index.html', '404.html', 'style.css', '.nojekyll', 'v', 'techniques', 'chaines', 'errata', 'methode', 'confidentialite', 'data', 'api', 'feed.xml', 'corrections.xml'];

function baseUrl() {
  return String(process.env.SITE_BASE_URL || '').trim().replace(/\/+$/, '');
}

// The GitHub repository the site is pushed to (owner/name), also where errors are reported. No default: without it
// the site is only built locally.
function siteRepo() {
  return String(process.env.SITE_REPO || '').trim();
}

// A link to report an error (a new issue on the site's repository), or the plain text without a repository.
function issueLink(text, title = '') {
  if (!siteRepo()) return escape(text);
  const url = `https://github.com/${siteRepo()}/issues/new${title ? `?title=${encodeURIComponent(title)}` : ''}`;
  return `<a href="${escape(url)}" rel="noopener">${escape(text)}</a>`;
}

function slugify(value, max = 50) {
  const slug = String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-[^-]*$/, match => (slug.length > max ? '' : match)).replace(/-+$/, '');
}

// Stable address of a video's page: its subject's first clause, plus 4 characters of its production id so two videos on
// close subjects never share one.
function siteSlug(topic, productionId) {
  const clause = String(topic || '').split(/[?:!.]/)[0];
  const hash = crypto.createHash('sha1').update(String(productionId || '')).digest('hex').slice(0, 4);
  return `${slugify(clause) || 'video'}-${hash}`;
}

// The line a video's description carries (null when the site is not configured).
function siteLink(bundle = {}) {
  const base = baseUrl();
  if (!base || !bundle.id) return null;
  const slug = bundle.seo?.siteSlug || siteSlug(bundle.strategy?.topic || bundle.script?.title, bundle.id);
  const url = `${base}/v/${slug}/`;
  const label = (process.env.CONTENT_LANGUAGE || 'fr') === 'fr' ? 'Vérifications, sources et corrections' : 'Fact-checks, sources and corrections';
  return { slug, url, line: `🔎 ${label} : ${url}` };
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const httpUrl = value => /^https?:\/\/[^\s"'<>]+$/i.test(String(value || '')) ? String(value) : null;
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value || null; } catch (_error) { return null; } };
const day = value => {
  const date = new Date(String(value || '').replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// How the script was reviewed, said honestly: a human approval, an automatic one, or no review needed.
function reviewOf(expert = {}) {
  const approximations = (expert.approximations || []).filter(item => item?.excerpt)
    .map(item => ({ excerpt: String(item.excerpt), note: String(item.note || '') }));
  if (expert.required && expert.status === 'approved') {
    const human = expert.humanReviewed ?? !isAutomaticDecision(expert.reviewer);
    return { kind: human ? 'human' : 'automatic', domain: expert.domain || null, approximations };
  }
  if (expert.status === 'auto_validated') {
    return { kind: 'confidence', domain: expert.domain || null, threshold: expert.confidenceThreshold ?? null, passages: (expert.autoValidated || []).length, approximations };
  }
  return { kind: 'not_required', approximations };
}

// The published videos with only the fields the site shows.
async function collectVideos(db) {
  const rows = await db.getAllRows(
    "SELECT * FROM publish_schedule WHERE status = 'published' AND youtube_id IS NOT NULL ORDER BY COALESCE(published_at, publish_time) DESC"
  );
  const corrections = await db.listCorrections();
  const videos = [];
  for (const row of rows) {
    const metadata = parse(row.metadata) || {};
    // A Short cut out of a video has no page of its own; a Short that stands alone (a reaction) has one.
    if (metadata.shortClipId || metadata.privacyStatus !== 'public') continue;
    const bundle = await db.getProductionBundle(row.production_id);
    // A series joined into one video repeats its parts, which have their pages.
    if (!bundle || bundle.strategy?.seriesOf) continue;
    const strategy = bundle.strategy || {};
    const script = bundle.script || {};
    const provenance = await db.getContentProvenance(row.production_id).catch(() => null);
    const sources = new Map((provenance?.sources || [])
      .filter(source => source.status === 'verified' && httpUrl(source.url))
      .map(source => [source.id, { title: String(source.title || source.url), publisher: String(source.publisher || ''), url: source.url }]));
    const facts = (provenance?.claims || [])
      .filter(claim => ['supported', 'waived'].includes(claim.status))
      .map(claim => ({
        text: String(claim.text || ''),
        status: claim.status,
        note: claim.status === 'waived' ? String(claim.notes || '').slice(0, 600) : '',
        sources: (claim.sourceIds || []).map(id => sources.get(id)).filter(Boolean)
      }));
    const technique = getTechnique(strategy.technique);
    const claim = script.examinedClaim && !technique ? script.examinedClaim : null;
    videos.push({
      slug: bundle.seo?.siteSlug || siteSlug(strategy.topic || script.title, row.production_id),
      productionId: row.production_id,
      youtubeId: row.youtube_id,
      youtubeUrl: httpUrl(row.youtube_url) || `https://www.youtube.com/watch?v=${encodeURIComponent(row.youtube_id)}`,
      title: String(metadata.seo?.title || script.title || row.title || ''),
      publishedAt: row.published_at || row.publish_time || null,
      pillar: strategy.contentPillar || null,
      technique: technique ? technique.id : null,
      examinedClaim: claim ? {
        statement: String(claim.statement || ''),
        verdict: verdictLabels()[claim.verdict] ? claim.verdict : null,
        summary: String(claim.summary || ''),
        techniques: (claim.techniques || []).filter(id => getTechnique(id))
      } : null,
      facts,
      // React mode: the video answered, as the answer names and quotes it.
      examinedVideo: strategy.examinedVideo && httpUrl(strategy.examinedVideo.url) ? {
        title: String(strategy.examinedVideo.title || ''),
        channel: String(strategy.examinedVideo.channel || ''),
        channelId: /^UC[\w-]{22}$/.test(strategy.examinedVideo.channelId || '') ? strategy.examinedVideo.channelId : null,
        url: strategy.examinedVideo.url,
        passages: (strategy.examinedVideo.passages || []).map(passage => ({
          text: String(passage.text || ''),
          ...(/^\d{1,2}(:\d{2}){1,2}$/.test(passage.timestamp || '') ? { timestamp: passage.timestamp } : {})
        }))
      } : null,
      review: reviewOf(script.expertReview || {}),
      corrections: corrections.filter(item => item.productionId === row.production_id)
        .map(item => ({ text: String(item.text), date: item.createdAt }))
    });
  }
  return videos;
}

const STYLE = `:root{--bg:#fbfaf7;--fg:#1c1b19;--muted:#6b675f;--line:#e4e0d8;--card:#fff;--accent:#8a1c1c;--ok:#2f6b3a}
@media (prefers-color-scheme:dark){:root{--bg:#141312;--fg:#ecebe7;--muted:#a19c92;--line:#2c2a27;--card:#1c1b19;--accent:#e07a6a;--ok:#7fbf8a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}
main,header,footer{max-width:820px;margin:0 auto;padding:0 16px}header{padding-top:28px}header a{color:var(--fg);text-decoration:none;font-weight:700}
nav{display:flex;gap:16px;flex-wrap:wrap;margin:6px 0 24px;font-size:15px}nav a{color:var(--muted)}a{color:var(--accent)}
h1{font-size:1.7rem;line-height:1.25;margin:.4em 0}h2{font-size:1.2rem;margin-top:2em}.meta{color:var(--muted);font-size:15px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.badge{display:inline-block;border-radius:999px;padding:1px 10px;font-size:13px;font-weight:600;border:1px solid currentColor;color:var(--accent)}
.badge.holds{color:var(--ok)}.chip{display:inline-block;font-size:13px;padding:1px 8px;margin:2px 4px 2px 0;border-radius:6px;background:var(--line);color:var(--fg);text-decoration:none}
ul.facts{padding-left:1.2em}ul.facts li{margin:.6em 0}.sources{font-size:14px;color:var(--muted)}input,select{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg);max-width:100%}
.filters{display:flex;gap:8px;flex-wrap:wrap}footer{color:var(--muted);font-size:14px;padding:32px 16px}`;

// The channel's name, as its profile records it, and whether the RSS feeds and the JSON API are published (set at
// build time).
let channel = '';
let feeds = { api: false, rss: false };

function layout({ title, body, depth = 0, description = '' }) {
  const up = '../'.repeat(depth);
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>${description ? `<meta name="description" content="${escape(description)}">` : ''}
<link rel="stylesheet" href="${up}style.css">${feeds.rss ? `
<link rel="alternate" type="application/rss+xml" title="${escape(channel ? `${channel} · vérifications` : 'Vérifications')}" href="${up}feed.xml">` : ''}</head><body>
<header><a href="${up}index.html">${escape(channel ? `${channel} · vérifications` : 'Vérifications')}</a>
<nav><a href="${up}index.html">Vidéos</a>${isReactMode() ? `<a href="${up}chaines/index.html">Chaînes examinées</a><a href="${up}techniques/index.html">Techniques</a>` : ''}<a href="${up}errata/index.html">Corrections</a><a href="${up}methode/index.html">Méthode</a><a href="${up}${feeds.api ? 'api/index.html' : 'data/claims.json'}">Données</a>${feeds.rss ? `<a href="${up}feed.xml">RSS</a>` : ''}</nav></header>
<main>${body}</main>
<footer>Chaîne entièrement générée par IA, vérifiée par recherche web et, sur les sujets spécialisés, par relecture. Contenu sous licence CC BY 4.0. ${siteRepo() ? `${issueLink('Signaler une erreur')} · ` : ''}<a href="${up}confidentialite/index.html">Confidentialité</a>.</footer>
</body></html>
`;
}

const verdictBadge = verdict => (verdict
  ? `<span class="badge${verdicts()?.[verdict]?.holds ? ' holds' : ''}">${escape(verdictLabels()[verdict] || verdict)}</span>`
  : '');
const techniqueChip = (id, up) => {
  const technique = getTechnique(id);
  return technique ? `<a class="chip" href="${up}techniques/${technique.id}/index.html">${escape(technique.name)}</a>` : '';
};

function reviewHtml(review) {
  const domain = review.domain ? ` (${escape(review.domain)})` : '';
  const sentence = {
    human: `Sujet spécialisé${domain} : le script a été relu et validé par un humain avant l'enregistrement.`,
    automatic: `Sujet spécialisé${domain} : le script a été validé automatiquement, sans relecture humaine.`,
    confidence: `Sujet spécialisé${domain} : chaque passage spécialisé a été jugé fiable au-delà du seuil de confiance${review.threshold ? ` (${escape(String(review.threshold).replace('.', ','))}/10)` : ''}, sans relecture humaine.`,
    not_required: 'Sujet hors des domaines scientifiques spécialisés : pas de relecture experte, les faits sont vérifiés par recherche web.'
  }[review.kind];
  const approximations = review.approximations.length
    ? `<p>Approximations assumées (ordres de grandeur sans enjeu de santé) :</p><ul>${review.approximations.map(item => `<li>« ${escape(item.excerpt)} »${item.note ? ` — ${escape(item.note)}` : ''}</li>`).join('')}</ul>`
    : '';
  return `<p>${sentence}</p>${approximations}`;
}

function videoPage(video) {
  const up = '../../';
  const technique = getTechnique(video.technique);
  const claim = video.examinedClaim;
  const subject = technique
    ? `<div class="card"><p class="meta">Technique enseignée</p><h2 style="margin-top:0">${escape(technique.name)}</h2><p>${escape(technique.definition)}</p><p>Comment la repérer :</p><ul>${technique.signs.map(sign => `<li>${escape(sign)}</li>`).join('')}</ul><p><a href="${up}techniques/${technique.id}/index.html">Toutes les vidéos sur cette technique</a></p></div>`
    : claim
      ? `<div class="card"><p class="meta">Affirmation examinée</p><p><strong>« ${escape(claim.statement)} »</strong></p><p>${verdictBadge(claim.verdict)}</p>${claim.summary ? `<p>${escape(claim.summary)}</p>` : ''}${claim.techniques.length ? `<p class="meta">Techniques en jeu : ${claim.techniques.map(id => techniqueChip(id, up)).join('')}</p>` : ''}</div>`
      : '';
  const facts = video.facts.length
    ? `<ul class="facts">${video.facts.map(fact => `<li>${escape(fact.text)}${fact.status === 'waived' ? ` <span class="meta">(imprécision mineure : ${escape(fact.note)})</span>` : ''}${fact.sources.length ? `<div class="sources">${fact.sources.map(source => `<a href="${escape(source.url)}" rel="noopener">${escape(source.title)}</a>${source.publisher ? ` (${escape(source.publisher)})` : ''}`).join(' · ')}</div>` : ''}</li>`).join('')}</ul>`
    : '<p>Aucune affirmation factuelle déclarée pour cette vidéo.</p>';
  const corrections = video.corrections.length
    ? `<ul>${video.corrections.map(item => `<li><span class="meta">${escape(day(item.date))}</span> — ${escape(item.text)}</li>`).join('')}</ul>`
    : '<p>Aucune correction à ce jour.</p>';
  const examined = video.examinedVideo;
  const seconds = timestamp => String(timestamp).split(':').reduce((total, part) => total * 60 + Number(part), 0);
  const examinedHtml = examined
    ? `<div class="card"><p class="meta">Vidéo examinée</p><p><a href="${escape(examined.url)}" rel="noopener"><strong>${escape(examined.title)}</strong></a>${examined.channel ? ` · ${examined.channelId ? `<a href="../../chaines/${escape(channelSlug(examined))}/index.html">${escape(examined.channel)}</a>` : escape(examined.channel)}` : ''}</p>${examined.passages.length ? `<p>Passages cités :</p><ul>${examined.passages.map(passage => `<li>${passage.timestamp ? `<a href="${escape(`${examined.url}&t=${seconds(passage.timestamp)}s`)}" rel="noopener">${escape(passage.timestamp)}</a> ` : ''}« ${escape(passage.text)} »</li>`).join('')}</ul>` : ''}<p class="meta">La réponse examine les affirmations, pas les personnes.</p></div>`
    : '';
  return layout({
    depth: 2,
    title: `${video.title} · vérifications`,
    description: claim ? `${claim.verdict ? `${verdictLabels()[claim.verdict]} : ` : ''}${claim.statement}` : technique ? technique.definition : video.title,
    body: `<h1>${escape(video.title)}</h1>
<p class="meta">Publiée le ${escape(day(video.publishedAt))}${video.pillar ? ` · ${escape(video.pillar)}` : ''} · <a href="${escape(video.youtubeUrl)}" rel="noopener">Voir la vidéo</a></p>
${examinedHtml}${subject}
<h2>Faits vérifiés (${video.facts.length})</h2>${facts}
<h2>Relecture</h2>${reviewHtml(video.review)}
<h2>Corrections</h2>${corrections}
${siteRepo() ? `<p>${issueLink('Signaler une erreur sur cette vidéo', `Erreur : ${video.title}`)}</p>` : ''}`
  });
}

function indexPage(videos) {
  const used = techniques().filter(technique => videos.some(video => video.technique === technique.id || video.examinedClaim?.techniques.includes(technique.id)));
  const cards = videos.map(video => {
    const techniques = video.technique ? [video.technique] : video.examinedClaim?.techniques || [];
    const search = [video.title, video.examinedClaim?.statement, video.pillar].filter(Boolean).join(' ').toLowerCase();
    return `<div class="card" data-search="${escape(search)}" data-techniques="${escape(techniques.join(' '))}">
<a href="v/${escape(video.slug)}/index.html"><strong>${escape(video.title)}</strong></a>
<p class="meta">${escape(day(video.publishedAt))}${video.pillar ? ` · ${escape(video.pillar)}` : ''}</p>
${video.examinedClaim ? `<p>« ${escape(video.examinedClaim.statement)} » ${verdictBadge(video.examinedClaim.verdict)}</p>` : ''}${video.technique ? '<p class="meta">Vidéo sur une technique</p>' : ''}
<p>${techniques.map(id => techniqueChip(id, '')).join('')}</p></div>`;
  }).join('\n');
  return layout({
    title: channel ? `${channel} · vérifications` : 'Vérifications',
    description: verdicts()
      ? `Chaque affirmation examinée par la chaîne${channel ? ` ${channel}` : ''}, son verdict, ses sources et ses corrections.`
      : `Les vidéos de la chaîne${channel ? ` ${channel}` : ''}, leurs sources et leurs corrections.`,
    body: `<h1>Ce que chaque vidéo affirme, et sur quoi</h1>
<p>Pour chaque vidéo de la chaîne : ${verdicts() ? 'l\'affirmation examinée et son verdict, ' : ''}les faits vérifiés avec leurs sources, la relecture et les corrections. ${videos.length} vidéo${videos.length > 1 ? 's' : ''}.</p>
<div class="filters"><input id="q" type="search" placeholder="Chercher une affirmation" aria-label="Chercher"><select id="t" aria-label="Technique"><option value="">Toutes les techniques</option>${used.map(technique => `<option value="${technique.id}">${escape(technique.name)}</option>`).join('')}</select></div>
<div id="list">${cards}</div>
<script>
const q=document.getElementById('q'),t=document.getElementById('t');
function f(){const s=q.value.toLowerCase().trim(),k=t.value;for(const c of document.querySelectorAll('#list .card')){c.hidden=(s&&!c.dataset.search.includes(s))||(k&&!c.dataset.techniques.split(' ').includes(k));}}
q.addEventListener('input',f);t.addEventListener('change',f);
</script>`
  });
}

function techniquePages(videos) {
  const pages = {};
  pages['techniques/index.html'] = layout({
    depth: 1,
    title: `${siteText().techniquesTitle}${channel ? ` · ${channel}` : ''}`,
    body: `<h1>${escape(siteText().techniquesTitle)}</h1><p>${escape(siteText().techniquesIntro)}</p>
${techniques().map(technique => `<div class="card"><a href="${technique.id}/index.html"><strong>${escape(technique.name)}</strong></a><p>${escape(technique.definition)}</p></div>`).join('\n')}`
  });
  for (const technique of techniques()) {
    const taught = videos.filter(video => video.technique === technique.id);
    const examples = videos.filter(video => video.examinedClaim?.techniques.includes(technique.id));
    const list = items => `<ul>${items.map(video => `<li><a href="../../v/${escape(video.slug)}/index.html">${escape(video.title)}</a>${video.examinedClaim ? ` ${verdictBadge(video.examinedClaim.verdict)}` : ''}</li>`).join('')}</ul>`;
    pages[`techniques/${technique.id}/index.html`] = layout({
      depth: 2,
      title: `${technique.name}${channel ? ` · ${channel}` : ''}`,
      description: technique.definition,
      body: `<h1>${escape(technique.name)}</h1><p>${escape(technique.definition)}</p>
<h2>Comment la repérer</h2><ul>${technique.signs.map(sign => `<li>${escape(sign)}</li>`).join('')}</ul>
${taught.length ? `<h2>Vidéos sur cette technique</h2>${list(taught)}` : ''}
<h2>Affirmations qui s'appuient dessus</h2>${examples.length ? list(examples) : '<p>Aucune pour l\'instant.</p>'}`
    });
  }
  return pages;
}

const channelSlug = examined => `${slugify(examined.channel) || 'chaine'}-${crypto.createHash('sha1').update(examined.channelId).digest('hex').slice(0, 4)}`;

// The channels whose videos the channel has answered (react mode), each with its answers and the verdicts they reached. Only
// published answers and public figures (name, link, subscribers): nothing of the internal watch list (categories,
// reasons, scores), and no channel that has not been answered.
async function collectChannels(db, videos) {
  const channels = new Map();
  for (const video of videos) {
    const examined = video.examinedVideo;
    if (!examined?.channelId) continue;
    if (!channels.has(examined.channelId)) {
      const watched = await db.getWatchedChannel?.(examined.channelId).catch(() => null);
      channels.set(examined.channelId, {
        slug: channelSlug(examined),
        name: examined.channel || watched?.title || examined.channelId,
        url: `https://www.youtube.com/channel/${examined.channelId}`,
        subscribers: Number.isFinite(watched?.subscribers) ? watched.subscribers : null,
        answers: []
      });
    }
    channels.get(examined.channelId).answers.push({
      slug: video.slug, title: video.title, examinedTitle: examined.title, examinedUrl: examined.url,
      verdict: video.examinedClaim?.verdict || null, publishedAt: video.publishedAt
    });
  }
  return [...channels.values()].sort((a, b) => b.answers.length - a.answers.length || a.name.localeCompare(b.name));
}

const tally = answers => Object.entries(answers.reduce((counts, answer) => {
  if (answer.verdict) counts[answer.verdict] = (counts[answer.verdict] || 0) + 1;
  return counts;
}, {})).map(([verdict, count]) => `${count} ${String(verdictLabels()[verdict] || verdict).toLowerCase()}`).join(', ');

function channelPages(channels) {
  const pages = {};
  const subscribers = channel => (channel.subscribers === null ? '' : ` · ${channel.subscribers.toLocaleString('fr-FR')} abonnés`);
  pages['chaines/index.html'] = layout({
    depth: 1,
    title: `Chaînes examinées${channel ? ` · ${channel}` : ''}`,
    body: `<h1>Chaînes examinées</h1><p>Les chaînes dont ${escape(channel || 'la chaîne')} a examiné des vidéos, avec les réponses publiées et leurs verdicts. Ce sont des affirmations qui sont examinées, pas des personnes jugées.</p>
${channels.length ? channels.map(item => `<div class="card"><a href="${escape(item.slug)}/index.html"><strong>${escape(item.name)}</strong></a><p class="meta">${item.answers.length} vidéo${item.answers.length > 1 ? 's' : ''} examinée${item.answers.length > 1 ? 's' : ''}${subscribers(item)}</p>${tally(item.answers) ? `<p>${escape(tally(item.answers))}</p>` : ''}</div>`).join('\n') : '<p>Aucune chaîne examinée pour l\'instant.</p>'}`
  });
  for (const item of channels) {
    pages[`chaines/${item.slug}/index.html`] = layout({
      depth: 2,
      title: `${item.name}${channel ? ` · ${channel}` : ''}`,
      body: `<h1>${escape(item.name)}</h1>
<p class="meta"><a href="${escape(item.url)}" rel="noopener">Voir la chaîne</a>${subscribers(item)}</p>
<p>${item.answers.length} vidéo${item.answers.length > 1 ? 's' : ''} de cette chaîne examinée${item.answers.length > 1 ? 's' : ''}${tally(item.answers) ? ` : ${escape(tally(item.answers))}` : ''}. Chaque réponse cite la vidéo d'origine mot pour mot ; elle examine des affirmations, pas la personne.</p>
<ul>${item.answers.map(answer => `<li><a href="../../v/${escape(answer.slug)}/index.html">${escape(answer.title)}</a>${answer.verdict ? ` ${verdictBadge(answer.verdict)}` : ''}<div class="sources">En réponse à <a href="${escape(answer.examinedUrl)}" rel="noopener">« ${escape(answer.examinedTitle)} »</a> · ${escape(day(answer.publishedAt))}</div></li>`).join('')}</ul>`
    });
  }
  return pages;
}

function errataPage(videos) {
  const items = videos.flatMap(video => video.corrections.map(item => ({ ...item, video })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return layout({
    depth: 1,
    title: `Corrections${channel ? ` · ${channel}` : ''}`,
    body: `<h1>Corrections</h1><p>Les erreurs relevées après publication. Les vidéos publiées ne sont pas modifiées : la correction figure ici et sur la page de la vidéo.</p>
${items.length ? `<ul>${items.map(item => `<li><span class="meta">${escape(day(item.date))}</span> — <a href="../v/${escape(item.video.slug)}/index.html">${escape(item.video.title)}</a> : ${escape(item.text)}</li>`).join('')}</ul>` : '<p>Aucune correction à ce jour.</p>'}`
  });
}

function methodPage() {
  const threshold = String(confidenceThreshold()).replace('.', ',');
  return layout({
    depth: 1,
    title: `Méthode${channel ? ` · ${channel}` : ''}`,
    body: `<h1>Méthode</h1>
<p>${escape(channel || 'Cette chaîne')} est une chaîne entièrement générée par intelligence artificielle : sujets, scripts, voix et images. Cette page dit comment ses affirmations sont vérifiées, et ce que cette vérification ne garantit pas.</p>
<h2>Vérification des faits</h2><p>Chaque affirmation factuelle d'un script (date, nom, citation, chiffre, résultat d'étude) est vérifiée par recherche web avant publication. Une vidéo dont une affirmation n'a pas pu être vérifiée n'est pas publiée. Les sources retenues figurent sur la page de chaque vidéo.</p>
<h2>Sujets spécialisés</h2><p>Quand un script explique les mécanismes d'un domaine spécialisé (médecine, pharmacologie, physique, biologie...), chaque passage concerné reçoit une note de confiance sur 10. Au-dessus de ${threshold}, il est validé automatiquement ; en dessous, la vidéo attend une relecture humaine. La page de chaque vidéo indique laquelle de ces voies a été suivie.</p>
${isReactMode() ? `<h2>Réponses rapides</h2><p>Quand une chaîne suivie publie ${escape(siteText().reactsTo)}, une réponse courte est produite dans l'heure. Elle nomme la vidéo examinée, la cite mot pour mot, en texte, et la lie. ${String(process.env.REACTIVE_APPROVAL || 'jev').trim().toLowerCase() === 'jev'
    ? 'Elle est publiée sans relecture humaine, seulement si des contrôles automatiques passent : chaque fait vérifié par recherche web, chaque citation jugée fidèle à la vidéo d\'origine, aucune phrase qui attaque une personne ou un groupe plutôt qu\'une affirmation. Sinon, elle attend une relecture humaine.'
    : 'Elle est relue par un humain avant d\'être publiée.'} Elle répond à ce que dit la vidéo, jamais à la personne.</p>` : ''}
<h2>Approximations assumées</h2><p>Un ordre de grandeur sans enjeu de santé, dont l'argument ne dépend pas, est signalé comme approximation plutôt que vérifié au chiffre près.</p>
<h2>Corrections</h2><p>Les erreurs relevées après publication sont listées sur la page <a href="../errata/index.html">Corrections</a> et sur celle de la vidéo. ${siteRepo() ? `Pour en signaler une, ${issueLink('ouvre un ticket')}.` : ''}</p>
<h2>Données</h2><p>Toutes ces informations sont disponibles en <a href="../data/claims.json">JSON</a>, sous licence CC BY 4.0 : réutilise-les librement en citant la source.</p>`
  });
}

// The privacy policy of the publishing tool, which Google asks of an OAuth app: it only acts on the channel's own
// account, from the operator's computer.
function privacyPage() {
  const name = channel || 'la chaîne';
  return layout({
    depth: 1,
    title: `Confidentialité${channel ? ` · ${channel}` : ''}`,
    body: `<h1>Politique de confidentialité</h1>
<p>L'outil de publication de ${escape(name)} est une application privée, utilisée uniquement par l'opérateur de la chaîne pour gérer son propre compte YouTube. Il ne s'adresse à aucun autre utilisateur.</p>
<h2>Données Google utilisées</h2><p>Avec l'autorisation du titulaire du compte, l'outil accède à la chaîne YouTube de ${escape(name)} pour publier ses vidéos et leurs miniatures, lire les statistiques de ses propres vidéos (YouTube Analytics) et lire ou répondre aux commentaires publics laissés sous ses propres vidéos. Il n'accède à aucune donnée d'un autre compte Google.</p>
<h2>Conservation</h2><p>Ces données sont conservées uniquement sur l'ordinateur de l'opérateur. Elles ne sont ni vendues, ni louées, ni transmises à des tiers, ni utilisées à des fins publicitaires. Les seules informations publiées sont celles de ce site : ce que disent les vidéos, leurs sources et leurs corrections.</p>
<h2>Usage limité</h2><p>L'utilisation des données reçues des API Google respecte la politique relative aux données utilisateur des services d'API Google, y compris les exigences d'usage limité.</p>
<h2>Révocation et contact</h2><p>L'accès peut être retiré à tout moment depuis les paramètres de sécurité du compte Google (myaccount.google.com/permissions). ${siteRepo() ? `Pour toute question, ${issueLink('ouvre un ticket')}.` : ''}</p>`
  });
}

function notFoundPage() {
  const base = baseUrl();
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page introuvable${channel ? ` · ${escape(channel)}` : ''}</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 16px;background:#fbfaf7;color:#1c1b19}@media (prefers-color-scheme:dark){body{background:#141312;color:#ecebe7}}</style></head>
<body><h1>Page introuvable</h1><p><a href="${escape(base ? `${base}/index.html` : '/')}">Retour aux vérifications</a></p></body></html>
`;
}

// Every file of the site, keyed by its path in the site folder.
async function buildSite(db) {
  channel = String((await db.getChannelProfile?.().catch(() => null))?.channel_name || process.env.CHANNEL_NAME || '').trim();
  // RSS needs absolute links: no feed without SITE_BASE_URL.
  feeds = { api: siteFeeds.enabled(), rss: siteFeeds.enabled() && Boolean(baseUrl()) };
  const videos = await collectVideos(db);
  const channels = await collectChannels(db, videos);
  const open = {
    generatedAt: new Date().toISOString(),
    license: 'CC BY 4.0',
    source: baseUrl() || null,
    videos: videos.map(({ productionId: _productionId, ...video }) => video),
    channels,
    techniques: techniques().map(({ id, name, definition, signs }) => ({ id, name, definition, signs }))
  };
  return {
    files: {
      'index.html': indexPage(videos),
      '404.html': notFoundPage(),
      'style.css': STYLE,
      '.nojekyll': '',
      'errata/index.html': errataPage(videos),
      'methode/index.html': methodPage(),
      'confidentialite/index.html': privacyPage(),
      'data/claims.json': `${JSON.stringify(open, null, 2)}\n`,
      ...(isReactMode() ? { ...techniquePages(videos), ...channelPages(channels) } : {}),
      ...Object.fromEntries(videos.map(video => [`v/${video.slug}/index.html`, videoPage(video)])),
      ...(feeds.api ? {
        ...siteFeeds.jsonApi({ videos, channels, base: baseUrl() }),
        'api/index.html': layout({ depth: 1, title: `Données ouvertes${channel ? ` · ${channel}` : ''}`, body: siteFeeds.apiDocs({ base: baseUrl(), hasFeeds: feeds.rss }) })
      } : {}),
      ...(feeds.rss ? siteFeeds.rssFeeds({ videos, base: baseUrl(), channel, verdictLabels: verdictLabels() }) : {})
    },
    videos
  };
}

async function writeSite(directory, files) {
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(GENERATED.map(entry => fs.rm(path.join(directory, entry), { recursive: true, force: true })));
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(directory, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

const git = (cwd, args) => new Promise((resolve, reject) => {
  execFile('git', args, { cwd, timeout: 120000 }, (error, stdout, stderr) => (error ? reject(new Error(`git ${args[0]}: ${String(stderr || error.message).trim().slice(0, 300)}`)) : resolve(String(stdout).trim())));
});

let deploying = null;

// Builds the site into its clone of the public repository, then commits and pushes when something changed. One
// deployment at a time in this process; a lock file keeps a CLI run and the server from overlapping.
function deploySite(db, { directory = process.env.SITE_DIR || path.join(__dirname, '..', 'data', 'site'), push = true, logger = null, runGit = git } = {}) {
  if (deploying) return deploying;
  deploying = (async () => {
    const lock = `${directory}.lock`;
    let handle;
    try {
      handle = await fs.open(lock, 'wx');
    } catch (_error) {
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs < 10 * 60 * 1000) return { deployed: false, reason: 'another deployment is running' };
      await fs.rm(lock, { force: true });
      handle = await fs.open(lock, 'wx');
    }
    try {
      if (push && !(await fs.stat(path.join(directory, '.git')).catch(() => null))) {
        if (!siteRepo()) return { deployed: false, reason: 'SITE_REPO is not set (owner/name of the GitHub Pages repository)' };
        await fs.mkdir(path.dirname(directory), { recursive: true });
        await runGit(path.dirname(directory), ['clone', `https://github.com/${siteRepo()}.git`, directory]);
      }
      const { files, videos } = await buildSite(db);
      await writeSite(directory, files);
      if (!push) return { deployed: false, built: true, directory, pages: Object.keys(files).length, videos: videos.length };
      await runGit(directory, ['add', '-A']);
      if (!(await runGit(directory, ['status', '--porcelain']))) return { deployed: false, reason: 'no change', videos: videos.length };
      await runGit(directory, ['commit', '-m', `Mise à jour des vérifications (${videos.length} vidéos)`]);
      await runGit(directory, ['push', 'origin', 'HEAD']);
      logger?.info?.(`Verification site deployed (${videos.length} videos)`);
      return { deployed: true, videos: videos.length };
    } finally {
      await handle.close();
      await fs.rm(lock, { force: true });
    }
  })().finally(() => { deploying = null; });
  return deploying;
}

module.exports = { buildSite, writeSite, deploySite, collectVideos, siteSlug, siteLink, baseUrl, verdictLabels };
