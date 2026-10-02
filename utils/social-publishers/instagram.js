// Instagram Reels through the Instagram API with Instagram Login (graph.instagram.com): a Business or Creator
// account, no Facebook Page. The MP4 goes up with a resumable upload, so it needs no public URL.
const fs = require('fs');
const axios = require('axios');
const { Logger } = require('../logger');

const GRAPH_VERSION = process.env.INSTAGRAM_GRAPH_VERSION || 'v25.0';
const GRAPH_ROOT = 'https://graph.instagram.com';
const GRAPH_BASE = `${GRAPH_ROOT}/${GRAPH_VERSION}`;
const RUPLOAD_BASE = `https://rupload.facebook.com/ig-api-upload/${GRAPH_VERSION}`;
const DAY_MS = 24 * 3600 * 1000;
// Long-lived tokens last 60 days and can be refreshed once they are a day old: refresh in the last 10 days.
const REFRESH_WINDOW_MS = 10 * DAY_MS;
// A token pasted from the Meta dashboard comes without its expiry: assume it expires early so it gets refreshed.
const ASSUMED_LIFETIME_MS = 50 * DAY_MS;

function graphError(error, step) {
  const detail = error.response?.data?.error;
  const wrapped = new Error(`Instagram ${step} failed: ${detail?.message || error.message}`);
  wrapped.status = error.response?.status;
  return wrapped;
}

class InstagramPublisher {
  constructor(options = {}) {
    this.platform = 'instagram';
    this.credentials = options.credentials || null;
    this.tokens = options.tokens || null;
    this.saveTokens = options.saveTokens || (async () => {});
    this.http = options.http || axios;
    this.logger = options.logger || new Logger('InstagramPublisher');
    this.shareToFeed = options.shareToFeed ?? process.env.INSTAGRAM_SHARE_TO_FEED !== 'false';
    this.pollIntervalMs = options.pollIntervalMs ?? 15000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 10 * 60 * 1000;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  isConfigured() {
    return Boolean(this.tokens?.access_token && this.tokens?.user_id);
  }

  async accessToken() {
    const expiresAt = Number(this.tokens.expires_at || 0);
    if (expiresAt && expiresAt - Date.now() < REFRESH_WINDOW_MS) {
      try {
        const response = await this.http.request({
          method: 'GET',
          url: `${GRAPH_ROOT}/refresh_access_token`,
          params: { grant_type: 'ig_refresh_token', access_token: this.tokens.access_token }
        });
        const data = response?.data || {};
        if (!data.access_token) throw new Error('no access token returned');
        this.tokens = {
          ...this.tokens,
          access_token: data.access_token,
          expires_at: Date.now() + Number(data.expires_in || 60 * 24 * 3600) * 1000
        };
        await this.saveTokens(this.tokens);
      } catch (error) {
        // Still usable until it expires: publish now and retry the refresh on the next post.
        if (expiresAt <= Date.now()) throw graphError(error, 'token refresh');
        this.logger.warn(`Instagram token refresh failed, ${Math.ceil((expiresAt - Date.now()) / DAY_MS)} day(s) left: ${graphError(error, 'token refresh').message}`);
      }
    }
    return this.tokens.access_token;
  }

  async graph(method, path, params = {}, step = path) {
    const token = await this.accessToken();
    try {
      const response = await this.http.request({
        method,
        url: `${GRAPH_BASE}${path}`,
        params: { ...params, access_token: token }
      });
      return response?.data || {};
    } catch (error) {
      throw graphError(error, step);
    }
  }

  async publish({ videoPath, caption = '', containsSyntheticMedia = false }) {
    const size = (await fs.promises.stat(videoPath)).size;
    const container = await this.graph('POST', `/${this.tokens.user_id}/media`, {
      media_type: 'REELS',
      upload_type: 'resumable',
      caption: String(caption).slice(0, 2200),
      share_to_feed: this.shareToFeed,
      ...(containsSyntheticMedia === true ? { is_ai_generated: true } : {})
    }, 'container creation');
    if (!container.id) throw new Error('Instagram returned no media container');

    const token = await this.accessToken();
    try {
      await this.http.request({
        method: 'POST',
        url: container.uri || `${RUPLOAD_BASE}/${container.id}`,
        headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' },
        data: fs.createReadStream(videoPath),
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
    } catch (error) {
      // An uploaded container is never published on its own: retrying with a new container is safe.
      throw graphError(error, 'video upload');
    }
    return this.finish(container.id);
  }

  // Waits for the container (or checks it once), then publishes it. Only the publish call can leave an unknown
  // outcome behind.
  async finish(containerId, { wait = true } = {}) {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const state = await this.graph('GET', `/${containerId}`, { fields: 'status_code,status' }, 'status check');
      if (state.status_code === 'FINISHED') break;
      if (state.status_code === 'PUBLISHED') {
        // Published by an earlier attempt whose answer was lost: needs a human to find the post.
        const error = new Error('Instagram container was already published');
        error.uploadStarted = true;
        error.externalId = containerId;
        throw error;
      }
      if (['ERROR', 'EXPIRED'].includes(state.status_code)) {
        const error = new Error(`Instagram could not process the video: ${state.status || state.status_code}`);
        error.definitive = true;
        throw error;
      }
      if (!wait || Date.now() >= deadline) return { status: 'processing', externalId: containerId, url: null, metadata: { containerId } };
      await this.sleep(this.pollIntervalMs);
    }

    let published;
    try {
      published = await this.graph('POST', `/${this.tokens.user_id}/media_publish`, { creation_id: containerId }, 'publication');
    } catch (error) {
      error.uploadStarted = !error.status || error.status >= 500;
      error.externalId = containerId;
      throw error;
    }
    let url = null;
    try {
      url = (await this.graph('GET', `/${published.id}`, { fields: 'permalink' }, 'permalink')).permalink || null;
    } catch (error) {
      this.logger.warn(error.message);
    }
    return { status: 'published', externalId: String(published.id), url, metadata: { containerId } };
  }

  async checkStatus(post) {
    return this.finish(post.metadata?.containerId || post.externalId, { wait: false });
  }
}

module.exports = { InstagramPublisher, GRAPH_BASE, GRAPH_ROOT, GRAPH_VERSION, ASSUMED_LIFETIME_MS };
