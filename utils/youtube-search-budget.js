// YouTube searches (search.list) the topic gap finder and the reactive watcher may spend per day. Searches have a
// small quota of their own (about 100 calls a day); YOUTUBE_SEARCH_DAILY (default 30) keeps the rest free, and a
// quotaExceeded answer stops searching until the next day (UTC).
function dailyLimit() {
  const value = parseInt(process.env.YOUTUBE_SEARCH_DAILY, 10);
  return Number.isFinite(value) && value >= 0 ? value : 30;
}

function quotaExceeded(error) {
  const reasons = [
    ...(error?.errors || []),
    ...(error?.response?.data?.error?.errors || [])
  ].map(item => item?.reason);
  return reasons.some(reason => ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded'].includes(reason)) ||
    /quota/i.test(String(error?.message || ''));
}

class YouTubeSearchBudget {
  constructor(db, { now = () => new Date() } = {}) {
    this.db = db;
    this.now = now;
  }

  day() {
    return this.now().toISOString().slice(0, 10);
  }

  async used() {
    return Number(await this.db.getSetting(`youtube_search_calls:${this.day()}`)) || 0;
  }

  async remaining() {
    if (await this.db.getSetting(`youtube_search_exhausted:${this.day()}`) === 'true') return 0;
    return Math.max(0, dailyLimit() - await this.used());
  }

  // One search.list call, counted before it is made (a failed call still costs quota).
  async search(youtube, params) {
    if (await this.remaining() <= 0) {
      const error = new Error('Daily YouTube search budget spent');
      error.code = 'SEARCH_BUDGET';
      throw error;
    }
    const day = this.day();
    await this.db.setSetting(`youtube_search_calls:${day}`, String(await this.used() + 1));
    try {
      return await youtube.search.list(params);
    } catch (error) {
      if (quotaExceeded(error)) {
        await this.db.setSetting(`youtube_search_exhausted:${day}`, 'true');
        error.code = 'SEARCH_BUDGET';
      }
      throw error;
    }
  }
}

module.exports = { YouTubeSearchBudget, dailyLimit, quotaExceeded };
