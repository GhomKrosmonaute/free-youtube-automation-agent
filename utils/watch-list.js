// The channels react mode follows: at most WATCH_MAX_CHANNELS (20). A channel enters when it is added by hand, found
// supporting claims in two measured gaps, or named by the weekly discovery and confirmed by Jev. When the list is full,
// a newcomer takes the place of the lowest-scored automatic channel past its grace period (WATCH_GRACE_DAYS, 14). The
// score is how the audience reacted to the channel's answers to it: the average goal stance rate measured in their
// comments (react profile `audience`). A channel that led to no measured answer by the end of its grace period scores lowest. Channels added by
// hand are never pushed out automatically.
const DAY = 86400000;

const setting = (name, fallback) => {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

class WatchList {
  constructor(db, { now = () => Date.now(), logger = null } = {}) {
    this.db = db;
    this.now = now;
    this.logger = logger;
  }

  maxChannels() {
    return setting('WATCH_MAX_CHANNELS', 20);
  }

  graceDays() {
    return setting('WATCH_GRACE_DAYS', 14);
  }

  ageDays(channel) {
    if (!channel.activatedAt) return Infinity;
    return (this.now() - new Date(`${String(channel.activatedAt).replace(' ', 'T')}Z`).getTime()) / DAY;
  }

  // Lowest first: no measured answer after the grace period, then the lowest average goal stance rate.
  rank(channel) {
    return channel.score === null ? -1 : channel.score;
  }

  // Each channel's score: the average goal stance rate of the published answers to its videos.
  async refreshScores() {
    for (const channel of await this.db.listWatchedChannels({ active: null })) {
      const answers = await this.db.getAllRows(
        `SELECT DISTINCT ps.youtube_id FROM reactive_items ri JOIN publish_schedule ps ON ps.production_id = ri.production_id
         WHERE ri.channel_id = ? AND ri.status = 'published' AND ps.youtube_id IS NOT NULL`,
        [channel.channelId]
      );
      const rates = [];
      for (const answer of answers) {
        const persuasion = (await this.db.getEngagementInsight(answer.youtube_id))?.persuasion;
        const rate = persuasion?.goalRate;
        if (rate !== null && rate !== undefined) rates.push(Number(rate));
      }
      const score = rates.length ? Math.round((rates.reduce((sum, rate) => sum + rate, 0) / rates.length) * 10) / 10 : null;
      await this.db.setWatchedChannelScore(channel.channelId, score, answers.length);
    }
  }

  // Watches a recorded channel when there is room, or in place of the weakest automatic one. A channel added by hand
  // may also replace one still in its grace period.
  async admit(channelId, { manual = false } = {}) {
    const channel = await this.db.getWatchedChannel(channelId);
    if (!channel) return { admitted: false, reason: 'unknown channel' };
    if (channel.active) return { admitted: true, already: true };
    const active = await this.db.listWatchedChannels();
    if (active.length < this.maxChannels()) {
      await this.db.setWatchedChannelActive(channelId, true);
      return { admitted: true };
    }
    const [weakest] = active
      .filter(item => item.origin !== 'manual' && (manual || this.ageDays(item) >= this.graceDays()))
      .sort((a, b) => this.rank(a) - this.rank(b));
    if (!weakest) return { admitted: false, reason: `the ${this.maxChannels()} places are taken` };
    await this.db.setWatchedChannelActive(weakest.channelId, false, `remplacée par ${channel.title || channelId}`);
    await this.db.setWatchedChannelActive(channelId, true);
    this.logger?.info?.(`Watch list: ${channel.title || channelId} in, ${weakest.title || weakest.channelId} out (score ${weakest.score ?? 'none'})`);
    return { admitted: true, evicted: weakest };
  }
}

module.exports = { WatchList };
