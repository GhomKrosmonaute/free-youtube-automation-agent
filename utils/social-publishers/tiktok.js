// TikTok Content Posting API. "draft" mode (scope video.upload) drops the video in the creator's TikTok inbox,
// where one tap publishes it; "direct" mode (scope video.publish) posts it, but TikTok keeps every post of an
// unaudited app private, so switch TIKTOK_POST_MODE to direct once the app has passed TikTok's audit.
const fs = require('fs');
const crypto = require('crypto');
const { URLSearchParams } = require('url');
const axios = require('axios');
const { Logger } = require('../logger');

const API_BASE = 'https://open.tiktokapis.com';
const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const DEFAULT_SCOPES = ['user.info.basic', 'video.upload', 'video.publish'];
// Media transfer rules: one chunk of 5-64 MB (or the whole file under 5 MB); bigger files go in 10 MB chunks,
// the last one absorbing the remainder.
const SINGLE_CHUNK_LIMIT = 64 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;
const TOKEN_MARGIN_MS = 5 * 60 * 1000;

function chunkPlan(size) {
  if (size <= SINGLE_CHUNK_LIMIT) return { chunkSize: size, count: 1 };
  return { chunkSize: CHUNK_SIZE, count: Math.floor(size / CHUNK_SIZE) };
}

// TikTok's PKCE challenge is the hex SHA-256 of the verifier, not base64url.
function pkcePair() {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
  return { verifier, challenge };
}

function authorizeUrl({ clientKey, redirectUri, scopes = DEFAULT_SCOPES, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_key: clientKey,
    response_type: 'code',
    scope: scopes.join(','),
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256'
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function normalizeTokens(data, previous = {}) {
  const now = Date.now();
  return {
    ...previous,
    access_token: data.access_token,
    refresh_token: data.refresh_token || previous.refresh_token,
    open_id: data.open_id || previous.open_id,
    scope: data.scope || previous.scope,
    token_type: data.token_type || 'Bearer',
    expires_at: now + Number(data.expires_in || 86400) * 1000,
    refresh_expires_at: data.refresh_expires_in ? now + Number(data.refresh_expires_in) * 1000 : previous.refresh_expires_at
  };
}

async function requestToken(http, form) {
  const response = await http.request({
    method: 'POST',
    url: `${API_BASE}/v2/oauth/token/`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: new URLSearchParams(form).toString()
  });
  const data = response?.data || {};
  if (!data.access_token) {
    throw new Error(`TikTok token request failed: ${data.error_description || data.error || 'no access token returned'}`);
  }
  return data;
}

async function exchangeCode({ credentials, code, codeVerifier, http = axios }) {
  return normalizeTokens(await requestToken(http, {
    client_key: credentials.client_key,
    client_secret: credentials.client_secret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: credentials.redirect_uri,
    code_verifier: codeVerifier
  }));
}

class TikTokPublisher {
  constructor(options = {}) {
    this.platform = 'tiktok';
    this.credentials = options.credentials || null;
    this.tokens = options.tokens || null;
    this.saveTokens = options.saveTokens || (async () => {});
    this.http = options.http || axios;
    this.logger = options.logger || new Logger('TikTokPublisher');
    this.mode = (options.mode || process.env.TIKTOK_POST_MODE || 'draft').toLowerCase() === 'direct' ? 'direct' : 'draft';
    this.privacyLevel = options.privacyLevel || process.env.TIKTOK_PRIVACY_LEVEL || 'PUBLIC_TO_EVERYONE';
    this.pollIntervalMs = options.pollIntervalMs ?? 10000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 5 * 60 * 1000;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  isConfigured() {
    return Boolean(this.credentials?.client_key && this.credentials?.client_secret && this.tokens?.refresh_token);
  }

  async accessToken() {
    if (this.tokens?.access_token && Number(this.tokens.expires_at || 0) - TOKEN_MARGIN_MS > Date.now()) {
      return this.tokens.access_token;
    }
    // Access tokens last 24 hours; the refresh token (one year) renews them and may itself be rotated.
    this.tokens = normalizeTokens(await requestToken(this.http, {
      client_key: this.credentials.client_key,
      client_secret: this.credentials.client_secret,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refresh_token
    }), this.tokens);
    await this.saveTokens(this.tokens);
    return this.tokens.access_token;
  }

  async api(path, body = {}) {
    const token = await this.accessToken();
    let response;
    try {
      response = await this.http.request({
        method: 'POST',
        url: `${API_BASE}${path}`,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
        data: body
      });
    } catch (error) {
      const detail = error.response?.data?.error;
      const wrapped = new Error(`TikTok ${path} failed: ${detail?.message || detail?.code || error.message}`);
      wrapped.status = error.response?.status;
      throw wrapped;
    }
    const error = response?.data?.error;
    if (error && error.code && error.code !== 'ok') {
      throw new Error(`TikTok ${path} failed: ${error.message || error.code}`);
    }
    return response?.data?.data || {};
  }

  async publish({ videoPath, caption = '', containsSyntheticMedia = false }) {
    const size = (await fs.promises.stat(videoPath)).size;
    const plan = chunkPlan(size);
    const sourceInfo = { source: 'FILE_UPLOAD', video_size: size, chunk_size: plan.chunkSize, total_chunk_count: plan.count };
    let init;
    if (this.mode === 'direct') {
      const creator = await this.api('/v2/post/publish/creator_info/query/');
      const options = creator.privacy_level_options || [];
      const privacy = options.includes(this.privacyLevel) ? this.privacyLevel : (options.includes('SELF_ONLY') ? 'SELF_ONLY' : options[0]);
      if (!privacy) throw new Error('TikTok offered no privacy level for this account');
      if (privacy !== this.privacyLevel) this.logger.warn(`TikTok privacy ${this.privacyLevel} is not available for this account (unaudited app?); posting as ${privacy}`);
      init = await this.api('/v2/post/publish/video/init/', {
        post_info: {
          title: String(caption).slice(0, 2200),
          privacy_level: privacy,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
          is_aigc: containsSyntheticMedia === true
        },
        source_info: sourceInfo
      });
    } else {
      init = await this.api('/v2/post/publish/inbox/video/init/', { source_info: sourceInfo });
    }
    if (!init.publish_id || !init.upload_url) throw new Error('TikTok returned no upload URL');

    try {
      await this.upload(init.upload_url, videoPath, size, plan);
    } catch (error) {
      // A 4xx refusal of a chunk leaves no post behind; a dropped connection or a 5xx may have completed it.
      error.uploadStarted = !error.response || error.response.status >= 500;
      error.externalId = init.publish_id;
      throw error;
    }

    try {
      return await this.waitForStatus(init.publish_id);
    } catch (error) {
      if (!error.definitive) {
        error.uploadStarted = true;
        error.externalId = init.publish_id;
      }
      throw error;
    }
  }

  async upload(uploadUrl, videoPath, size, plan) {
    for (let index = 0; index < plan.count; index++) {
      const start = index * plan.chunkSize;
      const end = index === plan.count - 1 ? size - 1 : start + plan.chunkSize - 1;
      await this.http.request({
        method: 'PUT',
        url: uploadUrl,
        headers: {
          'Content-Type': 'video/mp4',
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`
        },
        data: fs.createReadStream(videoPath, { start, end }),
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
    }
  }

  async waitForStatus(publishId) {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const result = await this.fetchStatus(publishId);
      if (result.status !== 'processing' || Date.now() >= deadline) return result;
      await this.sleep(this.pollIntervalMs);
    }
  }

  // { status: 'published' | 'draft_sent' | 'processing', externalId, url, metadata }; throws on FAILED.
  async fetchStatus(publishId) {
    const data = await this.api('/v2/post/publish/status/fetch/', { publish_id: publishId });
    const metadata = { publishId };
    if (data.status === 'FAILED') {
      const error = new Error(`TikTok rejected the video: ${data.fail_reason || 'unknown reason'}`);
      error.definitive = true;
      throw error;
    }
    if (data.status === 'SEND_TO_USER_INBOX') return { status: 'draft_sent', externalId: publishId, url: null, metadata };
    if (data.status === 'PUBLISH_COMPLETE') {
      // The public post id only appears once TikTok's moderation has cleared the video.
      const postId = (data.publicaly_available_post_id || [])[0];
      const username = this.credentials?.username;
      return {
        status: 'published',
        externalId: postId ? String(postId) : publishId,
        url: postId && username ? `https://www.tiktok.com/@${username}/video/${postId}` : null,
        metadata
      };
    }
    return { status: 'processing', externalId: publishId, url: null, metadata };
  }

  async checkStatus(post) {
    return this.fetchStatus(post.metadata?.publishId || post.externalId);
  }
}

module.exports = { TikTokPublisher, chunkPlan, pkcePair, authorizeUrl, exchangeCode, normalizeTokens, DEFAULT_SCOPES };
