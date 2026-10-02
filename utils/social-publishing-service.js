// Publishes approved Shorts to TikTok and Instagram Reels at the same time as on YouTube. Neither API schedules
// posts, so each platform gets a social_posts row that the 15-minute publish cron sends when it is due.
const fs = require('fs').promises;
const { Logger } = require('./logger');
const { TikTokPublisher } = require('./social-publishers/tiktok');
const { InstagramPublisher } = require('./social-publishers/instagram');
const { buildSocialCaption } = require('./social-publishers/caption');

const MAX_ATTEMPTS = 3;

// Publishers built from config/credentials.json and config/tokens.json; refreshed tokens are written back.
function createSocialPublishers(credentialManager, options = {}) {
  const credentials = credentialManager?.credentials || {};
  const tokens = credentialManager?.tokens || {};
  const persist = platform => async value => {
    if (credentialManager?.saveTokenFor) await credentialManager.saveTokenFor(platform, value);
  };
  return {
    tiktok: new TikTokPublisher({ credentials: credentials.tiktok, tokens: tokens.tiktok, saveTokens: persist('tiktok'), logger: options.logger }),
    instagram: new InstagramPublisher({ credentials: credentials.instagram, tokens: tokens.instagram, saveTokens: persist('instagram'), logger: options.logger })
  };
}

class SocialPublishingService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = options.logger || new Logger('SocialPublishing');
    this.publishers = options.publishers || {};
    this.maxAttempts = options.maxAttempts || MAX_ATTEMPTS;
  }

  // SOCIAL_PLATFORMS lists the targets (YouTube is handled by the publishing agent); a platform without
  // credentials is skipped.
  enabledPlatforms() {
    const wanted = String(process.env.SOCIAL_PLATFORMS || 'youtube').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
    return [...new Set(wanted)].filter(platform => platform !== 'youtube' && this.publishers[platform]?.isConfigured?.());
  }

  async enqueueShort({ clip, publishTime, containsSyntheticMedia = false, profile = null }) {
    const platforms = this.enabledPlatforms();
    if (!clip?.id || !clip.outputPath || !platforms.length) return [];
    const when = new Date(publishTime || clip.publishTime || Date.now());
    const caption = buildSocialCaption({ title: clip.title, description: clip.description, tags: clip.tags, profile });
    for (const platform of platforms) {
      await this.db.saveSocialPost({
        shortClipId: clip.id,
        productionId: clip.productionId,
        platform,
        status: 'scheduled',
        publishTime: (Number.isNaN(when.getTime()) ? new Date() : when).toISOString(),
        metadata: { caption, videoPath: clip.outputPath, title: clip.title, containsSyntheticMedia: containsSyntheticMedia === true }
      });
    }
    return this.listForClip(clip.id);
  }

  async processQueue(now = new Date()) {
    const summary = { published: 0, drafts: 0, processing: 0, failed: 0, reconciliation: 0 };
    // Uploads and status polling can outlast the 15-minute cron: a run that overlapped the previous one could post
    // the same Short twice.
    if (this.running) return summary;
    this.running = true;
    try {
      for (const post of await this.db.getDueSocialPosts(now.toISOString())) {
        const outcome = await this.publishPost(post);
        if (outcome) summary[outcome] += 1;
      }
      for (const post of await this.db.getProcessingSocialPosts()) {
        const outcome = await this.refreshPost(post);
        if (outcome && outcome !== 'processing') summary[outcome] += 1;
      }
    } finally {
      this.running = false;
    }
    return summary;
  }

  async publishPost(post) {
    const publisher = this.publishers[post.platform];
    if (!publisher?.isConfigured?.()) return null;
    const clip = await this.db.getShortClip(post.shortClipId);
    if (!clip || clip.status === 'cancelled') {
      await this.db.updateSocialPost(post.id, { status: 'cancelled', error: 'The Short was cancelled' });
      return null;
    }
    // A Short paused on YouTube stays unpublished everywhere.
    if (clip.status === 'paused' || clip.inheritedEvidence?.ready === false) return null;

    const attempts = Number(post.attempts || 0) + 1;
    try {
      await fs.access(post.metadata.videoPath);
    } catch (_error) {
      return this.recordFailure(post, attempts, new Error('The rendered Short MP4 is missing'));
    }
    await this.db.updateSocialPost(post.id, { status: 'uploading', attempts, error: null });
    try {
      const result = await publisher.publish({
        videoPath: post.metadata.videoPath,
        caption: post.metadata.caption,
        containsSyntheticMedia: post.metadata.containsSyntheticMedia === true
      });
      return await this.recordResult(post, result);
    } catch (error) {
      return this.recordFailure(post, attempts, error);
    }
  }

  async refreshPost(post) {
    const publisher = this.publishers[post.platform];
    if (!publisher?.isConfigured?.()) return null;
    try {
      return await this.recordResult(post, await publisher.checkStatus(post));
    } catch (error) {
      if (error.uploadStarted || error.definitive) return this.recordFailure(post, this.maxAttempts, error);
      // A status check that could not reach the platform says nothing about the post: check again next run.
      this.logger.warn(`${post.platform} status check failed for ${post.shortClipId}: ${String(error.message).slice(0, 200)}`);
      return 'processing';
    }
  }

  async recordResult(post, result) {
    await this.db.updateSocialPost(post.id, {
      status: result.status,
      externalId: result.externalId || post.externalId || null,
      url: result.url || post.url || null,
      metadata: { ...post.metadata, ...(result.metadata || {}) },
      error: null
    });
    if (result.status === 'published') this.logger.info(`Short published on ${post.platform}: ${post.metadata.title || post.shortClipId}`);
    if (result.status === 'draft_sent') this.logger.info(`Short sent to the ${post.platform} inbox, publish it from the app: ${post.metadata.title || post.shortClipId}`);
    return { published: 'published', draft_sent: 'drafts', processing: 'processing' }[result.status] || null;
  }

  // An upload whose outcome is unknown is never retried: it could post the Short twice.
  async recordFailure(post, attempts, error) {
    const message = String(error.message || error).slice(0, 500);
    if (error.uploadStarted) {
      await this.db.updateSocialPost(post.id, { status: 'reconciliation_required', attempts, externalId: error.externalId || post.externalId || null, error: message });
      this.logger.warn(`${post.platform} upload outcome unknown for ${post.shortClipId}; check the account before retrying: ${message}`);
      return 'reconciliation';
    }
    const retry = attempts < this.maxAttempts;
    await this.db.updateSocialPost(post.id, { status: retry ? 'scheduled' : 'failed', attempts, error: message });
    this.logger.warn(`${post.platform} publication ${retry ? 'will be retried' : 'failed'} for ${post.shortClipId}: ${message}`);
    return retry ? null : 'failed';
  }

  async listForClip(clipId) {
    return this.db.listSocialPostsForClip(clipId);
  }
}

module.exports = { SocialPublishingService, createSocialPublishers };
