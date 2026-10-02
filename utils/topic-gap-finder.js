// React mode: picks subjects where the channel adds something: claims many people watch being supported on YouTube and
// few watch being answered. For each candidate claim (proposed by Claude within the react profile's `gaps` rules, or
// asked for in the comments), one YouTube search; Jev reads each result and says whether it supports the claim,
// answers it, or neither. Demand is the views of the videos that support it, supply the views of those that answer it. The planner covers the widest gaps first, and the channels
// that defend a claim to a large audience become the reactive watcher's sources. Videos found here are never used as
// sources of a script.
const { extractJson } = require('./ai-json');
const jevClient = require('./jev');
const { YouTubeSearchBudget } = require('./youtube-search-budget');
const { reactProfile } = require('./react-profile');

// How candidate claims are found (react profile `gaps`): the channel's angle, examples of precise claims, which ones
// to prefer, and how their search query is worded.
function gapRules() {
  const gaps = reactProfile().gaps || {};
  return {
    channel: gaps.channel || '',
    examples: gaps.examples || '',
    preference: gaps.preference || '',
    queryRule: gaps.queryRule || 'the 2 to 6 words someone who holds the claim would type into YouTube search to find videos supporting it'
  };
}

const STANCES = {
  defends: 'It presents the claim as true, promotes it or teaches it',
  answers: 'It questions, criticises or refutes the claim',
  neutral: 'It reports on the claim without taking a side',
  unrelated: 'It is not about this claim'
};

// A channel defending a claim to at least this many views (summed over the videos found) is watched for new ones.
function watchMinViews() {
  const value = parseInt(process.env.GAP_WATCH_MIN_VIEWS, 10);
  return Number.isFinite(value) && value >= 0 ? value : 50000;
}

// Large demand counts (log), and only the part of the audience nobody answers.
function gapScore(demand, supply) {
  return Math.round(Math.log10(demand + 1) * (demand / (demand + supply + 1)) * 1000) / 1000;
}

const normalizeClaim = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();

async function pool(items, size, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

class TopicGapFinder {
  // youtube: a YouTube Data API client, or a function returning one (built only when a measurement runs).
  constructor(db, { youtube = null, aiText = null, jev = jevClient, budget = null, logger = null, concurrency = 5, watchList = null } = {}) {
    this.db = db;
    // The watch list, or a function returning it: a channel found defending a second claim is admitted there.
    this.watchList = watchList;
    this.youtube = youtube;
    this.ai = aiText;
    this.jev = jev;
    this.budget = budget || new YouTubeSearchBudget(db);
    this.logger = logger;
    this.concurrency = concurrency;
  }

  client() {
    return typeof this.youtube === 'function' ? this.youtube() : this.youtube;
  }

  // Precise claims supported on YouTube within the channel's pillars, plus the subjects viewers asked for in comments,
  // minus what the channel already covered or measured.
  async candidates(channelStrategy = {}, { count = 12 } = {}) {
    const known = new Set([
      ...(await this.db.getAllRows("SELECT topic FROM content_strategies WHERE created_at >= datetime('now', '-180 days')").catch(() => [])).map(row => row.topic),
      ...(await this.db.listTopicGaps({ limit: 500 })).map(gap => gap.claim)
    ].map(normalizeClaim));
    const asked = (await this.db.listLearningRecommendations?.({ status: 'approved', limit: 50 }).catch(() => []) || [])
      .filter(item => item.category === 'audience_demand' && item.proposedChange?.topic)
      .map(item => ({ claim: String(item.proposedChange.topic), query: String(item.proposedChange.topic).slice(0, 100), pillar: '' }));
    let proposed = [];
    if (this.ai?.isAvailable?.()) {
      const pillars = channelStrategy.contentPillars || [];
      const rules = gapRules();
      const lang = process.env.CONTENT_LANGUAGE || 'en';
      const prompt = `You find subjects for a YouTube channel${rules.channel ? ` ${rules.channel}` : ''}: ${channelStrategy.objective || ''}
Content pillars: ${pillars.join(' | ')}

List ${count} specific claims that circulate on YouTube today, in the language with ISO code ${lang}, within these pillars and supported by many videos. Each is a precise statement, not a broad subject${rules.examples ? ` (${rules.examples})` : ''}.${rules.preference ? ` ${rules.preference}` : ''}
For each: "claim" as the people who hold it state it, in that language; "query": ${rules.queryRule}; "pillar": one exact pillar from the list, or "".
Do not repeat these, already covered: ${JSON.stringify([...known].slice(0, 80))}
Return only a JSON array: [{"claim": "...", "query": "...", "pillar": "..."}]`;
      try {
        const parsed = extractJson(await this.ai.generateText(prompt, { model: this.ai.lightModel?.(), maxTokens: 2000, temperature: 0.6, purpose: 'gap_candidates' }), { prefer: 'array' });
        proposed = (Array.isArray(parsed) ? parsed : []).map(item => ({
          claim: String(item?.claim || '').trim().slice(0, 300),
          query: String(item?.query || '').trim().slice(0, 100),
          pillar: pillars.find(pillar => pillar.toLowerCase() === String(item?.pillar || '').trim().toLowerCase()) || ''
        })).filter(item => item.claim && item.query);
      } catch (error) {
        this.logger?.warn?.(`Gap candidates could not be proposed: ${error.message.slice(0, 200)}`);
      }
    }
    const seen = new Set(known);
    return [...asked, ...proposed].filter(item => {
      const key = normalizeClaim(item.claim);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // videoId → stance. Jev reads each video; without Jev, one Claude call reads them all.
  async classify(claim, videos) {
    const stances = new Map();
    if (this.jev?.enabled?.()) {
      await pool(videos, this.concurrency, async video => {
        try {
          const answers = await this.jev.ask({
            purpose: 'gap_stance',
            state: { claim, video: { title: video.title, channel: video.channel, description: video.description } },
            questions: { stance: { type: 'choice', instructions: `What does this YouTube video do with the claim "${claim}"?`, criteria: STANCES } }
          });
          if (STANCES[answers.stance?.choice]) stances.set(video.id, answers.stance.choice);
        } catch (error) {
          this.logger?.warn?.(`Jev could not classify a video: ${error.message.slice(0, 120)}`);
        }
      });
      return stances;
    }
    if (!this.ai?.isAvailable?.()) return stances;
    const prompt = `For each YouTube video below, say what it does with the claim "${claim}": ${Object.entries(STANCES).map(([key, label]) => `"${key}" (${label})`).join(', ')}.
Return only a JSON array of the same length, one of those words per video, in order.
${videos.map((video, index) => `${index + 1}. ${video.title} — ${video.channel} — ${video.description.slice(0, 200).replace(/\s+/g, ' ')}`).join('\n')}`;
    try {
      const parsed = extractJson(await this.ai.generateText(prompt, { model: this.ai.lightModel?.(), maxTokens: 800, temperature: 0, purpose: 'gap_stance' }), { prefer: 'array' });
      (Array.isArray(parsed) ? parsed : []).forEach((stance, index) => {
        if (videos[index] && STANCES[stance]) stances.set(videos[index].id, stance);
      });
    } catch (error) {
      this.logger?.warn?.(`Videos could not be classified: ${error.message.slice(0, 200)}`);
    }
    return stances;
  }

  // One search, the statistics of its results, their stances: the gap of one claim.
  async measure(candidate) {
    const youtube = this.client();
    const search = await this.budget.search(youtube, {
      part: ['snippet'], q: candidate.query, type: ['video'], maxResults: 25, relevanceLanguage: 'fr'
    });
    const ids = (search.data?.items || []).map(item => item.id?.videoId).filter(Boolean);
    if (!ids.length) return null;
    const details = await youtube.videos.list({ part: ['statistics', 'snippet'], id: ids, maxResults: 50 });
    // relevanceLanguage is only a hint: a video declared in another language is not part of this audience.
    const videos = (details.data?.items || []).filter(video => {
      const language = String(video.snippet?.defaultAudioLanguage || video.snippet?.defaultLanguage || '').toLowerCase();
      return !language || language.startsWith('fr');
    }).map(video => ({
      id: video.id,
      title: String(video.snippet?.title || ''),
      channelId: video.snippet?.channelId || null,
      channel: String(video.snippet?.channelTitle || ''),
      description: String(video.snippet?.description || '').slice(0, 500),
      views: Number(video.statistics?.viewCount || 0)
    }));
    const stances = await this.classify(candidate.claim, videos);
    const defending = videos.filter(video => stances.get(video.id) === 'defends').sort((a, b) => b.views - a.views);
    const answering = videos.filter(video => stances.get(video.id) === 'answers');
    const demand = defending.reduce((sum, video) => sum + video.views, 0);
    const supply = answering.reduce((sum, video) => sum + video.views, 0);
    const channels = new Map();
    for (const video of defending) {
      if (!video.channelId) continue;
      const channel = channels.get(video.channelId) || { channelId: video.channelId, title: video.channel, views: 0 };
      channel.views += video.views;
      channels.set(video.channelId, channel);
    }
    return {
      claim: candidate.claim,
      query: candidate.query,
      pillar: candidate.pillar || null,
      demandViews: demand,
      supplyViews: supply,
      defendCount: defending.length,
      answerCount: answering.length,
      score: gapScore(demand, supply),
      topVideos: defending.slice(0, 5).map(({ id, title, channel, views }) => ({ id, title, channel, views })),
      channels: [...channels.values()]
    };
  }

  // Measures new candidates while the search budget lasts; returns the gaps found.
  async refresh(channelStrategy, { limit = 12 } = {}) {
    if (!channelStrategy) return { measured: 0, gaps: [] };
    const gaps = [];
    for (const candidate of (await this.candidates(channelStrategy, { count: limit })).slice(0, limit)) {
      if (await this.budget.remaining() <= 0) break;
      try {
        const gap = await this.measure(candidate);
        if (!gap) continue;
        gaps.push(await this.db.saveTopicGap(gap));
        for (const channel of gap.channels) {
          if (channel.views < watchMinViews()) continue;
          const recorded = await this.db.upsertWatchedChannel({ channelId: channel.channelId, title: channel.title, defendViews: channel.views, origin: 'gap' });
          const watchList = typeof this.watchList === 'function' ? this.watchList() : this.watchList;
          if (recorded.sightings >= 2 && watchList) await watchList.admit(channel.channelId);
        }
      } catch (error) {
        if (error.code === 'SEARCH_BUDGET') break;
        this.logger?.warn?.(`Gap measurement failed for « ${candidate.claim} »: ${error.message.slice(0, 200)}`);
      }
    }
    this.logger?.info?.(`Topic gaps measured: ${gaps.length}`);
    return { measured: gaps.length, gaps };
  }
}

module.exports = { TopicGapFinder, gapScore, normalizeClaim, STANCES };
