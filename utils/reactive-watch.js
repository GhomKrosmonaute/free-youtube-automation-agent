// React mode: answers what watched channels publish while it circulates. Every five minutes, the public feeds of the
// watched channels (utils/watch-list.js) list their new videos, Shorts included, without spending YouTube quota. Jev
// makes every typed choice: whether a new video makes a claim the channel answers (what that is comes from the react
// profile's `watch`), which of its sentences are verifiable claims (the passages the answer quotes, with their
// timestamps when the operator pastes the transcript), the technique it relies on (when the profile has techniques)
// and how much is at stake. Claude states the claim and a working title, and the next free generation slot goes to the
// most urgent item. The answer names and links the video it examines and quotes it word for word, as text: no footage
// is reused. At most REACTIVE_PER_CHANNEL_WEEKLY answers per channel a week, REACTIVE_DAILY_MAX a day.
const axios = require('axios');
const { extractJson } = require('./ai-json');
const jevClient = require('./jev');
const { techniques } = require('./techniques');
const { isReactMode } = require('./content-mode');
const { reactProfile } = require('./react-profile');

const HOUR = 3600000;
const MAX_AGE_HOURS = 72;

const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};
const settings = () => ({
  // Every new video of a watched channel is looked at; a minimum audience can be set to answer only what spreads.
  minViewsPerHour: number('REACTIVE_MIN_VIEWS_PER_HOUR', 0),
  minViews: number('REACTIVE_MIN_VIEWS', 0),
  dailyMax: number('REACTIVE_DAILY_MAX', 4),
  perChannelWeekly: number('REACTIVE_PER_CHANNEL_WEEKLY', 2),
  minStance: 0.7,
  minPassage: 0.6,
  // An answer is one Short unless Jev is this sure that its arguments need a series, of at most REACTIVE_MAX_PARTS.
  seriesConfidence: number('REACTIVE_SERIES_CONFIDENCE', 0.7),
  maxParts: Math.max(1, Math.round(number('REACTIVE_MAX_PARTS', 4))),
  // Minutes between two Data API reads of a channel whose public feed fails.
  apiFallbackMinutes: number('REACTIVE_API_FALLBACK_MINUTES', 15)
});

// How sure Jev must be that a new video makes a claim the channel answers: less for a channel the operator added by
// hand, who already judged that it publishes such claims (REACTIVE_MANUAL_MIN_STANCE, 0.5).
function minStanceFor(origin) {
  return origin === 'manual' ? number('REACTIVE_MANUAL_MIN_STANCE', 0.5) : settings().minStance;
}

// A channel's latest uploads: its public feed (no quota), or, when YouTube answers the feed with an error (frequent
// 404s), its uploads playlist through the Data API (1 quota unit). Without a youtube client the feed error is thrown.
async function latestUploads(channelId, { http, youtube = null }) {
  try {
    const { data } = await http.get(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { timeout: 15000, responseType: 'text' });
    return { entries: parseFeed(data), via: 'feed' };
  } catch (error) {
    if (!youtube) throw error;
    const { data } = await youtube.playlistItems.list({ part: ['snippet', 'contentDetails'], playlistId: `UU${channelId.slice(2)}`, maxResults: 15 });
    return {
      via: 'api',
      entries: (data?.items || []).map(item => ({
        videoId: item.contentDetails?.videoId || item.snippet?.resourceId?.videoId || null,
        channelId,
        title: String(item.snippet?.title || ''),
        description: String(item.snippet?.description || ''),
        publishedAt: item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || null
      })).filter(entry => entry.videoId && entry.publishedAt)
    };
  }
}

// How much is at stake if the claim is believed: the order in which waiting answers are made.
const STAKES = [
  'Little at stake for the viewer',
  'Misrepresents facts, history or science',
  'Health, money or safety at stake'
];

// What the channel reacts to (react profile `watch`), and what is at stake for a viewer who believes a claim.
function watchRules() {
  const watch = reactProfile().watch || {};
  return {
    kind: watch.kind || 'a claim or an argument, within these subjects, that the channel would answer',
    examples: watch.examples || 'It makes such a claim or argument',
    notPassage: watch.notPassage || 'An exhortation, opinion, promotion, question or link',
    topicRule: watch.topicRule || 'the working title of a video answering it, worded the way the target audience would search for it on YouTube',
    stakes: Array.isArray(watch.stakes) && watch.stakes.length ? watch.stakes : STAKES
  };
}

// The sentences of a video's title and description that could carry a claim (links, hashtags and fragments left out).
function sentencesOf(video) {
  const lines = [video.title, ...String(video.description || '').split(/\n+/)]
    .flatMap(line => String(line || '').split(/(?<=[.!?…])\s+/))
    .map(line => line.replace(/https?:\/\/\S+/g, '').replace(/#\S+/g, '').replace(/\s+/g, ' ').trim())
    .filter(line => line.length >= 25);
  return [...new Set(lines)].slice(0, 30).map((text, index) => ({ text, source: index === 0 && text === video.title.trim() ? 'title' : 'description' }));
}

// A transcript copied from YouTube's "Show transcript" panel: "0:12" lines followed by text, or "0:12 text" lines.
function parseTranscript(text) {
  const segments = [];
  let timestamp = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const inline = line.match(/^(\d{1,2}(?::\d{2}){1,2})\s+(.+)$/);
    if (inline) {
      segments.push({ timestamp: inline[1], text: inline[2] });
      timestamp = null;
    } else if (/^\d{1,2}(?::\d{2}){1,2}$/.test(line)) {
      timestamp = line;
    } else if (timestamp) {
      segments.push({ timestamp, text: line });
      timestamp = null;
    } else if (segments.length) {
      segments[segments.length - 1].text += ` ${line}`;
    }
  }
  // Two segments at a time: a quoted passage reads as a sentence, not a caption fragment.
  const passages = [];
  for (let index = 0; index < segments.length; index += 2) {
    passages.push({ timestamp: segments[index].timestamp, text: segments.slice(index, index + 2).map(segment => segment.text).join(' ').replace(/\s+/g, ' ').trim(), source: 'transcript' });
  }
  return passages.filter(passage => passage.text.length >= 20);
}

const decode = value => String(value || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

// The entries of a channel's public Atom feed (youtube.com/feeds/videos.xml).
function parseFeed(xml) {
  return String(xml || '').split('<entry>').slice(1).map(entry => ({
    videoId: entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1] || null,
    channelId: entry.match(/<yt:channelId>([^<]+)<\/yt:channelId>/)?.[1] || null,
    title: decode(entry.match(/<title>([^<]*)<\/title>/)?.[1]),
    description: decode(entry.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1]),
    publishedAt: entry.match(/<published>([^<]+)<\/published>/)?.[1] || null
  })).filter(entry => entry.videoId && entry.publishedAt);
}

class ReactiveWatch {
  // youtube: a YouTube Data API client, or a function returning one.
  constructor(db, { youtube = null, aiText = null, jev = jevClient, http = axios, logger = null, now = () => Date.now() } = {}) {
    this.db = db;
    this.youtube = youtube;
    this.ai = aiText;
    this.jev = jev;
    this.http = http;
    this.logger = logger;
    this.now = now;
    this.apiFallbackAt = new Map();
  }

  // The watch belongs to react mode (CONTENT_MODE=react); REACTIVE=off stops it there too.
  enabled() {
    return isReactMode() && String(process.env.REACTIVE || '').trim().toLowerCase() !== 'off';
  }

  client() {
    return typeof this.youtube === 'function' ? this.youtube() : this.youtube;
  }

  // New videos of the watched channels, under 72 hours old and never looked at.
  async freshVideos() {
    const fresh = [];
    for (const channel of await this.db.listWatchedChannels()) {
      try {
        // The Data API stands in for a failing feed, at most once every REACTIVE_API_FALLBACK_MINUTES per channel.
        const lastApiRead = this.apiFallbackAt.get(channel.channelId) || 0;
        const apiAllowed = this.youtube && this.now() - lastApiRead >= settings().apiFallbackMinutes * 60000;
        const { entries, via } = await latestUploads(channel.channelId, { http: this.http, youtube: apiAllowed ? this.client() : null });
        if (via === 'api') this.apiFallbackAt.set(channel.channelId, this.now());
        await this.db.markWatchedChannelChecked(channel.channelId);
        for (const entry of entries) {
          const age = this.now() - new Date(entry.publishedAt).getTime();
          if (!(age >= 0 && age <= MAX_AGE_HOURS * HOUR)) continue;
          if (await this.db.findReactiveItem({ videoId: entry.videoId })) continue;
          fresh.push({ ...entry, channelId: entry.channelId || channel.channelId, channelTitle: channel.title, watchedOrigin: channel.origin });
        }
      } catch (error) {
        this.logger?.warn?.(`Feed of channel ${channel.channelId} could not be read: ${error.message.slice(0, 120)}`);
      }
    }
    return fresh;
  }

  // Their views, views per hour and description (1 quota unit per 50 videos).
  async withStatistics(videos) {
    const youtube = this.client();
    const result = [];
    for (let index = 0; index < videos.length; index += 50) {
      const batch = videos.slice(index, index + 50);
      const { data } = await youtube.videos.list({ part: ['statistics', 'snippet'], id: batch.map(video => video.videoId), maxResults: 50 });
      const byId = new Map((data?.items || []).map(item => [item.id, item]));
      for (const video of batch) {
        const item = byId.get(video.videoId);
        if (!item) continue;
        const views = Number(item.statistics?.viewCount || 0);
        const hours = Math.max(1, (this.now() - new Date(video.publishedAt).getTime()) / HOUR);
        result.push({
          ...video,
          views,
          viewsPerHour: Math.round(views / hours),
          description: String(item.snippet?.description || '').slice(0, 1500),
          language: String(item.snippet?.defaultAudioLanguage || item.snippet?.defaultLanguage || '').toLowerCase()
        });
      }
    }
    return result;
  }

  // Jev's probability that the video makes a claim the channel answers; null without Jev (Claude decides).
  async stance(video, pillars) {
    if (!this.jev?.enabled?.()) return null;
    const answers = await this.jev.ask({
      purpose: 'reactive_stance',
      state: { subjects: pillars, video: { title: video.title, channel: video.channelTitle, description: video.description.slice(0, 800) } },
      questions: {
        defends: {
          type: 'noul',
          instructions: `Does this video defend or promote ${watchRules().kind}?`,
          criteria: {
            true: watchRules().examples,
            false: 'It reports, discusses, criticises, or is about something else'
          }
        }
      }
    });
    const probability = Number(answers.defends?.noul);
    return Number.isFinite(probability) ? probability : null;
  }

  // Jev keeps the sentences that are verifiable claims presented as true (not prayer, exhortation or promotion): the
  // passages the answer quotes, the strongest first.
  async passagesOf(sentences, context) {
    if (!this.jev?.enabled?.()) return sentences.slice(0, 5).map(sentence => ({ ...sentence, probability: null }));
    const scored = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, sentences.length) }, async () => {
      while (next < sentences.length) {
        const sentence = sentences[next++];
        try {
          const answers = await this.jev.ask({
            purpose: 'hot_passage',
            state: { video: context.title, channel: context.channel, sentence: sentence.text },
            questions: {
              claim: {
                type: 'noul',
                instructions: 'Does this sentence present as true a verifiable claim (historical, scientific, medical, about what a text says or what happened)?',
                criteria: { true: 'A factual claim that could be checked against sources', false: watchRules().notPassage }
              }
            }
          });
          const probability = Number(answers.claim?.noul ?? 0);
          if (probability >= settings().minPassage) scored.push({ ...sentence, probability });
        } catch (error) {
          this.logger?.warn?.(`Jev could not read a sentence: ${error.message.slice(0, 120)}`);
        }
      }
    }));
    return scored.sort((a, b) => b.probability - a.probability).slice(0, 6);
  }

  // The technique the claim relies on (when the profile has techniques), how urgent an answer is, and how many Shorts
  // it takes (Jev; without it, one Short and no technique). Most answers are one Short; a series (part 1, part 2...) only when the
  // video makes many distinct arguments that each need their own evidence: two passages a part.
  async judge(context, passages) {
    if (!this.jev?.enabled?.()) return { technique: null, priority: 0, parts: 1 };
    const answers = await this.jev.ask({
      purpose: 'hot_judge',
      state: { video: context.title, channel: context.channel, claims: passages.map(passage => passage.text) },
      questions: {
        ...(techniques().length ? {
          technique: {
            type: 'choice',
            instructions: 'Which technique do these claims rely on most?',
            criteria: Object.fromEntries(techniques().map(technique => [technique.id, `${technique.name}: ${technique.definition}`]))
          }
        } : {}),
        stakes: { type: 'score', instructions: 'What is at stake for a viewer who believes these claims?', criteria: watchRules().stakes },
        length: {
          type: 'choice',
          instructions: 'How long must an answer be to examine these claims with quality (each one stated, then checked against the evidence)?',
          criteria: {
            one: 'One Short of about two minutes answers them well: a single claim, or a few claims that the same evidence settles',
            series: 'Many distinct arguments, each needing its own evidence and explanation: one two-minute Short cannot answer them all well'
          }
        }
      }
    });
    const limits = settings();
    const series = answers.length?.choice === 'series' && Number(answers.length?.confidence) >= limits.seriesConfidence && passages.length >= 3;
    return {
      technique: answers.technique?.confidence >= 0.4 ? answers.technique.choice : null,
      priority: Number(answers.stakes?.score ?? 0),
      parts: series ? Math.max(2, Math.min(limits.maxParts, Math.ceil(passages.length / 2))) : 1
    };
  }

  // The claim the video makes and a working title for the answer, unless the channel covered it.
  async extract(video, recentTopics, passages = []) {
    const rules = watchRules();
    const lang = process.env.CONTENT_LANGUAGE || 'en';
    const prompt = `A YouTube video was just published. Title: "${video.title}". Channel: ${video.channelTitle}.
Description: ${video.description.slice(0, 1200)}
Sentences that present claims: ${JSON.stringify(passages.map(passage => passage.text))}

Return only JSON: {"defends": true or false, "claim": "the precise claim the video defends, in the language with ISO code ${lang}, as its author states it", "topic": "${rules.topicRule.replace(/"/g, '\'')}, in the language with ISO code ${lang}", "covered": true or false}
"defends" is false when the video does not defend ${rules.kind}. "covered" is true when one of these subjects, already covered by the channel, answers the same claim: ${JSON.stringify(recentTopics.slice(0, 60))}`;
    const parsed = extractJson(await this.ai.generateText(prompt, { model: this.ai.lightModel?.(), maxTokens: 800, temperature: 0.2, purpose: 'reactive_claim' }));
    return {
      defends: parsed?.defends === true,
      covered: parsed?.covered === true,
      claim: String(parsed?.claim || '').replace(/\s+/g, ' ').trim().slice(0, 500),
      topic: String(parsed?.topic || '').replace(/\s+/g, ' ').trim().slice(0, 200)
    };
  }

  // One pass: new videos of the watched channels that spread fast and defend a claim become reactive items, within
  // REACTIVE_DAILY_MAX a day. A video looked at and set aside is recorded as dismissed, so it is not looked at again.
  async poll(channelStrategy = {}) {
    if (!this.enabled()) return { created: [] };
    const limits = settings();
    const fresh = await this.freshVideos();
    if (!fresh.length) return { created: [] };
    const spreading = (await this.withStatistics(fresh))
      .filter(video => video.views >= limits.minViews && video.viewsPerHour >= limits.minViewsPerHour)
      .filter(video => !video.language || video.language.startsWith('fr'))
      .sort((a, b) => b.viewsPerHour - a.viewsPerHour);
    let room = limits.dailyMax - await this.db.countReactiveItemsSince(new Date(this.now() - 24 * HOUR).toISOString().replace('T', ' ').slice(0, 19));
    const recentTopics = (await this.db.getAllRows("SELECT topic FROM content_strategies WHERE created_at >= datetime('now', '-180 days')").catch(() => [])).map(row => row.topic);
    const created = [];
    const setAside = async (video, reason) => {
      const item = await this.db.createReactiveItem({ videoId: video.videoId, channelId: video.channelId, video: this.summary(video), claim: reason, topic: video.title });
      await this.db.updateReactiveItem(item.id, { status: 'dismissed', error: reason });
    };
    const weekAgo = new Date(this.now() - 7 * 24 * HOUR).toISOString().replace('T', ' ').slice(0, 19);
    for (const video of spreading) {
      if (room <= 0) break;
      try {
        if (await this.db.countReactiveItemsForChannelSince(video.channelId, weekAgo) >= limits.perChannelWeekly) {
          await setAside(video, `Déjà ${limits.perChannelWeekly} réponses à cette chaîne cette semaine`);
          continue;
        }
        const probability = await this.stance(video, channelStrategy.contentPillars || []);
        if (probability !== null && probability < minStanceFor(video.watchedOrigin)) {
          await setAside(video, `Jev : ne défend pas une affirmation des thèmes de la chaîne (${probability})`);
          continue;
        }
        const context = { title: video.title, channel: video.channelTitle };
        const passages = await this.passagesOf(sentencesOf(video), context);
        if (!passages.length) {
          await setAside(video, 'Jev : aucune affirmation vérifiable dans le titre ni la description');
          continue;
        }
        if (!this.ai?.isAvailable?.()) break;
        const found = await this.extract(video, recentTopics, passages);
        if (!found.defends || !found.claim || !found.topic) {
          await setAside(video, 'Pas d\'affirmation à examiner');
          continue;
        }
        if (found.covered) {
          await setAside(video, `Déjà traité : ${found.claim}`);
          continue;
        }
        const { technique, priority, parts } = await this.judge(context, passages);
        created.push(await this.db.createReactiveItem({
          videoId: video.videoId, channelId: video.channelId, video: this.summary(video), claim: found.claim, topic: found.topic,
          passages: passages.map(storedPassage), technique, priority, parts
        }));
        room -= 1;
      } catch (error) {
        this.logger?.warn?.(`Reactive check of ${video.videoId} failed: ${error.message.slice(0, 160)}`);
      }
    }
    if (created.length) this.logger?.info?.(`Reactive items queued: ${created.map(item => item.topic).join(' | ')}`);
    return { created };
  }

  // The operator pastes the transcript (YouTube's "Show transcript" panel) of a video waiting to be answered: Jev picks
  // the passages to quote, with their timestamps, before the script is written.
  async setTranscript(itemId, text) {
    const item = await this.db.getReactiveItem(itemId);
    if (!item) throw new Error('Reactive item not found');
    if (item.status !== 'queued') throw new Error(`This answer is already ${item.status}: the transcript must be added before production starts`);
    const context = { title: item.video.title, channel: item.video.channel };
    const passages = await this.passagesOf(parseTranscript(text).slice(0, 120), context);
    if (!passages.length) throw new Error('No verifiable claim found in this transcript');
    const ordered = passages.slice().sort((a, b) => toSeconds(a.timestamp) - toSeconds(b.timestamp))
      .map(passage => storedPassage({ ...passage, source: 'transcript' }));
    // The whole video says more than its description: the technique and the length of the answer are judged again.
    const judged = await this.judge(context, passages);
    return this.db.updateReactiveItem(itemId, {
      passages: ordered, parts: judged.parts, ...(judged.technique ? { technique: judged.technique } : {})
    });
  }

  summary(video) {
    return {
      title: video.title, channel: video.channelTitle, views: video.views, viewsPerHour: video.viewsPerHour,
      publishedAt: video.publishedAt, url: `https://www.youtube.com/watch?v=${video.videoId}`
    };
  }

  // Items still waiting (not started, or held, for instance by an expert review) more than 72 hours after the video
  // they answer was found are no longer an urgent answer.
  // A series whose first part is out is not stale: its next parts finish the answer.
  async expire() {
    const stale = [];
    for (const item of (await this.db.listReactiveItems({ status: ['queued', 'generating'] })).filter(entry => (entry.episodes || []).length <= 1)) {
      const age = this.now() - new Date(`${String(item.createdAt).replace(' ', 'T')}Z`).getTime();
      if (age > MAX_AGE_HOURS * HOUR) stale.push(await this.db.updateReactiveItem(item.id, { status: 'expired' }));
    }
    return stale;
  }
}

// A passage as an item keeps it: what was said, where it was found, when, and how sure Jev is that it is a claim.
function storedPassage({ text, source, timestamp, probability }) {
  return { text, source, ...(timestamp ? { timestamp } : {}), ...(Number.isFinite(probability) ? { probability } : {}) };
}

// The passages one part of an answer quotes. A single Short quotes the three strongest; a series splits every passage
// in the order the video says them, the parts as even as they can be. Shown in the order of the video.
function partPassages(passages = [], part = 1, parts = 1) {
  const inVideoOrder = list => list.slice().sort((a, b) => (a.timestamp && b.timestamp ? toSeconds(a.timestamp) - toSeconds(b.timestamp) : 0));
  if (parts <= 1) {
    const strongest = passages.slice().sort((a, b) => (Number(b.probability) || 0) - (Number(a.probability) || 0)).slice(0, 3);
    return inVideoOrder(strongest);
  }
  const ordered = inVideoOrder(passages);
  const size = Math.ceil(ordered.length / parts);
  return ordered.slice((part - 1) * size, part * size);
}

function toSeconds(timestamp) {
  return String(timestamp || '0').split(':').reduce((total, part) => total * 60 + Number(part || 0), 0);
}

module.exports = { ReactiveWatch, parseFeed, parseTranscript, sentencesOf, latestUploads, minStanceFor, partPassages, STAKES };
