const fs = require('fs').promises;
const axios = require('axios');
const { Logger } = require('./logger');
const { parseChapters, validateChapters } = require('./chapters');
const { hasSubscribeCall } = require('./subscribe-cta');
const { confidenceThreshold } = require('./expert-review-service');
const jevClient = require('./jev');
const { isVertical, MAX_SHORT_SECONDS } = require('./vertical-short');

// The spoken sentences of a script (hook, sections, call to action).
function spokenSentences(script = {}) {
  const sections = script.mainContent?.sections || [];
  return [script.hook?.text, ...sections.flatMap(section => (Array.isArray(section.content) ? section.content : [section.content])), script.callToAction?.subscribe]
    .filter(text => typeof text === 'string' && text.trim())
    .flatMap(text => text.split(/(?<=[.!?…])\s+/))
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 12);
}

class OperatorService {
  constructor(db, options = {}) {
    this.db = db;
    this.logger = new Logger('OperatorService');
    this.jev = options.jev || jevClient;
  }

  // Jev approves a reaction in place of the operator (REACTIVE_APPROVAL=jev, the default): the facts were
  // verified by the fact-check and the tone by the tone guard (both blocking checks), and every passage quoted from the
  // examined video must be represented faithfully by the answer. Null when Jev is off or REACTIVE_APPROVAL=human: the
  // operator approves.
  async reactiveApproval(production) {
    if (!this.jev?.enabled?.() || String(process.env.REACTIVE_APPROVAL || 'jev').trim().toLowerCase() !== 'jev') return null;
    const passages = production.strategy?.examinedVideo?.passages || [];
    if (!passages.length) return { approved: false, reasons: ['aucun passage de la vidéo examinée à confronter à la réponse'], fidelity: [] };
    const answer = spokenSentences(production.script).join(' ').slice(0, 60000);
    const fidelity = [];
    for (const passage of passages) {
      const answers = await this.jev.ask({
        purpose: 'jev_approval',
        state: { quotedPassage: passage.text, answer },
        questions: {
          faithful: {
            type: 'noul',
            instructions: 'Does the answer quote or describe this passage of the examined video faithfully, without changing its meaning or taking it out of context?',
            criteria: {
              true: 'Faithful: the same words or the same meaning, in context',
              false: 'Left out, distorted, exaggerated, out of context, or credited with something it does not say'
            }
          }
        }
      });
      fidelity.push({ passage: passage.text, probability: Number(answers.faithful?.noul ?? 0) });
    }
    const weak = fidelity.filter(item => item.probability < 0.8);
    return {
      approved: weak.length === 0,
      fidelity,
      reasons: weak.map(item => `citation peut-être déformée ou absente : « ${item.passage.slice(0, 160)} » (${item.probability})`)
    };
  }

  // An answer to a named video must examine claims, never attack people: Jev reads every spoken sentence and returns
  // those that insult, label or attribute bad motives to a person or a group. Null when Jev is off.
  async personalAttacks(script) {
    if (!this.jev?.enabled?.()) return null;
    const sentences = spokenSentences(script);
    const flagged = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, sentences.length) }, async () => {
      while (next < sentences.length) {
        const sentence = sentences[next++];
        const answers = await this.jev.ask({
          purpose: 'tone_guard',
          state: { sentence },
          questions: {
            attack: {
              type: 'noul',
              instructions: 'Does this sentence attack a person or a group rather than discuss a claim?',
              criteria: {
                true: 'It insults, mocks, labels (liar, crook, fraud...) or attributes bad motives to a person, an audience or a community',
                false: 'It quotes, examines or explains a claim, a text or facts'
              }
            }
          }
        });
        if (Number(answers.attack?.noul ?? 0) >= 0.7) flagged.push(sentence);
      }
    }));
    return flagged;
  }

  async runQualityChecks(production, profile = {}) {
    const title = String(production.seo?.title || production.script?.title || '').trim();
    const description = String(production.seo?.description || '').trim();
    const tags = Array.isArray(production.seo?.tags) ? production.seo.tags : [];
    const script = String(production.script?.fullScript || '').trim();
    const finalVideo = production.assets?.finalVideo;
    const thumbnail = production.assets?.thumbnail;
    const bannedTopics = Array.isArray(profile.bannedTopics) ? profile.bannedTopics : [];
    const combinedText = `${title}\n${description}\n${script}`.toLowerCase();

    const checks = [
      this.check('title', title.length > 0 && title.length <= 100,
        title ? `Title is ${title.length}/100 characters` : 'A title is required'),
      this.check('description', description.length >= 50,
        description.length >= 50 ? 'Description is detailed enough' : 'Description should be at least 50 characters'),
      this.check('tags', tags.length >= 3,
        tags.length >= 3 ? `${tags.length} tags provided` : 'Add at least 3 relevant tags', false),
      this.check('script', script.length >= 200,
        script.length >= 200 ? 'Script content is present' : 'Script is missing or unusually short'),
      this.check('thumbnail', Boolean(thumbnail?.path) || isVertical(finalVideo),
        isVertical(finalVideo) ? 'A Short needs no thumbnail' : thumbnail?.path ? 'Thumbnail asset is present' : 'Thumbnail asset is missing', false),
      this.check('video', Boolean(finalVideo?.path && !finalVideo?.simulated),
        finalVideo?.simulated
          ? 'Only a simulated video was produced'
          : finalVideo?.path ? 'Final MP4 is ready' : 'Final MP4 is missing')
    ];

    // YouTube only shows chapters that follow its rules; the description must list them.
    const chapters = parseChapters(description);
    const knownChapters = Array.isArray(production.seo?.chapters) ? production.seo.chapters : [];
    const videoSeconds = Number(finalVideo?.duration) ||
      (production.scenes || []).reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0) ||
      Number(knownChapters[knownChapters.length - 1]?.end) || null;
    if (isVertical(finalVideo)) {
      // A Short has no chapters, and YouTube only counts a vertical video of three minutes or less as a Short.
      const seconds = Number(finalVideo.duration) || videoSeconds || 0;
      checks.push(this.check('short_duration', seconds > 0 && seconds <= MAX_SHORT_SECONDS,
        seconds > 0 && seconds <= MAX_SHORT_SECONDS
          ? `The Short lasts ${Math.round(seconds)} s (at most ${MAX_SHORT_SECONDS})`
          : `The Short lasts ${Math.round(seconds)} s: YouTube would not show it as a Short (at most ${MAX_SHORT_SECONDS} s)`));
    } else {
      const chapterErrors = validateChapters(chapters, videoSeconds);
      checks.push(this.check('chapters_valid', chapterErrors.length === 0,
        chapterErrors.length === 0
          ? `${chapters.length} chapters listed from 00:00, each at least 10 seconds long`
          : `The description's chapters would not show on YouTube: ${chapterErrors.join('; ')}`));
    }

    // Asking to subscribe is mandatory, out loud at the end of the video and in the description.
    const closing = (production.scenes || []).find(scene => /^call to action$/i.test(String(scene.label || '').trim()))?.scriptText ||
      production.script?.callToAction?.subscribe || production.script?.cta || '';
    checks.push(this.check('subscribe_cta_spoken', hasSubscribeCall(closing),
      hasSubscribeCall(closing) ? 'The closing narration asks the viewer to subscribe' : 'The closing narration never asks the viewer to subscribe'));
    checks.push(this.check('subscribe_cta_description', hasSubscribeCall(description),
      hasSubscribeCall(description) ? 'The description asks the viewer to subscribe' : 'The description has no subscribe line'));

    const topic = String(production.strategy?.topic || '').trim();
    if (topic) {
      const duplicates = await this.db.getRow(
        `SELECT COUNT(*) AS count FROM content_strategies
         WHERE lower(trim(topic)) = lower(trim(?))
         AND created_at >= datetime('now', '-90 days')`,
        [topic]
      );
      const unique = Number(duplicates?.count || 0) <= 1;
      checks.push(this.check('duplicate_topic', unique,
        unique
          ? 'No duplicate topic detected in the last 90 days'
          : 'This exact topic was already generated recently', false));
    }

    if (finalVideo?.path && !finalVideo?.simulated) {
      checks.push(this.check('video_file', await this.fileExists(finalVideo.path),
        'Final video file exists on disk'));
    }

    const audio = production.assets?.audio || {};
    const intentionalSilence = audio.intentionalSilence === true &&
      String(audio.silenceReason || '').trim().length >= 10 &&
      Boolean(audio.silenceConfirmedAt);
    const productionAudioReady = !audio.simulated && await this.fileExists(audio.path);
    const scenes = production.scenes || [];
    let sceneAudioReady = false;
    if (scenes.length) {
      const readiness = [];
      for (const scene of scenes) {
        readiness.push(scene.narrationStatus === 'intentional_silence' || (
          scene.narrationStatus === 'current' && await this.fileExists(scene.audioPath)
        ));
      }
      sceneAudioReady = readiness.every(Boolean);
    }
    const narrationReady = intentionalSilence || productionAudioReady || sceneAudioReady;
    checks.push(this.check('narration', narrationReady,
      intentionalSilence
        ? `Intentional silence confirmed: ${audio.silenceReason}`
        : narrationReady
          ? `Narration is ready${audio.provider ? ` via ${audio.provider}` : ''}`
          : audio.intentionalSilence
            ? 'Intentional silence requires an operator confirmation and reason of at least 10 characters'
            : 'Narration is missing or unusable; regenerate it before approval'));

    const matchedBannedTopics = bannedTopics.filter(topic =>
      topic && combinedText.includes(String(topic).toLowerCase())
    );
    checks.push(this.check('brand_policy', matchedBannedTopics.length === 0,
      matchedBannedTopics.length
        ? `Content matches blocked terms: ${matchedBannedTopics.join(', ')}`
        : 'No blocked brand topics detected'));

    const provenance = production.provenance || {};
    const provenancePassed = ['verified', 'not_required'].includes(provenance.status || 'not_required');
    const unresolved = Number(provenance.summary?.unresolvedClaims || 0);
    checks.push(this.check('provenance', provenancePassed,
      provenance.status === 'verified'
        ? `${provenance.summary?.resolvedClaims || 0} factual claims resolved against reviewed evidence`
        : provenance.status === 'not_required'
          ? 'No externally verifiable factual claims were declared'
          : `${unresolved} factual claim${unresolved === 1 ? '' : 's'} still require evidence review`));

    // A reaction names the video it answers: the answer must not attack its author or a community.
    if (production.strategy?.origin === 'reactive') {
      try {
        const attacks = await this.personalAttacks(production.script);
        if (attacks) {
          checks.push(this.check('respectful_tone', attacks.length === 0,
            attacks.length
              ? `${attacks.length} sentence${attacks.length === 1 ? '' : 's'} attack a person or a group rather than a claim: ${attacks.slice(0, 3).map(sentence => `« ${sentence} »`).join(' ')}`.slice(0, 1000)
              : 'Every spoken sentence examines claims, not people'));
        }
      } catch (error) {
        checks.push(this.check('respectful_tone', false, `The tone check could not run (${error.message.slice(0, 120)}); run it again before approval`));
      }
    }

    // A highly specialised script is only published once a human expert has approved it.
    const expert = production.script?.expertReview;
    if (expert?.required) {
      const approved = expert.status === 'approved';
      checks.push(this.check('expert_review', approved,
        approved
          ? `Script approved by an expert reviewer (${expert.domain || 'specialised subject'})`
          : `The script needs an expert review (${expert.domain || 'specialised subject'}) before approval`));
    }
    // Specialised passages the model was confident enough in to pass without an expert: shown to the approver.
    const autoValidated = expert?.autoValidated || [];
    if (autoValidated.length) {
      checks.push(this.check('expert_confidence', true,
        `Specialised passages validated without an expert (confidence above ${expert.confidenceThreshold ?? confidenceThreshold()}/10): ${autoValidated.map(item => `« ${item.excerpt} » ${item.confidence}/10`).join(' ; ')}`.slice(0, 1000), false));
    }
    // Imprecise figures the video assumes (no health stakes, not load-bearing): shown to the approver, never blocking.
    const approximations = expert?.approximations || [];
    if (approximations.length) {
      checks.push(this.check('assumed_approximations', true,
        `Assumed approximations, no health stakes: ${approximations.map(item => `« ${item.excerpt} »`).join(' ; ')}`.slice(0, 1000), false));
    }

    const discoverability = production.discoverability;
    if (discoverability) {
      const actionable = (discoverability.findings || []).filter(finding =>
        ['CRITICAL', 'HIGH'].includes(finding.severity) && finding.reviewStatus !== 'dismissed'
      );
      const available = discoverability.status !== 'unavailable';
      checks.push(this.check(
        'discoverability',
        available && actionable.length === 0,
        !available
          ? `DarkzSEO advisory audit is unavailable${discoverability.error ? `: ${discoverability.error}` : ''}`
          : actionable.length
            ? `${actionable.length} high-priority discoverability finding${actionable.length === 1 ? '' : 's'} await remediation or dismissal`
            : `${discoverability.findings?.length || 0} discoverability finding${discoverability.findings?.length === 1 ? '' : 's'} recorded; no unresolved high-priority findings`,
        false
      ));
    }

    if (scenes.length) {
      const invalidScenes = scenes.filter(scene =>
        !scene.assetPath || ['missing_asset', 'failed', 'generating', 'needs_rebuild', 'visual_stale'].includes(scene.status) ||
        !['current', 'intentional_silence'].includes(scene.narrationStatus)
      );
      const unlicensedUploads = scenes.filter(scene => scene.assetOrigin === 'uploaded' && !scene.rightsConfirmed);
      checks.push(this.check('scene_integrity', invalidScenes.length === 0,
        invalidScenes.length === 0
          ? `${scenes.length} scene${scenes.length === 1 ? '' : 's'} are rebuilt and current`
          : `${invalidScenes.length} scene${invalidScenes.length === 1 ? '' : 's'} still require repair or rebuild`));
      checks.push(this.check('scene_rights', unlicensedUploads.length === 0,
        unlicensedUploads.length === 0
          ? 'Replacement scene assets have rights confirmation'
          : `${unlicensedUploads.length} uploaded scene asset${unlicensedUploads.length === 1 ? '' : 's'} lack rights confirmation`));
    }

    const blockingFailures = checks.filter(check => check.blocking && !check.passed);
    return {
      passed: blockingFailures.length === 0,
      score: Math.round((checks.filter(check => check.passed).length / checks.length) * 100),
      blockingFailures: blockingFailures.map(check => check.id),
      checks
    };
  }

  check(id, passed, message, blocking = true) {
    return { id, passed: Boolean(passed), blocking, message };
  }

  async fileExists(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  async notify(notification) {
    const enabled = await this.db.getSetting('notification_enabled');
    if (enabled === 'false') return null;

    const id = await this.db.createNotification(notification);
    const webhookUrl = process.env.NOTIFICATION_WEBHOOK_URL;
    if (webhookUrl) {
      try {
        await axios.post(webhookUrl, {
          text: `${notification.title}: ${notification.message}`,
          content: `${notification.title}: ${notification.message}`,
          ...notification
        }, { timeout: 5000 });
      } catch (error) {
        this.logger.warn(`Notification webhook failed: ${error.message}`);
      }
    }
    return id;
  }
}

module.exports = { OperatorService, spokenSentences };
