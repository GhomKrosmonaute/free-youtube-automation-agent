// One caption for TikTok and Instagram from the Short's YouTube metadata: links are not clickable there, so the
// YouTube URLs go and the viewer is sent to the link in bio instead.
const MAX_CAPTION = 2200;

function subscribeLine(profile, fr) {
  const cta = String(profile?.call_to_action || profile?.callToAction || '');
  const sentence = cta.split(/(?<=[.!?])\s+/).map(item => item.trim()).find(item => /abonne|subscribe/i.test(item));
  return sentence || (fr ? 'Abonne-toi pour la suite.' : 'Subscribe for more.');
}

function hashtags(tags = []) {
  const seen = new Set();
  const result = [];
  for (const tag of tags) {
    const word = String(tag || '').normalize('NFC').replace(/[^\p{L}\p{N}_]+/gu, '');
    const key = word.toLowerCase();
    // #Shorts only means something on YouTube.
    if (!word || word.length > 30 || key === 'shorts' || seen.has(key)) continue;
    seen.add(key);
    result.push(`#${word}`);
    if (result.length === 5) break;
  }
  return result.join(' ');
}

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function buildSocialCaption({ title = '', description = '', tags = [], profile = null, language = process.env.CONTENT_LANGUAGE || 'en' } = {}) {
  const fr = language === 'fr';
  const subscribe = subscribeLine(profile, fr);
  const lines = String(description || '').split('\n')
    .filter(line => !/https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(line))
    .map(line => line.replace(/(^|\s)#shorts\b/gi, '').trimEnd());
  const body = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const tail = [
    normalized(body).includes(normalized(subscribe)) ? '' : subscribe,
    fr ? 'Vidéo complète sur YouTube (lien en bio)' : 'Full video on YouTube (link in bio)',
    hashtags(tags)
  ].filter(Boolean).join('\n\n');
  const head = String(title || '').trim();
  // The description gives way first: the title, the subscribe line and the hashtags always fit.
  const room = MAX_CAPTION - head.length - tail.length - 4;
  const trimmedBody = body.length > room ? `${body.slice(0, Math.max(0, room - 1)).trim()}…` : body;
  return [head, room > 1 ? trimmedBody : '', tail].filter(Boolean).join('\n\n').slice(0, MAX_CAPTION);
}

module.exports = { buildSocialCaption, MAX_CAPTION };
