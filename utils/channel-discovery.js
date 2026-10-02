// React mode: every week, Claude searches the web for the best-known YouTube channels that publish what the channel
// answers, in the categories of the react profile's `discovery`, ten at a time. Each one is resolved to its channel
// id, Jev confirms from the channel's description and its latest videos (titles and descriptions) that it mostly
// publishes such content, and the watch list admits it (utils/watch-list.js). A channel is followed for what it
// publishes, never for who its creators are; the categories and reasons are internal and never published. Without
// categories in the profile, nothing is searched.
const axios = require('axios');
const claudeCode = require('./claude-code-provider');
const { extractJson } = require('./ai-json');
const jevClient = require('./jev');
const { latestUploads } = require('./reactive-watch');
const { reactProfile } = require('./react-profile');

// { id: what a channel of this category publishes }.
function categories() {
  const list = reactProfile().discovery?.categories;
  return list && typeof list === 'object' ? list : {};
}

class ChannelDiscovery {
  // youtube: a YouTube Data API client, or a function returning one.
  constructor(db, { youtube = null, watchList, jev = jevClient, runClaudeCode = claudeCode.runClaudeCode, claudeEnabled = claudeCode.enabled, http = axios, logger = null } = {}) {
    this.db = db;
    this.youtube = youtube;
    this.watchList = watchList;
    this.jev = jev;
    this.runClaudeCode = runClaudeCode;
    this.claudeEnabled = claudeEnabled;
    this.http = http;
    this.logger = logger;
  }

  client() {
    return typeof this.youtube === 'function' ? this.youtube() : this.youtube;
  }

  // Ten channels found by web search, with the public source that documents each.
  async propose(known = []) {
    const kinds = categories();
    const lang = process.env.CONTENT_LANGUAGE || 'en';
    const prompt = `Search the web to find the 10 best-known YouTube channels in the language with ISO code ${lang} that currently publish content of these kinds:
${Object.entries(kinds).map(([id, description]) => `- ${id}: ${description}`).join('\n')}

Choose channels for what they publish, as documented by public sources; never for the religion, origin or community of their creators.${reactProfile().discovery?.exclude ? ` ${reactProfile().discovery.exclude}` : ''} Prefer the channels with the largest audience. Leave out these, already known: ${JSON.stringify(known.slice(0, 60))}

Return only a JSON array, at most 10 items: [{"name": "channel name", "url": "https://www.youtube.com/@handle or https://www.youtube.com/channel/UC...", "category": "${Object.keys(kinds).join('|')}", "reason": "one sentence citing the public source that documents it"}]`;
    const answer = await this.runClaudeCode({ prompt, tools: ['WebSearch', 'WebFetch'], purpose: 'channel_discovery' });
    const parsed = extractJson(answer, { prefer: 'array' });
    return (Array.isArray(parsed) ? parsed : []).slice(0, 10).map(item => ({
      name: String(item?.name || '').trim().slice(0, 120),
      url: String(item?.url || '').trim(),
      category: kinds[item?.category] ? item.category : null,
      reason: String(item?.reason || '').trim().slice(0, 400)
    })).filter(item => item.name && item.url && item.category);
  }

  // The channel behind a /channel/UC… or /@handle address, with its description (1 quota unit; no search is spent).
  async resolve(candidate) {
    const direct = candidate.url.match(/\/channel\/(UC[\w-]{22})/);
    const handle = candidate.url.match(/\/@([\w.-]+)/);
    if (!direct && !handle) return null;
    const { data } = await this.client().channels.list({ part: ['snippet', 'statistics'], ...(direct ? { id: [direct[1]] } : { forHandle: `@${handle[1]}` }) });
    const channel = data?.items?.[0];
    if (!channel) return null;
    const subscribers = channel.statistics?.hiddenSubscriberCount ? null : Number(channel.statistics?.subscriberCount);
    return {
      channelId: channel.id,
      title: channel.snippet?.title || candidate.name,
      description: String(channel.snippet?.description || ''),
      subscribers: Number.isFinite(subscribers) ? subscribers : null
    };
  }

  // Jev reads the channel's description and its latest videos, titles and descriptions (its public feed, no quota):
  // does it mostly promote such claims? Titles alone are often neutral when the content is not.
  async confirm(channelId, category, channelDescription = '') {
    if (!this.jev?.enabled?.()) return null;
    const { entries } = await latestUploads(channelId, { http: this.http, youtube: this.youtube ? this.client() : null });
    const videos = entries.slice(0, 15).map(entry => ({ title: entry.title, description: String(entry.description || '').replace(/\s+/g, ' ').slice(0, 300) }));
    if (!videos.length) return 0;
    const answers = await this.jev.ask({
      purpose: 'channel_discovery',
      state: { channelDescription: String(channelDescription).replace(/\s+/g, ' ').slice(0, 1000), latestVideos: videos },
      questions: {
        promotes: {
          type: 'noul',
          instructions: `Do this channel's description and its latest videos (titles and descriptions) show a channel that mostly publishes content of this kind: ${categories()[category]}?`,
          criteria: { true: 'Most of its videos are of this kind', false: 'Its videos discuss, criticise, report, or are about something else' }
        }
      }
    });
    return Number(answers.promotes?.noul ?? 0);
  }

  // One discovery pass; returns the channels admitted or set aside, with why.
  async run() {
    if (!Object.keys(categories()).length) return { admitted: [], skipped: [] };
    if (!this.claudeEnabled()) {
      this.logger?.warn?.('Channel discovery needs Claude Code with web search (TEXT_PROVIDER=claude-code); skipped');
      return { admitted: [], skipped: [] };
    }
    await this.watchList.refreshScores();
    const known = await this.db.listWatchedChannels({ active: null });
    const admitted = [];
    const skipped = [];
    for (const candidate of await this.propose(known.map(channel => channel.title).filter(Boolean))) {
      try {
        const resolved = await this.resolve(candidate);
        if (!resolved) {
          skipped.push({ ...candidate, why: 'channel not found' });
          continue;
        }
        if (known.some(channel => channel.channelId === resolved.channelId && channel.active)) continue;
        const confidence = await this.confirm(resolved.channelId, candidate.category, resolved.description);
        if (confidence !== null && confidence < 0.7) {
          skipped.push({ ...candidate, why: `Jev: its titles do not mostly promote such claims (${confidence})` });
          continue;
        }
        await this.db.upsertWatchedChannel({
          channelId: resolved.channelId, title: resolved.title, origin: 'discovery', category: candidate.category, reason: candidate.reason,
          subscribers: resolved.subscribers
        });
        const result = await this.watchList.admit(resolved.channelId);
        if (result.admitted) admitted.push({ ...candidate, channelId: resolved.channelId, evicted: result.evicted?.title || null });
        else skipped.push({ ...candidate, why: result.reason });
      } catch (error) {
        skipped.push({ ...candidate, why: error.message.slice(0, 160) });
      }
    }
    this.logger?.info?.(`Channel discovery: ${admitted.length} admitted, ${skipped.length} set aside`);
    return { admitted, skipped };
  }
}

module.exports = { ChannelDiscovery, categories };
