// The subscribe call to action is mandatory: in the closing narration, in every description and at the end of
// every Short. The channel profile's call to action is the wording; these helpers find or supply it.
const SUBSCRIBE = /\b(abonne|abonnez|abonnes|subscribe)/i;

const DEFAULTS = {
  fr: 'Abonne-toi pour ne rien manquer.',
  en: 'Subscribe for more.'
};

function language() {
  return (process.env.CONTENT_LANGUAGE || 'en') === 'fr' ? 'fr' : 'en';
}

function hasSubscribeCall(text) {
  return SUBSCRIBE.test(String(text || ''));
}

// The first sentence of `text` that asks to subscribe, or the default line in the content language.
function subscribeSentence(text, lang = language()) {
  const sentences = String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/);
  return sentences.find(sentence => SUBSCRIBE.test(sentence)) || DEFAULTS[lang] || DEFAULTS.en;
}

function subscribeUrl(channelId) {
  return channelId ? `https://www.youtube.com/channel/${channelId}?sub_confirmation=1` : '';
}

// "🔔 Abonne-toi pour ne rien manquer : https://www.youtube.com/channel/…?sub_confirmation=1"
function subscribeLine(text, channelId, lang = language()) {
  const sentence = subscribeSentence(text, lang);
  const url = subscribeUrl(channelId);
  if (!url) return `🔔 ${sentence}`;
  return `🔔 ${sentence.replace(/[\s.!…]+$/, '')}${lang === 'fr' ? ' : ' : ': '}${url}`;
}

module.exports = { SUBSCRIBE, hasSubscribeCall, subscribeSentence, subscribeUrl, subscribeLine };
