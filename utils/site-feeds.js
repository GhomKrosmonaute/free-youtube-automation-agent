// What the public verification site offers machines, next to its pages (utils/claims-site.js): RSS feeds of the
// verifications and of the corrections, and a static, versioned JSON API. GitHub Pages serves it with
// Access-Control-Allow-Origin: *, an ETag, gzip and a 10-minute cache, so any page or app can read it from a browser.
// Off until SITE_FEEDS=on (the feeds need SITE_BASE_URL for their absolute links). The API is static: no query
// parameters, so lists are paginated and every item has its own file; /api/v1/ never changes shape, a breaking change
// goes to /api/v2/. Only the fields the pages show are published (same whitelist).
const crypto = require('crypto');
const { techniques, getTechnique } = require('./techniques');

const PAGE_SIZE = 50;
const FEED_SIZE = 50;

function enabled() {
  return String(process.env.SITE_FEEDS || '').trim().toLowerCase() === 'on';
}

// Escaped for XML, without the control characters XML 1.0 does not allow (only tab, line feed and carriage return are).
const xml = value => [...String(value ?? '')].filter(char => char >= ' ' || char === '\t' || char === '\n' || char === '\r').join('')
  .replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const rfc822 = value => {
  const date = new Date(String(value || '').replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? new Date(0).toUTCString() : date.toUTCString();
};

function rss({ title, description, base, self, items }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(title)}</title>
<link>${xml(`${base}/`)}</link>
<atom:link href="${xml(`${base}/${self}`)}" rel="self" type="application/rss+xml"/>
<description>${xml(description)}</description>
<language>fr</language>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items.map(item => `<item>
<title>${xml(item.title)}</title>
<link>${xml(item.link)}</link>
<guid isPermaLink="${item.guid ? 'false' : 'true'}">${xml(item.guid || item.link)}</guid>
<pubDate>${rfc822(item.date)}</pubDate>
<description>${xml(item.description)}</description>
${(item.categories || []).map(category => `<category>${xml(category)}</category>`).join('\n')}
</item>`).join('\n')}
</channel>
</rss>
`;
}

// The latest verifications, and the corrections, as RSS 2.0.
function rssFeeds({ videos, base, channel, verdictLabels }) {
  const name = channel ? `${channel} · ` : '';
  const verifications = rss({
    title: `${name}vérifications`,
    description: 'Chaque affirmation examinée, son verdict, ses sources et ses corrections.',
    base,
    self: 'feed.xml',
    items: videos.slice(0, FEED_SIZE).map(video => {
      const claim = video.examinedClaim;
      const technique = getTechnique(video.technique);
      return {
        title: video.title,
        link: `${base}/v/${video.slug}/`,
        date: video.publishedAt,
        description: claim
          ? `${claim.verdict ? `${verdictLabels[claim.verdict]} : ` : ''}« ${claim.statement} ». ${claim.summary || ''}`.trim()
          : technique ? `Technique : ${technique.name}. ${technique.definition}` : video.title,
        categories: [
          ...(claim?.techniques || []).map(id => getTechnique(id)?.name).filter(Boolean),
          ...(technique ? [technique.name] : []),
          ...(video.pillar ? [video.pillar] : [])
        ]
      };
    })
  });
  const corrections = rss({
    title: `${name}corrections`,
    description: 'Les erreurs relevées après publication.',
    base,
    self: 'corrections.xml',
    items: videos.flatMap(video => video.corrections.map(correction => ({
      title: `Correction : ${video.title}`,
      link: `${base}/v/${video.slug}/`,
      guid: `${base}/v/${video.slug}/#correction-${crypto.createHash('sha1').update(`${correction.date}\n${correction.text}`).digest('hex').slice(0, 10)}`,
      date: correction.date,
      description: correction.text
    }))).sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, FEED_SIZE)
  });
  return { 'feed.xml': verifications, 'corrections.xml': corrections };
}

// A video as a list shows it, with where its page and its full record are.
function summaryOf(video) {
  return {
    slug: video.slug,
    title: video.title,
    publishedAt: video.publishedAt,
    pillar: video.pillar,
    verdict: video.examinedClaim?.verdict || null,
    statement: video.examinedClaim?.statement || null,
    // The technique a lesson teaches; the techniques the examined claim relies on.
    technique: video.technique || null,
    techniques: video.examinedClaim?.techniques || [],
    youtubeUrl: video.youtubeUrl,
    page: `v/${video.slug}/`,
    href: `api/v1/videos/${video.slug}.json`
  };
}

// The static JSON API v1, as files keyed by their path in the site folder.
function jsonApi({ videos, channels, base, generatedAt = new Date().toISOString() }) {
  const files = {};
  const write = (path, data) => { files[`api/v1/${path}`] = `${JSON.stringify(data, null, 2)}\n`; };
  const pages = Math.max(1, Math.ceil(videos.length / PAGE_SIZE));
  const corrections = videos.flatMap(video => video.corrections.map(correction => ({ video: video.slug, title: video.title, ...correction })))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  write('index.json', {
    version: 1,
    generatedAt,
    license: 'CC BY 4.0',
    base: base || null,
    counts: { videos: videos.length, channels: channels.length, techniques: techniques().length, corrections: corrections.length },
    endpoints: {
      videos: 'api/v1/videos.json',
      videoPage: 'api/v1/videos/page-{n}.json',
      video: 'api/v1/videos/{slug}.json',
      techniques: 'api/v1/techniques.json',
      technique: 'api/v1/techniques/{id}.json',
      channels: 'api/v1/channels.json',
      channel: 'api/v1/channels/{slug}.json',
      corrections: 'api/v1/corrections.json',
      rss: base ? ['feed.xml', 'corrections.xml'] : []
    },
    docs: 'api/index.html'
  });
  write('videos.json', {
    total: videos.length, pageSize: PAGE_SIZE, pages,
    pageHrefs: Array.from({ length: pages }, (_, index) => `api/v1/videos/page-${index + 1}.json`),
    items: videos.slice(0, PAGE_SIZE).map(summaryOf)
  });
  for (let page = 1; page <= pages; page++) {
    write(`videos/page-${page}.json`, {
      page, pages,
      previous: page > 1 ? `api/v1/videos/page-${page - 1}.json` : null,
      next: page < pages ? `api/v1/videos/page-${page + 1}.json` : null,
      items: videos.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map(summaryOf)
    });
  }
  for (const { productionId: _productionId, ...video } of videos) write(`videos/${video.slug}.json`, { ...video, page: `v/${video.slug}/` });
  write('techniques.json', { items: techniques().map(({ id, name, definition }) => ({ id, name, definition, href: `api/v1/techniques/${id}.json` })) });
  for (const technique of techniques()) {
    write(`techniques/${technique.id}.json`, {
      id: technique.id, name: technique.name, definition: technique.definition, signs: technique.signs, question: technique.question,
      taughtBy: videos.filter(video => video.technique === technique.id).map(summaryOf),
      examples: videos.filter(video => (video.examinedClaim?.techniques || []).includes(technique.id)).map(summaryOf)
    });
  }
  write('channels.json', { items: channels.map(channel => ({ slug: channel.slug, name: channel.name, url: channel.url, subscribers: channel.subscribers, answers: channel.answers.length, href: `api/v1/channels/${channel.slug}.json` })) });
  for (const channel of channels) write(`channels/${channel.slug}.json`, channel);
  write('corrections.json', { items: corrections });
  return files;
}

// What the API offers, for the people who build on it.
function apiDocs({ base, hasFeeds }) {
  const root = base ? `${base}/` : '';
  const endpoint = (path, what) => `<li><code>${path}</code> — ${what}</li>`;
  return `<h1>Données ouvertes</h1>
<p>Toutes les vérifications sont lisibles par programme, sous licence CC BY 4.0 : une API JSON statique, en lecture seule, sans clé ni inscription. Elle est servie avec <code>Access-Control-Allow-Origin: *</code>, donc lisible depuis n'importe quel site, dans le navigateur. Les données sont mises à jour à chaque publication et au plus toutes les dix minutes en cache.</p>
<h2>API JSON (v1)</h2>
<ul>
${endpoint('api/v1/index.json', 'version, date de génération, effectifs et liste des adresses')}
${endpoint('api/v1/videos.json', `les ${PAGE_SIZE} vérifications les plus récentes, avec le nombre de pages`)}
${endpoint('api/v1/videos/page-{n}.json', `les vérifications par pages de ${PAGE_SIZE}, avec les liens précédent et suivant`)}
${endpoint('api/v1/videos/{slug}.json', 'une vérification complète : affirmation, verdict, faits et sources, relecture, corrections')}
${endpoint('api/v1/techniques.json', 'les techniques')}
${endpoint('api/v1/techniques/{id}.json', 'une technique, les vidéos qui l\'enseignent et celles qui en montrent un exemple')}
${endpoint('api/v1/channels.json', 'les chaînes examinées')}
${endpoint('api/v1/channels/{slug}.json', 'une chaîne, ses vidéos examinées et les réponses publiées')}
${endpoint('api/v1/corrections.json', 'toutes les corrections, de la plus récente à la plus ancienne')}
${endpoint('data/claims.json', 'tout en un seul fichier')}
</ul>
<p>Les adresses sont relatives à <code>${root || 'la racine du site'}</code>. La forme de la v1 ne change pas : un changement incompatible ira dans <code>api/v2/</code>. Les champs peuvent s'enrichir ; ignorez ceux que vous ne connaissez pas.</p>
<pre>const api = '${root}api/v1/';
const { items } = await (await fetch(api + 'videos.json')).json();
const verifiees = items.filter(video => video.statement);</pre>
${hasFeeds ? `<h2>Flux RSS</h2>
<ul>
${endpoint('feed.xml', 'les dernières vérifications')}
${endpoint('corrections.xml', 'les corrections')}
</ul>` : ''}`;
}

module.exports = { enabled, rssFeeds, jsonApi, apiDocs, PAGE_SIZE };
