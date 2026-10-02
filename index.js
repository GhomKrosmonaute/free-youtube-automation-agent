require('dotenv').config();

const express = require('express');
const autoFactChecker = require('./utils/auto-fact-checker');
const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const { OperatorService } = require('./utils/operator-service');
const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
const { ActivationMetrics } = require('./utils/activation-metrics');
const { AnonymousTelemetry } = require('./utils/anonymous-telemetry');
const { ProductionReadinessService } = require('./utils/production-readiness-service');
const { GenerationRecoveryService, GENERATION_STAGES } = require('./utils/generation-recovery-service');
const { ProvenanceService } = require('./utils/provenance-service');
const { SceneRepairService } = require('./utils/scene-repair-service');
const { ShortsRepurposingService } = require('./utils/shorts-repurposing-service');
const { SocialPublishingService, createSocialPublishers } = require('./utils/social-publishing-service');
const { AudienceEngagementService } = require('./utils/audience-engagement-service');
const { GrowthExperimentService } = require('./utils/growth-experiment-service');
const { AITextService } = require('./utils/ai-text-service');
const { DiscoverabilityService } = require('./utils/discoverability-service');
const { ExpertReviewService } = require('./utils/expert-review-service');
const aiUsage = require('./utils/ai-usage');
const { MAX_DESCRIPTION_LENGTH } = require('./utils/youtube-metadata-validator');
const { chapterSpans, titleChapters, formatChapterBlock, formatTimestamp, replaceChapterBlock, stripTimestamps } = require('./utils/chapters');
const { subscribeLine } = require('./utils/subscribe-cta');
const { scriptScenes } = require('./utils/scene-repair-service');
const { getTechnique } = require('./utils/techniques');
const { deploySite, siteLink, baseUrl: siteBaseUrl } = require('./utils/claims-site');
const { TopicGapFinder } = require('./utils/topic-gap-finder');
const { ReactiveWatch, partPassages } = require('./utils/reactive-watch');
const { compileSeries, seriesOf, isVertical } = require('./utils/vertical-short');
const { isReactMode, contentMode } = require('./utils/content-mode');
const { WatchList } = require('./utils/watch-list');
const { ChannelDiscovery } = require('./utils/channel-discovery');
const { mention, allowedMentions, alertWebhookUrl, md } = require('./utils/discord-alert');
const axios = require('axios');

// Where a video's subject comes from: the regular plan, a measured gap, a reaction, or the lesson cadence.
const GENERATION_ORIGINS = ['planned', 'gap', 'reactive', 'lesson'];

// The generation context a saved strategy was made with, to generate it again the same way.
function strategyContextOf(strategy = {}) {
  const context = {
    angle: strategy.angle,
    rationale: strategy.planRationale,
    pillar: strategy.contentPillar,
    technique: getTechnique(strategy.technique)?.id,
    origin: GENERATION_ORIGINS.includes(strategy.origin) ? strategy.origin : undefined,
    gapId: strategy.gapId,
    reactiveId: strategy.reactiveId,
    claim: strategy.examinedClaimHint
  };
  const limits = { angle: 500, rationale: 1000, pillar: 100, gapId: 100, reactiveId: 100, claim: 500 };
  const kept = Object.fromEntries(Object.entries(context)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => [key, limits[key] ? value.trim().slice(0, limits[key]) : value]));
  // A vertical Short, and its place in a series.
  if (strategy.format === 'short') {
    const { part, parts } = seriesOf(strategy);
    Object.assign(kept, { format: 'short', ...(parts > 1 ? { part, parts } : {}) });
  }
  return kept;
}
const { version } = require('./package.json');
const chalk = require('chalk');

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
    this.activeJobs = new Map();
    this.operator = null;
    this.autonomous = null;
    this.activation = null;
    this.telemetry = null;
    this.readiness = null;
    this.recovery = null;
    this.provenance = null;
    this.scenes = null;
    this.shorts = null;
    this.social = null;
    this.engagement = null;
    this.experiments = null;
    this.discoverability = null;
    this.expertReview = null;
    this.setupRequired = false;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold(`\n🎬 YouTube Automation Agent v${version}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      await this.db.markInterruptedJobs();
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
      this.operator = new OperatorService(this.db);
      this.provenance = new ProvenanceService(this.db);
      this.discoverability = new DiscoverabilityService(this.db, { logger: this.logger });
      this.autonomous = new AutonomousChannelOperator(this.db, {
        researchAndPlan: strategy => {
          if (!this.agents.strategy) throw new Error('The strategy agent is not configured');
          return this.agents.strategy.researchAndPlanChannel(strategy);
        },
        startGenerationJob: input => this.startGenerationJob(input),
        resumeGenerationJob: (jobId, options) => this.resumeGenerationJob(jobId, options),
        waitForGenerationJob: jobId => this.waitForGenerationJob(jobId),
        notify: notification => this.operator.notify(notification)
      });
      this.activation = new ActivationMetrics(this.db);
      this.telemetry = new AnonymousTelemetry(this.db, this.logger);
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      this.readiness = new ProductionReadinessService(this.db, this.credentials);
      // Subjects where the channel adds something: claims widely defended on YouTube and rarely answered.
      this.gapFinder = new TopicGapFinder(this.db, {
        watchList: () => this.watchList,
        youtube: () => this.credentials.getYouTubeClient(),
        aiText: new AITextService(this.credentials?.credentials || {}),
        logger: this.logger
      });
      // React mode: the watched channels (at most 20, scored on the audience's reaction to the answers), found every week
      // by web search when the react profile has discovery categories, and their new videos answered while they circulate.
      this.watchList = new WatchList(this.db, { logger: this.logger });
      this.discovery = new ChannelDiscovery(this.db, {
        youtube: () => this.credentials.getYouTubeClient(),
        watchList: this.watchList,
        logger: this.logger
      });
      this.reactive = new ReactiveWatch(this.db, {
        youtube: () => this.credentials.getYouTubeClient(),
        aiText: new AITextService(this.credentials?.credentials || {}),
        logger: this.logger
      });
      this.expertReview = new ExpertReviewService(this.db, {
        logger: this.logger,
        aiTextService: new AITextService(this.credentials?.credentials || {}),
        resumeJob: (jobId, options) => this.resumeGenerationJob(jobId, options)
      });
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        this.setupRequired = true;
        this.setupAPI();
        this.isInitialized = true;
        this.logger.warn('Dashboard started in setup mode; generation and publishing are disabled');
        return true;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();
      this.scenes = this.agents.production?.sceneRepair || new SceneRepairService(
        this.db,
        this.agents.production?.aiVideoGenerator,
        { logger: this.logger }
      );
      this.social = new SocialPublishingService(this.db, {
        logger: this.logger,
        publishers: createSocialPublishers(this.credentials, { logger: this.logger })
      });
      this.shorts = new ShortsRepurposingService(this.db, this.agents.publishing, {
        logger: this.logger,
        aiTextService: new AITextService(this.credentials?.credentials || {}),
        social: this.social
      });
      this.engagement = new AudienceEngagementService(
        this.db,
        this.credentials,
        new AITextService(this.credentials?.credentials || {}),
        { logger: this.logger }
      );
      this.experiments = new GrowthExperimentService(
        this.db,
        this.agents.analytics,
        this.agents.publishing,
        { logger: this.logger }
      );

      // Show which pipeline stages will run for real vs. be simulated
      const capabilities = await this.logCapabilitySummary();
      if (capabilities.hasText && capabilities.hasFFmpeg && capabilities.hasUpload) {
        await this.activation.markSetupReady(capabilities);
      }
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db, {
        generateContent: input => this.queueScheduledContent(input),
        startAutonomousRun: () => this.startAutonomousRun(),
        autoShorts: () => this.runAutoShorts(),
        measureShorts: () => this.shorts?.measurePerformance(this.agents.analytics),
        expertReviews: () => this.expertReview?.tick(),
        updateSite: () => this.updateSite(),
        // Topic gaps, channel discovery and watch scores belong to react mode.
        refreshGaps: () => (isReactMode() ? this.refreshTopicGaps() : null),
        runReactive: () => this.runReactive(),
        resumeInterrupted: () => this.resumeInterruptedJobs(),
        pollReactive: () => this.pollReactive(),
        discoverChannels: () => (this.discovery && isReactMode() ? this.discovery.run() : null),
        refreshWatchScores: () => (isReactMode() ? this.watchList?.refreshScores() : null),
        engagement: this.engagement,
        experiments: this.experiments,
        social: this.social
      });
      await this.scheduler.initialize();

      if (await this.db.getSetting('automation_paused') === 'true') {
        await this.scheduler.pauseAutomation();
      }
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');

      // Continuous mode would otherwise wait for the next 10-minute cron tick before its first run. Scripts an expert
      // approved while the server was down resume first, ahead of a new run.
      if (this.scheduler.isEnabled) {
        void this.scheduler.runExpertReviews().then(() => this.scheduler.runReactive())
          .then(() => this.scheduler.runInterrupted()).then(() => this.scheduler.runContinuousOperator());
      }

      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };
    this.agents.publishing.onPublished = entry => this.handlePublished(entry);

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }
  }

  async logCapabilitySummary() {
    const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');
    const creds = this.credentials.credentials || {};

    const hasText = this.credentials.hasAITextProvider();
    const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
    const hasImages = Boolean(creds.openai?.apiKey || process.env.OPENAI_API_KEY || hasGemini);
    const hasTTS = Boolean(
      creds.openai?.apiKey || process.env.OPENAI_API_KEY ||
      creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY ||
      creds.azureSpeech?.subscriptionKey || process.env.AZURE_SPEECH_KEY ||
      hasGemini ||
      ['macos_say', 'kokoro', 'chatterbox'].includes(String(process.env.TTS_PROVIDER || '').toLowerCase())
    );
    const hasFFmpeg = await checkFFmpeg();
    const hasUpload = Boolean(creds.youtube && this.credentials.tokens?.youtube);

    const capabilities = [
      { name: 'Script & strategy generation', ok: hasText, hint: 'configure an AI provider (npm run credentials:setup)' },
      { name: 'Image generation (visuals/thumbnails)', ok: hasImages, hint: 'requires an OpenAI or Gemini API key — otherwise gradient slides are used' },
      { name: 'Voice narration (TTS)', ok: hasTTS, hint: 'configure OpenAI, Gemini, ElevenLabs, or Azure Speech — otherwise videos are silent' },
      { name: 'Video assembly (FFmpeg)', ok: hasFFmpeg, hint: ffmpegInstallHint() },
      { name: 'YouTube upload', ok: hasUpload, hint: 'run: npm run credentials:setup' }
    ];

    console.log(chalk.cyan('\n🔎 Capability check:'));
    for (const cap of capabilities) {
      if (cap.ok) {
        console.log(chalk.green(`  ✓ ${cap.name}`));
      } else {
        console.log(chalk.yellow(`  ✗ ${cap.name} — ${cap.hint}`));
      }
    }

    if (!hasFFmpeg) {
      this.logger.warn('FFmpeg is missing: no .mp4 files can be produced until it is installed.');
    }
    console.log('');
    return { hasText, hasImages, hasTTS, hasFFmpeg, hasUpload };
  }

  requireAPIKey() {
    return (req, res, next) => {
      if (!process.env.API_KEY) {
        return next();
      }

      if (req.get('x-api-key') !== process.env.API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      return next();
    };
  }

  validateGenerateRequestBody(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { valid: false, status: 400, error: 'Request body must be a JSON object' };
    }

    const value = {
      topic: null,
      style: null,
      length: typeof body.length === 'string' ? body.length.toLowerCase() : 'medium',
      strategyContext: null
    };

    // JSON has no `undefined`, so clients send `null` to mean "no value provided".
    // Both are treated as "not set" here: topic/style are optional and default to
    // auto-selection, which is exactly what `null` already represents internally.
    if (body.topic !== undefined && body.topic !== null) {
      if (typeof body.topic !== 'string') {
        return { valid: false, status: 400, error: 'topic must be a string' };
      }

      const topic = body.topic.trim();
      if (topic.length > 200) {
        return { valid: false, status: 400, error: 'topic must be 200 characters or less' };
      }
      value.topic = topic || null;
    }

    if (body.style !== undefined && body.style !== null) {
      if (typeof body.style !== 'string') {
        return { valid: false, status: 400, error: 'style must be a string' };
      }

      const allowedStyles = new Set([
        'tutorial',
        'explainer',
        'list',
        'review',
        'story',
        // The lesson format belongs to react mode.
        ...(isReactMode() ? ['lesson'] : []),
        'educational',
        'informative',
        'engaging',
        'professional',
        'ethereal'
      ]);
      const style = body.style.trim();

      if (style.length > 50) {
        return { valid: false, status: 400, error: 'style must be 50 characters or less' };
      }
      if (style.toLowerCase() === 'lesson' && !isReactMode()) {
        return { valid: false, status: 400, error: 'The lesson format needs CONTENT_MODE=react' };
      }

      value.style = allowedStyles.has(style.toLowerCase()) ? style.toLowerCase() : style || null;
    }

    if (!['short', 'medium', 'long'].includes(value.length)) {
      return { valid: false, status: 400, error: 'length must be short, medium, or long' };
    }

    if (body.strategyContext !== undefined && body.strategyContext !== null) {
      if (typeof body.strategyContext !== 'object' || Array.isArray(body.strategyContext)) {
        return { valid: false, status: 400, error: 'strategyContext must be an object' };
      }
      const limits = { angle: 500, rationale: 1000, audience: 500, objective: 1000, valueProposition: 1000, constraints: 2000, pillar: 100 };
      value.strategyContext = {};
      for (const [key, max] of Object.entries(limits)) {
        if (body.strategyContext[key] === undefined || body.strategyContext[key] === null) continue;
        if (typeof body.strategyContext[key] !== 'string' || body.strategyContext[key].length > max) {
          return { valid: false, status: 400, error: `strategyContext.${key} must be a string of ${max} characters or less` };
        }
        value.strategyContext[key] = body.strategyContext[key].trim();
      }
      // Where the subject comes from and what it teaches, carried to the production (public site, learning loop).
      const context = body.strategyContext;
      if (context.technique !== undefined && context.technique !== null) {
        if (!getTechnique(context.technique)) return { valid: false, status: 400, error: 'strategyContext.technique must be a known technique id' };
        value.strategyContext.technique = getTechnique(context.technique).id;
      }
      if (context.origin !== undefined && context.origin !== null) {
        if (!GENERATION_ORIGINS.includes(context.origin)) return { valid: false, status: 400, error: `strategyContext.origin must be one of ${GENERATION_ORIGINS.join(', ')}` };
        value.strategyContext.origin = context.origin;
      }
      for (const [key, max] of Object.entries({ gapId: 100, reactiveId: 100, claim: 500 })) {
        if (context[key] === undefined || context[key] === null) continue;
        if (typeof context[key] !== 'string' || context[key].length > max) {
          return { valid: false, status: 400, error: `strategyContext.${key} must be a string of ${max} characters or less` };
        }
        value.strategyContext[key] = context[key].trim();
      }
      // A vertical Short (format "short"), part `part` of `parts` of a series.
      if (context.format !== undefined && context.format !== null) {
        if (context.format !== 'short') return { valid: false, status: 400, error: 'strategyContext.format must be "short"' };
        value.strategyContext.format = 'short';
      }
      for (const key of ['part', 'parts']) {
        if (context[key] === undefined || context[key] === null) continue;
        if (!Number.isInteger(context[key]) || context[key] < 1 || context[key] > 10) {
          return { valid: false, status: 400, error: `strategyContext.${key} must be an integer from 1 to 10` };
        }
        value.strategyContext[key] = context[key];
      }
    }

    return { valid: true, value };
  }

  validateChannelStrategy(body = {}, current = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Channel strategy must be a JSON object');
    }
    const text = (key, fallback, max) => {
      const value = String(body[key] ?? fallback ?? '').trim();
      if (value.length > max) throw new Error(`${key} must be ${max} characters or less`);
      return value;
    };
    const objective = text('objective', current.objective, 1000);
    const audience = text('audience', current.audience, 500);
    if (!objective) throw new Error('A channel objective is required');
    if (!audience) throw new Error('A target audience is required');

    const rawPillars = body.contentPillars ?? current.contentPillars ?? [];
    if (!Array.isArray(rawPillars)) throw new Error('contentPillars must be an array');
    const contentPillars = rawPillars.map(value => String(value).trim()).filter(Boolean);
    if (!contentPillars.length || contentPillars.length > 8 || contentPillars.some(value => value.length > 100)) {
      throw new Error('Provide 1 to 8 content pillars, each 100 characters or less');
    }

    const integer = (key, fallback, min, max) => {
      const value = Number(body[key] ?? fallback);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be an integer from ${min} to ${max}`);
      }
      return value;
    };
    const defaultFormat = text('defaultFormat', current.default_format || 'explainer', 20).toLowerCase();
    const defaultLength = text('defaultLength', current.default_length || 'medium', 20).toLowerCase();
    const status = text('status', current.status || 'draft', 20).toLowerCase();
    const primaryKpi = text('primaryKpi', current.primary_kpi || 'views', 30).toLowerCase();
    const outcomeCurrency = text('outcomeCurrency', current.outcome_currency || 'USD', 3).toUpperCase();
    if (!['explainer', 'tutorial', 'list', 'review', 'story'].includes(defaultFormat)) {
      throw new Error('defaultFormat is not supported');
    }
    if (!['short', 'medium', 'long'].includes(defaultLength)) throw new Error('defaultLength is not supported');
    if (!['draft', 'active', 'paused'].includes(status)) throw new Error('status must be draft, active, or paused');
    // Persuasion (the comments' stances, react profile) is measured in react mode only.
    if (!['views', 'watch_hours', 'subscribers', 'engagement', 'revenue', ...(isReactMode() ? ['persuasion'] : [])].includes(primaryKpi)) {
      throw new Error('primaryKpi is not supported');
    }
    if (!/^[A-Z]{3}$/.test(outcomeCurrency)) throw new Error('outcomeCurrency must be a three-letter currency code');
    const optionalNumber = (key, fallback, min, max) => {
      const raw = body[key] ?? fallback;
      if (raw === undefined || raw === null || raw === '') return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${key} must be a number from ${min} to ${max}`);
      }
      return value;
    };

    return {
      objective,
      audience,
      valueProposition: text('valueProposition', current.value_proposition, 1000),
      contentPillars,
      cadencePerWeek: integer('cadencePerWeek', current.cadence_per_week || 1, 1, 7),
      videosPerRun: integer('videosPerRun', current.videos_per_run || 1, 1, 5),
      defaultFormat,
      defaultLength,
      successMetric: text('successMetric', current.success_metric, 300),
      primaryKpi,
      targetValue: optionalNumber('targetValue', current.target_value, 0.01, 1000000000),
      targetWindowDays: integer('targetWindowDays', current.target_window_days || 28, 7, 365),
      monthlyBudget: optionalNumber('monthlyBudget', current.monthly_budget, 0, 10000000),
      outcomeCurrency,
      constraints: text('constraints', current.constraints, 2000),
      status
    };
  }
  setupAPI() {
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.static(path.join(__dirname, 'dashboard')));

    if (!process.env.API_KEY) {
      this.logger.warn('API_KEY is not set; mutating API routes are unprotected');
    }
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: this.setupRequired ? 'setup_required' : 'healthy',
        initialized: this.isInitialized,
        setupRequired: this.setupRequired,
        agents: Object.keys(this.agents),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    // Manual content generation
    this.app.post('/generate', this.requireAPIKey(), async (req, res) => {
      try {
        if (this.setupRequired) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before generating content' });
        }
        const validation = this.validateGenerateRequestBody(req.body);
        if (!validation.valid) {
          return res.status(validation.status).json({ success: false, error: validation.error });
        }

        const { topic, style, length } = validation.value;
        const result = await this.startGenerationJob({ topic, style, length, source: 'manual' });
        res.status(202).json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        if (!this.agents.analytics) return res.json({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [], learning: null });
        const analytics = await this.agents.analytics.getRecentAnalytics();
        const learning = await this.agents.analytics.getLearningSummary();
        res.json({ ...analytics, learning });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/outcomes', async (_req, res) => {
      try {
        const learning = this.agents.analytics?.getLearningSummary
          ? await this.agents.analytics.getLearningSummary()
          : { outcome: null };
        return res.json({ success: true, result: learning.outcome || null });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', this.requireAPIKey(), async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ success: false, error: 'YouTube publishing is not configured' });
        const { contentId } = req.params;
        const bundle = await this.db.getProductionBundle(contentId);
        const short = bundle ? null : await this.db.getShortClip(contentId);
        if ((!bundle || bundle.review_status !== 'approved') && (!short || !['scheduled', 'uploading', 'reconciliation_required'].includes(short.status))) {
          return res.status(409).json({ success: false, error: 'Content must pass review and be approved before publishing' });
        }
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.setupOperatorAPI();
  }

  setupOperatorAPI() {
    const protect = this.requireAPIKey();

    this.app.get('/api/dashboard', async (_req, res) => {
      try {
        const [stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation, channelStrategy, operatorRuns, readiness, engagement, experiments] = await Promise.all([
          this.db.getStats(),
          this.db.listGenerationJobs(20),
          this.db.getPipelineOverview(50),
          this.db.getUpcomingSchedule(30),
          this.db.getRecentAutomationEvents(20),
          this.db.listNotifications(20),
          this.db.getChannelProfile(),
          this.db.getAllSettings(),
          this.db.listContentIdeas(),
          this.agents.analytics
            ? this.agents.analytics.getRecentAnalytics(30)
            : Promise.resolve({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] }),
          this.agents.analytics?.getLearningSummary
            ? this.agents.analytics.getLearningSummary()
            : Promise.resolve({ measuredVideos: 0, snapshotCount: 0, baseline: {}, recommendations: [], approvedCount: 0, pendingCount: 0 }),
          this.activation
            ? this.activation.getSummary()
            : Promise.resolve({ privacy: 'local-only', counts: {}, milestones: {} }),
          this.db.getChannelStrategy(),
          this.db.listOperatorRuns(10),
          this.readiness
            ? this.readiness.getSummary()
            : Promise.resolve({ status: 'unverified', stale: false, blockingFailures: [], checks: [] }),
          this.engagement
            ? this.engagement.getSummary()
            : Promise.resolve({
                videosTracked: 0, pendingDrafts: 0, postedToday: 0, needsAttentionCount: 0,
                pendingAudienceIdeas: 0, postingEnabled: false, postingDisabledReason: 'setup_required',
                insights: [], recentThemes: [],
                evidencePolicy: 'Comments are fetched read-only from YouTube. Replies post only after operator approval, and fallback analysis never proposes drafts or ideas.'
              }),
          this.experiments
            ? this.experiments.getSummary()
            : Promise.resolve({ experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0, evidencePolicy: 'Finish setup to create a controlled growth experiment.' })
        ]);
        if (this.telemetry) void this.telemetry.sync(activation);
        res.json({
          stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation,
          channelStrategy, operatorRuns, readiness, engagement, experiments,
          system: {
            initialized: this.isInitialized,
            contentMode: contentMode(),
            setupRequired: this.setupRequired,
            uptime: process.uptime(),
            activeJobs: this.activeJobs.size,
            automationPaused: this.scheduler ? !this.scheduler.isEnabled : true,
            agents: Object.keys(this.agents),
            autonomousRunning: Boolean(await this.db.getActiveOperatorRun()),
            videoProviders: this.agents.production?.aiVideoGenerator?.mediaGeneration?.listProviders() || []
          }
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/jobs/:jobId', async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      job.checkpoints = await this.db.listGenerationCheckpoints(job.id);
      job.mediaTasks = await this.db.listMediaGenerationTasks(job.id);
      job.resumeFrom = this.recovery?.resumePoint(job.checkpoints);
      return res.json(job);
    });

    this.app.post('/api/jobs/:jobId/resume', protect, async (req, res) => {
      try {
        const result = await this.resumeGenerationJob(req.params.jobId, { stage: req.body?.stage });
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    // Scripts on highly specialised subjects held for a human expert (also driven by npm run expert).
    this.app.get('/api/expert-reviews', async (req, res) => {
      if (!this.expertReview) return res.status(503).json({ success: false, error: 'Expert review is not initialized' });
      const status = ['pending', 'approved', 'revision_requested', 'rejected'].includes(req.query.status) ? req.query.status : null;
      const reviews = await this.db.listExpertReviews({ status, limit: 50 });
      return res.json({ success: true, result: reviews.map(({ script: _script, ...review }) => review) });
    });

    this.app.get('/api/expert-reviews/:reviewId', async (req, res) => {
      if (!this.expertReview) return res.status(503).json({ success: false, error: 'Expert review is not initialized' });
      const review = await this.db.getExpertReview(req.params.reviewId);
      if (!review) return res.status(404).json({ success: false, error: 'Expert review not found' });
      return res.json({ success: true, result: { ...review, markdown: this.expertReview.renderScript(review) } });
    });

    this.app.post('/api/expert-reviews/:reviewId/decision', protect, async (req, res) => {
      try {
        if (!this.expertReview) return res.status(503).json({ success: false, error: 'Expert review is not initialized' });
        const result = await this.expertReview.decide(req.params.reviewId, {
          decision: req.body?.decision,
          notes: req.body?.notes,
          reviewer: req.body?.reviewer
        });
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    // Assessed again under the current rules: approved automatically when no passage needs an expert any more.
    this.app.post('/api/expert-reviews/:reviewId/reassess', protect, async (req, res) => {
      try {
        if (!this.expertReview) return res.status(503).json({ success: false, error: 'Expert review is not initialized' });
        return res.json({ success: true, result: await this.expertReview.reassess(req.params.reviewId, { triage: req.body?.triage === true }) });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/readiness', async (_req, res) => {
      if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
      return res.json(await this.readiness.getSummary());
    });

    this.app.post('/api/readiness/run', protect, async (req, res) => {
      try {
        if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
        const result = await this.readiness.run({
          includePaidMedia: req.body?.includePaidMedia === true,
          includePaidVideo: req.body?.includePaidVideo === true
        });
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/jobs/:jobId/cancel', protect, async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (!['queued', 'running'].includes(job.status)) {
        return res.status(409).json({ error: 'Only queued or running jobs can be cancelled' });
      }
      const updated = await this.db.updateGenerationJob(job.id, { cancelRequested: true, details: { cancelReason: req.body?.reason || 'Cancelled by operator' } });
      return res.json({ success: true, result: updated });
    });

    this.app.get('/api/content/:productionId', async (req, res) => {
      let bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      if (this.scenes && !bundle.scenes?.length) {
        await this.scenes.ensureManifest(bundle);
        bundle = await this.db.getProductionBundle(req.params.productionId);
      }
      // Where each Short also went (TikTok, Instagram Reels).
      for (const clip of bundle.shorts || []) {
        clip.socialPosts = this.social ? await this.social.listForClip(clip.id).catch(() => []) : [];
      }
      return res.json(this.decorateContentBundle(bundle));
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/estimate', async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.regenerationEstimate(req.params.productionId, req.params.sceneId, {
          provider: req.query.provider
        });
        return res.json(result);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.patch('/api/content/:productionId/scenes/:sceneId', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.updateScene(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Scene changes require review before scheduling');
        return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/reorder', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.reorder(req.params.productionId, req.body?.sceneIds);
        await this.refreshContentReview(req.params.productionId, 'Timeline order changed; rebuild and review before scheduling');
        return res.json({ success: true, result: result.map(scene => this.scenes.decorateScene(scene, req.params.productionId)) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/regenerate', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.regenerate(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Regenerated scene must be rebuilt and reviewed');
        return res.status(202).json({ success: true, result: {
          ...result,
          scene: this.scenes.decorateScene(result.scene, req.params.productionId)
        } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/shorts/propose', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.propose(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/content/:productionId/shorts/:clipId', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.update(req.params.productionId, req.params.clipId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/shorts/:clipId/render', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.render(req.params.productionId, req.params.clipId);
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/shorts/:clipId/approve', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.approve(req.params.productionId, req.params.clipId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.get('/api/content/:productionId/shorts/:clipId/social', protect, async (req, res) => {
      try {
        const clip = await this.db.getShortClip(req.params.clipId);
        if (!clip || clip.productionId !== req.params.productionId) return res.status(404).json({ error: 'Short draft not found' });
        const posts = this.social ? await this.social.listForClip(clip.id) : [];
        return res.json({ success: true, posts: posts.map(({ metadata, ...post }) => ({ ...post, caption: metadata.caption })) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/content/:productionId/shorts/:clipId/asset/:kind', async (req, res) => {
      try {
        const clip = await this.db.getShortClip(req.params.clipId);
        if (!clip || clip.productionId !== req.params.productionId) return res.status(404).json({ error: 'Short asset not found' });
        const filePath = req.params.kind === 'video' ? clip.outputPath : req.params.kind === 'captions' ? clip.captionsPath : null;
        if (!filePath) return res.status(404).json({ error: 'Short asset not found' });
        const resolved = path.resolve(filePath);
        const shortsRoot = path.resolve(__dirname, 'data', 'shorts');
        if (!resolved.startsWith(`${shortsRoot}${path.sep}`)) return res.status(403).json({ error: 'Short asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Short asset not found' });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/narration', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.regenerateNarration(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Narration regenerated; rebuild the final video before approval');
        return res.status(202).json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/narration/silence', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.setSilenceOverride(req.params.productionId, req.body || {});
        await this.refreshContentReview(
          req.params.productionId,
          result.enabled ? 'Intentional silence recorded; rebuild and review before approval' : 'Narration is required again; regenerate it before approval'
        );
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.put(
      '/api/content/:productionId/scenes/:sceneId/asset',
      protect,
      express.raw({ type: ['image/*', 'video/*'], limit: '100mb' }),
      async (req, res) => {
        try {
          if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
          const result = await this.scenes.replaceAsset(req.params.productionId, req.params.sceneId, {
            buffer: req.body,
            contentType: req.get('content-type'),
            filename: req.get('x-file-name'),
            rightsConfirmed: req.get('x-rights-confirmed') === 'true',
            containsSyntheticMedia: req.get('x-synthetic-media') === 'true'
          });
          await this.refreshContentReview(req.params.productionId, 'Replacement scene asset must be rebuilt and reviewed');
          return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
        } catch (error) {
          return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
        }
      }
    );

    this.app.post('/api/content/:productionId/scenes/rebuild', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.rebuild(req.params.productionId);
        await this.refreshContentReview(req.params.productionId, 'Scene repair rebuilt; final approval is required');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/asset', async (req, res) => {
      try {
        const scene = await this.db.getProductionScene(req.params.productionId, req.params.sceneId);
        if (!scene?.assetPath) return res.status(404).json({ error: 'Scene asset not found' });
        const resolved = path.resolve(scene.assetPath);
        const dataRoot = path.resolve(__dirname, 'data');
        if (!resolved.startsWith(`${dataRoot}${path.sep}`)) return res.status(403).json({ error: 'Scene asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Scene asset not found' });
      }
    });

    this.app.patch('/api/content/:productionId', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' && bundle.schedule?.status === 'published') {
          return res.status(409).json({ error: 'Published content cannot be edited here' });
        }
        const editorData = this.validateEditorData(req.body, bundle.editorData);
        const result = await this.db.saveContentReview(bundle.id, {
          status: bundle.review_status || 'needs_review',
          editorData,
          qualityChecks: bundle.qualityChecks,
          reviewNotes: req.body.reviewNotes ?? bundle.review_notes,
          reviewedAt: bundle.reviewed_at
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/content/:productionId/approve', protect, async (req, res) => {
      try {
        const result = await this.approveContent(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, quality: error.quality });
      }
    });

    this.app.post('/api/content/:productionId/reject', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      await this.db.saveContentReview(bundle.id, {
        status: 'rejected',
        editorData: bundle.editorData,
        qualityChecks: bundle.qualityChecks,
        reviewNotes: req.body?.notes || 'Rejected by operator',
        reviewedAt: new Date().toISOString()
      });
      await this.db.updateProductionStatus(bundle.id, 'rejected');
      const reactive = await this.db.findReactiveItem?.({ productionId: bundle.id });
      if (reactive) await this.db.updateReactiveItem(reactive.id, { status: 'dismissed', error: req.body?.notes || 'Rejected by operator' });
      return res.json({ success: true });
    });

    this.app.post('/api/content/:productionId/retry', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      const job = await this.startGenerationJob({
        topic: bundle.strategy.topic || bundle.editorData.title || null,
        style: bundle.strategy.requestedStyle || bundle.strategy.contentType || null,
        length: bundle.strategy.requestedLengthKey || 'medium',
        // A retried reactive video stays reactive (and waits for approval), a lesson keeps its technique.
        strategyContext: strategyContextOf(bundle.strategy),
        source: 'retry'
      });
      return res.status(202).json({ success: true, result: job });
    });

    this.app.get('/api/content/:productionId/asset/:kind', async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        const allowed = {
          video: bundle.assets?.finalVideo?.path,
          thumbnail: bundle.assets?.thumbnail?.path,
          captions: bundle.assets?.captions?.path,
          script: bundle.assets?.script?.originalPath
        };
        const experimentMatch = req.params.kind.match(/^experiment-thumbnail-(\d+)$/);
        const experimentPath = experimentMatch
          ? bundle.editorData?.packagingExperiment?.thumbnailVariants?.[Number(experimentMatch[1])]?.path
          : null;
        const filePath = allowed[req.params.kind] || experimentPath;
        if (!filePath) return res.status(404).json({ error: 'Asset not found' });
        const resolved = path.resolve(filePath);
        const dataRoot = path.resolve(__dirname, 'data');
        const experimentRoot = path.resolve(__dirname, 'uploads', 'thumbnails');
        const allowedPath = [dataRoot, experimentRoot]
          .some(root => resolved.startsWith(`${root}${path.sep}`));
        if (!allowedPath) return res.status(403).json({ error: 'Asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Asset not found' });
      }
    });

    this.app.put('/api/profile', protect, async (req, res) => {
      try {
        const profile = this.validateProfile(req.body || {});
        return res.json({ success: true, result: await this.db.saveChannelProfile(profile) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.put('/api/operator/strategy', protect, async (req, res) => {
      try {
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy(req.body || {}, current);
        return res.json({ success: true, result: await this.db.saveChannelStrategy(strategy) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/start', protect, async (req, res) => {
      try {
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before activating the autonomous operator' });
        }
        if (this.activeJobs.size) {
          return res.status(409).json({ success: false, error: 'Wait for the current generation job to finish before starting an autonomous run' });
        }
        await this.readiness?.assertReady('Autonomous production');
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy({ ...(req.body || {}), status: 'active' }, current);
        const saved = await this.db.saveChannelStrategy(strategy);
        const run = await this.autonomous.start(saved);
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/pause', protect, async (_req, res) => {
      const strategy = await this.db.getChannelStrategy();
      if (!strategy) return res.status(404).json({ error: 'Channel strategy not found' });
      const active = await this.db.getActiveOperatorRun();
      if (active) await this.autonomous.cancel(active.id);
      const saved = await this.db.saveChannelStrategy({ ...strategy, status: 'paused' });
      return res.json({ success: true, result: saved });
    });

    this.app.post('/api/operator/runs/:runId/cancel', protect, async (req, res) => {
      const run = await this.autonomous.cancel(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Operator run not found' });
      return res.json({ success: true, result: run });
    });

    this.app.put('/api/content/:productionId/provenance', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' || bundle.schedule) {
          return res.status(409).json({ error: 'Provenance is locked after content is approved or scheduled' });
        }
        if (!this.provenance) this.provenance = new ProvenanceService(this.db);
        await this.provenance.review(bundle.id, req.body || {});
        const updated = await this.db.getProductionBundle(bundle.id);
        const profile = await this.db.getChannelProfile() || {};
        const quality = await this.operator.runQualityChecks({
          ...updated,
          scheduledPublishTime: updated.scheduled_publish_time
        }, profile);
        const reviewStatus = quality.passed ? 'needs_review' : 'needs_attention';
        const result = await this.db.saveContentReview(bundle.id, {
          status: reviewStatus,
          editorData: updated.editorData,
          qualityChecks: quality.checks,
          reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
          reviewedAt: null
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/runs/:runId/resume', protect, async (req, res) => {
      try {
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup before resuming the autonomous operator' });
        }
        await this.readiness?.assertReady('Autonomous production recovery');
        const strategy = await this.db.getChannelStrategy();
        const run = await this.autonomous.resume(req.params.runId, strategy);
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/learning/recommendations/:recommendationId/:action', protect, async (req, res) => {
      const { recommendationId, action } = req.params;
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be approve or reject' });
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      const recommendation = await this.db.reviewLearningRecommendation(recommendationId, status);
      if (!recommendation) return res.status(404).json({ error: 'Learning recommendation not found' });
      await this.operator.notify({
        type: 'learning_recommendation_reviewed',
        level: action === 'approve' ? 'success' : 'info',
        title: action === 'approve' ? 'Channel learning approved' : 'Channel learning rejected',
        message: recommendation.title,
        data: { recommendationId, status }
      });
      return res.json({ success: true, result: recommendation });
    });

    this.app.post('/api/content/:productionId/discoverability/run', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ success: false, error: 'Content not found' });
        const profile = await this.db.getChannelProfile() || {};
        const audit = await this.discoverability.auditProduction(bundle, profile, req.body?.platform || 'youtube');
        if (bundle.review_status !== 'approved' && !bundle.schedule) {
          const updated = await this.db.getProductionBundle(bundle.id);
          const quality = await this.operator.runQualityChecks({
            ...updated,
            scheduledPublishTime: updated.scheduled_publish_time
          }, profile);
          await this.db.saveContentReview(bundle.id, {
            status: quality.passed ? 'needs_review' : 'needs_attention',
            editorData: updated.editorData,
            qualityChecks: quality.checks,
            reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
            reviewedAt: null
          });
        }
        const result = await this.db.getProductionBundle(bundle.id);
        return res.json({ success: true, result: this.decorateContentBundle(result), audit });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.patch('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.rescheduleContent(req.params.productionId, req.body?.publishTime);
        await this.db.updateProductionStatus(req.params.productionId, 'scheduled');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/publish-now', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.emergencyPublish(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, result.status);
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.delete('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.deleteScheduledContent(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, 'approved');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/discoverability/findings/:findingId', protect, async (req, res) => {
      try {
        const finding = await this.discoverability.reviewFinding(req.params.findingId, req.body || {});
        const audit = await this.db.getLatestDiscoverabilityAudit(finding.production_id, finding.platform);
        return res.json({ success: true, result: { finding, audit } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/experiments', async (_req, res) => {
      try {
        const summary = this.experiments
          ? await this.experiments.getSummary()
          : { experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0 };
        return res.json({ success: true, result: summary });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/experiments', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before creating experiments' });
        const experiment = await this.experiments.create(req.body || {});
        return res.status(201).json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/experiments/:experimentId/:action', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before controlling experiments' });
        const actions = {
          approve: () => this.experiments.approve(req.params.experimentId, req.body),
          start: () => this.experiments.start(req.params.experimentId, req.body),
          refresh: () => this.experiments.refresh(req.params.experimentId),
          adopt: () => this.experiments.adoptWinner(req.params.experimentId, req.body),
          cancel: () => this.experiments.cancel(req.params.experimentId, req.body)
        };
        if (!actions[req.params.action]) return res.status(400).json({ error: 'Unsupported experiment action' });
        const experiment = await actions[req.params.action]();
        await this.operator.notify({
          type: 'growth_experiment_updated',
          level: ['adopt', 'approve'].includes(req.params.action) ? 'success' : 'info',
          title: `Growth experiment ${req.params.action}`,
          message: experiment.title,
          data: { experimentId: experiment.id, status: experiment.status }
        });
        return res.json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.get('/api/retention/:videoId', async (req, res) => {
      const videoId = String(req.params.videoId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
        return res.status(400).json({ error: 'A valid YouTube video ID is required' });
      }
      const snapshots = await this.db.listRetentionSnapshots({ videoId, limit: 10 });
      return res.json({ success: true, result: snapshots });
    });

    this.app.post('/api/retention/:videoId/refresh', protect, async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        const measurementWindow = String(req.body?.measurementWindow || 'rolling');
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        if (!['24h', '7d', 'rolling'].includes(measurementWindow)) {
          return res.status(400).json({ error: 'Measurement window must be 24h, 7d, or rolling' });
        }
        if (!this.agents.analytics) {
          return res.status(503).json({ error: 'YouTube Analytics is not initialized' });
        }
        const report = await this.agents.analytics.analyzeVideoPerformance(videoId, { measurementWindow });
        return res.json({
          success: true,
          result: report.retentionSnapshot || null,
          retention: report.retention
        });
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
      }
    });

    const ENGAGEMENT_VIDEO_ID = /^[A-Za-z0-9_-]{1,100}$/;

    this.app.get('/api/engagement/:videoId', async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const [insight, comments, drafts] = await Promise.all([
          this.db.getEngagementInsight(videoId),
          this.db.listAudienceComments({ videoId, limit: 200 }),
          this.db.listReplyDrafts({ videoId, limit: 100 })
        ]);
        return res.json({ success: true, result: { insight, comments, drafts } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/engagement/:videoId/sync', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const sync = await this.engagement.syncVideoComments(videoId, req.body || {});
        const insight = sync.fetched > 0 || req.body?.analyze === true
          ? await this.engagement.analyzeVideo(videoId)
          : sync.insight;
        return res.status(202).json({ success: true, result: { ...sync, insight } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/:videoId/draft-replies', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const result = await this.engagement.draftReplies(videoId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/engagement/replies/:draftId', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.updateReplyDraft(req.params.draftId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/replies/:draftId/approve', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.approveReplyDraft(req.params.draftId, req.body || {});
        // The reply is already live on YouTube; a notification failure must not report an error.
        try {
          await this.operator.notify({
            type: 'audience_reply_posted',
            level: 'success',
            title: 'Audience reply posted',
            message: `A reply was posted on video ${result.videoId}`,
            data: { draftId: result.id, videoId: result.videoId, postedCommentId: result.postedCommentId }
          });
        } catch (notifyError) {
          this.logger.warn(`Posted reply notification failed: ${notifyError.message}`);
        }
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/ideas', protect, async (req, res) => {
      const topic = String(req.body?.topic || '').trim();
      if (!topic || topic.length > 200) return res.status(400).json({ error: 'A topic of 200 characters or less is required' });
      const idea = await this.db.createContentIdea({ ...req.body, topic });
      return res.status(201).json({ success: true, result: idea });
    });

    this.app.patch('/api/ideas/:ideaId', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, req.body || {});
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      return res.json({ success: true, result: idea });
    });

    this.app.post('/api/ideas/:ideaId/generate', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, { status: 'generating' });
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      const job = await this.startGenerationJob({ topic: idea.topic, style: idea.style, length: req.body?.length || 'medium', source: 'idea' });
      await this.db.updateContentIdea(idea.id, { status: 'generated' });
      return res.status(202).json({ success: true, result: job });
    });

    this.app.post('/api/automation/:action', protect, async (req, res) => {
      if (!this.scheduler) return res.status(409).json({ error: 'Finish setup before controlling automation' });
      const { action } = req.params;
      if (action === 'pause') {
        await this.scheduler.pauseAutomation();
        await this.db.setSetting('automation_paused', 'true');
      } else if (action === 'resume') {
        await this.scheduler.resumeAutomation();
        await this.db.setSetting('automation_paused', 'false');
      } else {
        return res.status(400).json({ error: 'Action must be pause or resume' });
      }
      return res.json({ success: true, paused: !this.scheduler.isEnabled });
    });

    this.app.put('/api/settings', protect, async (req, res) => {
      const allowed = ['approval_required', 'notification_enabled', 'channel_timezone', 'max_daily_posts', 'content_buffer_days'];
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) await this.db.setSetting(key, String(req.body[key]));
      }
      const provider = req.body?.video_provider;
      if (provider !== undefined) {
        const supported = ['slideshow', 'auto', 'seedance', 'minimax_h3', 'google_omni', 'kling', 'wan'];
        if (!supported.includes(provider)) return res.status(400).json({ error: 'Unsupported video provider' });
        await this.db.setSetting('video_provider', provider);
      }
      const mode = req.body?.video_generation_mode;
      if (mode !== undefined) {
        if (!['hybrid', 'slideshow'].includes(mode)) return res.status(400).json({ error: 'Unsupported video generation mode' });
        await this.db.setSetting('video_generation_mode', mode);
      }
      if (req.body?.video_clip_duration !== undefined) {
        const value = Number(req.body.video_clip_duration);
        if (!Number.isInteger(value) || value < 3 || value > 30) return res.status(400).json({ error: 'Clip duration must be between 3 and 30 seconds' });
        await this.db.setSetting('video_clip_duration', String(value));
      }
      if (req.body?.video_max_generated_seconds !== undefined) {
        const value = Number(req.body.video_max_generated_seconds);
        if (!Number.isInteger(value) || value < 0 || value > 600) return res.status(400).json({ error: 'Generated seconds cap must be between 0 and 600' });
        await this.db.setSetting('video_max_generated_seconds', String(value));
      }
      return res.json({ success: true, result: await this.db.getAllSettings() });
    });

    this.app.post('/api/notifications/:notificationId/read', protect, async (req, res) => {
      await this.db.markNotificationRead(req.params.notificationId);
      return res.json({ success: true });
    });
  }

  async startGenerationJob(input = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before generating content');
      error.status = 503;
      throw error;
    }
    if (['scheduler', 'autonomous_operator', 'reactive'].includes(input.source)) {
      await this.readiness?.assertReady('Automated generation');
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    const starting = this.startingJobs || 0;
    if (this.activeJobs.size + starting >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size + starting}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }

    const validation = this.validateGenerateRequestBody(input);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.status = validation.status;
      throw error;
    }

    // The slot is taken before the first await: two callers (a reactive video, the operator) cannot both get it.
    this.startingJobs = starting + 1;
    try {
      const job = await this.db.createGenerationJob({
        ...validation.value,
        source: input.source || 'manual'
      });

      const work = this.runGenerationJob(job.id, validation.value)
        .catch(error => this.logger.error(`Generation job ${job.id} failed:`, error))
        .finally(() => this.activeJobs.delete(job.id));
      this.activeJobs.set(job.id, work);
      return job;
    } finally {
      this.startingJobs -= 1;
    }
  }

  async resumeGenerationJob(jobId, options = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before resuming content generation');
      error.status = 503;
      throw error;
    }
    const job = await this.db.getGenerationJob(jobId);
    if (!job) {
      const error = new Error('Generation job not found');
      error.status = 404;
      throw error;
    }
    // A job waiting for an expert resumes once the review is decided; resumed earlier, it waits again.
    if (!['failed', 'interrupted', 'waiting_expert'].includes(job.status)) {
      const error = new Error('Only failed, interrupted or expert-reviewed generation jobs can be resumed');
      error.status = 409;
      throw error;
    }
    if (this.activeJobs.has(job.id)) {
      const error = new Error('This generation job is already running');
      error.status = 409;
      throw error;
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }
    if (['scheduler', 'autonomous_operator', 'reactive'].includes(job.source)) {
      await this.readiness?.assertReady('Automated generation recovery');
    }

    const checkpoints = await this.db.listGenerationCheckpoints(job.id);
    const resumeFrom = options.stage || this.recovery.resumePoint(checkpoints);
    if (!GENERATION_STAGES.includes(resumeFrom)) {
      const error = new Error('Resume stage is not supported');
      error.status = 400;
      throw error;
    }
    if (options.stage) await this.recovery.resetFrom(job.id, resumeFrom);
    const input = {
      topic: job.topic,
      style: job.style,
      length: job.length || 'medium',
      strategyContext: job.details?.strategyContext || {}
    };
    const updated = await this.db.updateGenerationJob(job.id, {
      status: 'queued',
      stage: resumeFrom,
      error: null,
      cancelRequested: false,
      completedAt: null,
      details: {
        resumeCount: Number(job.details?.resumeCount || 0) + 1,
        resumeFrom,
        failedStage: null
      }
    });
    const work = this.runGenerationJob(job.id, input)
      .catch(error => this.logger.error(`Resumed generation job ${job.id} failed:`, error))
      .finally(() => this.activeJobs.delete(job.id));
    this.activeJobs.set(job.id, work);
    return updated;
  }

  async waitForGenerationJob(jobId) {
    const work = this.activeJobs.get(jobId);
    if (work) await work;
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Generation job ${jobId} was not found after it ran`);
    return job;
  }

  async queueScheduledContent(input = {}) {
    const strategy = await this.db.getChannelStrategy();
    if (strategy?.status === 'active') {
      // A viral claim waiting for an answer takes the next slot; the planned run comes after it.
      if (await this.reactiveWaiting()) return null;
      const weeklyOutput = await this.db.getRow(
        `SELECT COUNT(*) AS count FROM generation_jobs
         WHERE source = 'autonomous_operator' AND status = 'completed'
         AND created_at >= datetime('now', '-7 days')`
      );
      const remaining = Math.max(1, strategy.cadence_per_week - Number(weeklyOutput?.count || 0));
      return this.autonomous.start({
        ...strategy,
        videos_per_run: Math.min(strategy.videos_per_run, remaining)
      });
    }
    return this.startGenerationJob(input);
  }

  async runGenerationJob(jobId, input) {
    try {
      await this.db.updateGenerationJob(jobId, { status: 'running', progress: 2, error: null, completedAt: null });
      await this.trackSubject(input.strategyContext, 'planned');
      // Every model call of the video is recorded against its job (npm run ai-usage).
      const result = await aiUsage.withContext({ jobId }, () => this.generateContent(input.topic, input.style, input.length, {
        jobId,
        strategyContext: input.strategyContext
      }));
      await this.db.updateGenerationJob(jobId, {
        status: 'completed',
        stage: result.reviewStatus === 'approved' ? 'scheduled' : result.reviewStatus,
        progress: 100,
        productionId: result.contentId,
        title: result.title,
        details: { reviewStatus: result.reviewStatus, qualityScore: result.qualityScore },
        completedAt: new Date().toISOString()
      });
      await this.db.setSetting('last_content_generation', new Date().toISOString());
      await this.trackSubject(input.strategyContext, 'covered', result.contentId);
      return result;
    } catch (error) {
      // Not a failure: the script waits for an expert, who was alerted by the review stage.
      if (error.code === 'EXPERT_REVIEW_PENDING') {
        await this.db.updateGenerationJob(jobId, {
          status: 'waiting_expert',
          stage: 'expert_review',
          error: null,
          details: { expertReviewId: error.reviewId },
          completedAt: null
        });
        this.logger.info(`Generation job ${jobId} is waiting for expert review ${error.reviewId}`);
        return { held: true, reviewId: error.reviewId };
      }
      const cancelled = error.code === 'JOB_CANCELLED';
      const current = await this.db.getGenerationJob(jobId);
      const failedStage = current?.stage || 'starting';
      await this.db.updateGenerationJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: failedStage,
        error: error.message,
        details: { failedStage },
        completedAt: new Date().toISOString()
      });
      await this.trackSubject(input.strategyContext, 'open');
      await this.operator.notify({
        type: cancelled ? 'generation_cancelled' : 'generation_failure',
        level: cancelled ? 'warning' : 'error',
        title: cancelled ? 'Generation cancelled' : 'Generation failed',
        message: error.message,
        data: { jobId }
      });
      throw error;
    }
  }

  // Measures new topic gaps for the active channel strategy, within the daily YouTube search budget.
  async refreshTopicGaps(options = {}) {
    const strategy = await this.db.getChannelStrategy();
    if (!this.gapFinder || strategy?.status !== 'active') return { measured: 0, gaps: [] };
    return this.gapFinder.refresh(strategy, options);
  }

  // Where the subject came from follows its video: a measured gap is planned while it is made, covered once it is,
  // and open again if it fails (a video held for an expert stays planned).
  async trackSubject(context = {}, status, productionId = null) {
    if (context?.gapId && this.db.updateTopicGap) {
      await this.db.updateTopicGap(context.gapId, { status, productionId })
        .catch(error => this.logger.warn(`Topic gap ${context.gapId} could not be updated: ${error.message}`));
    }
    // A reactive item: generating, then waiting for the operator's review, or failed. A part of a series that is done
    // waits for the next part (next_part), which starts once this one is approved.
    if (context?.reactiveId && this.db.updateReactiveItem) {
      const { part, parts } = seriesOf(context);
      const reactive = status === 'covered' && part < parts ? 'next_part' : { planned: 'generating', covered: 'review', open: 'failed' }[status];
      const item = productionId ? await this.db.getReactiveItem?.(context.reactiveId).catch(() => null) : null;
      const episodes = item ? (item.episodes || []).map(episode => (episode.part === part ? { ...episode, productionId } : episode)) : undefined;
      await this.db.updateReactiveItem(context.reactiveId, { status: reactive, ...(productionId ? { productionId } : {}), ...(episodes ? { episodes } : {}) })
        .catch(error => this.logger.warn(`Reactive item ${context.reactiveId} could not be updated: ${error.message}`));
    }
  }

  // Videos already started are never lost: a job interrupted by a restart or a crash is resumed where it stopped, one
  // at a time when the generation slot is free, before the operator plans anything new. Reactive jobs are resumed by
  // runReactive; a job already resumed three times is left to the operator.
  async resumeInterruptedJobs() {
    if (this.setupRequired || !this.agents.strategy) return null;
    if (this.activeJobs.size || this.startingJobs || this.autonomous?.activeRuns?.size) return null;
    const rows = await this.db.getAllRows(
      "SELECT id, source, details FROM generation_jobs WHERE status = 'interrupted' AND source != 'reactive' ORDER BY created_at ASC"
    );
    for (const row of rows) {
      let details = {};
      try { details = JSON.parse(row.details || '{}'); } catch (_error) { /* unreadable details: resumed anyway */ }
      if (Number(details.resumeCount || 0) >= 3) continue;
      try {
        const job = await this.resumeGenerationJob(row.id);
        this.logger.info(`Resumed interrupted job ${row.id}`);
        return job;
      } catch (error) {
        if (error.status === 429) return null;
        this.logger.warn(`Interrupted job ${row.id} could not be resumed: ${error.message}`);
      }
    }
    return null;
  }

  async reactiveWaiting() {
    if (!this.reactive?.enabled?.() || !this.db.listReactiveItems) return false;
    return (await this.db.listReactiveItems({ status: ['queued', 'next_part'], limit: 1 }).catch(() => [])).length > 0;
  }

  // Every hour: new videos of the watched channels that spread fast and defend a claim become reactive items.
  async pollReactive() {
    const strategy = await this.db.getChannelStrategy();
    if (!this.reactive?.enabled() || strategy?.status !== 'active') return { created: [] };
    return this.reactive.poll(strategy);
  }

  // The 10-minute tick, before the operator: expires stale items, resumes an interrupted reactive job, then starts the
  // oldest queued item as soon as no job, job start or operator run holds the generation slot.
  async runReactive() {
    if (!this.reactive?.enabled() || this.setupRequired || !this.agents.strategy) return null;
    for (const item of await this.reactive.expire()) {
      await this.operator.notify({ type: 'reactive_expired', level: 'warning', title: 'Reactive video expired', message: `${item.topic}: no longer an urgent answer`, data: { reactiveId: item.id } });
    }
    const busy = async () => this.activeJobs.size || this.startingJobs || this.autonomous?.activeRuns?.size || await this.db.getActiveOperatorRun?.();
    for (const item of await this.db.listReactiveItems({ status: 'generating' })) {
      const job = item.jobId ? await this.db.getGenerationJob(item.jobId) : null;
      if (job?.status === 'interrupted' && !(await busy())) return this.resumeGenerationJob(job.id);
      if (['failed', 'cancelled'].includes(job?.status)) await this.db.updateReactiveItem(item.id, { status: 'failed', error: job.error || job.status });
    }
    // The next part of a series, once the previous one is approved (scheduled or out), so the parts come out in order.
    for (const item of await this.db.listReactiveItems({ status: 'next_part' })) {
      const previous = (item.episodes || []).reduce((last, episode) => (!last || episode.part > last.part ? episode : last), null);
      const entry = previous?.productionId ? await this.db.getLatestScheduleEntry(previous.productionId).catch(() => null) : null;
      if (!['scheduled', 'publishing', 'published'].includes(entry?.status) || await busy()) continue;
      return this.startReactivePart(item, previous.part + 1);
    }
    const [next] = await this.db.listReactiveItems({ status: 'queued', limit: 1 });
    if (!next || await busy()) return null;
    return this.startReactivePart(next, 1);
  }

  // A reaction is a vertical Short, also posted to TikTok and Instagram Reels; when its arguments do not fit
  // in one (Jev, utils/reactive-watch.js), it is a series, one part at a time.
  async startReactivePart(item, part) {
    const parts = Math.max(1, item.parts || 1);
    const job = await this.startGenerationJob({
      topic: item.topic,
      style: 'explainer',
      length: 'short',
      source: 'reactive',
      strategyContext: {
        origin: 'reactive',
        reactiveId: item.id,
        claim: item.claim,
        format: 'short',
        ...(parts > 1 ? { part, parts } : {}),
        rationale: 'Affirmation qui circule en ce moment : y répondre pendant qu\'elle se diffuse.'
      }
    });
    const episodes = [...(item.episodes || []).filter(episode => episode.part !== part), { part, jobId: job.id }].sort((a, b) => a.part - b.part);
    await this.db.updateReactiveItem(item.id, { status: 'generating', jobId: job.id, episodes });
    this.logger.info(`Reactive Short started for « ${item.claim} »${parts > 1 ? ` (part ${part}/${parts})` : ''} (job ${job.id})`);
    return job;
  }

  // A video on YouTube gets its page on the public verification site; a Short cut out of a long video does not.
  // A reaction is published once all its parts are, and a series is then joined into one 16:9 video.
  async handlePublished(entry) {
    if (entry.metadata?.shortClipId) return;
    this.requestSiteUpdate();
    const reactive = await this.db.findReactiveItem?.({ productionId: entry.productionId });
    if (!reactive) return;
    if (entry.metadata?.contentType === 'short') await this.shareShort(entry);
    if ((await this.publishedParts(reactive)).length < reactive.parts) return;
    await this.db.updateReactiveItem(reactive.id, { status: 'published' });
    if (reactive.parts > 1 && !reactive.compilationId) {
      await this.compileReactiveSeries(reactive.id)
        .catch(error => this.logger.warn(`The series ${reactive.id} could not be joined into one video: ${error.message.slice(0, 200)}`));
    }
  }

  // The parts of an answer already on YouTube, in order.
  async publishedParts(item) {
    const published = [];
    for (const episode of (item.episodes || []).slice().sort((a, b) => a.part - b.part)) {
      if (!episode.productionId) continue;
      const entry = await this.db.getLatestScheduleEntry(episode.productionId).catch(() => null);
      if (entry?.status === 'published') published.push({ ...episode, entry });
    }
    return published;
  }

  // A Short that stands alone also goes to TikTok and Instagram Reels (SOCIAL_PLATFORMS), when they are configured.
  async shareShort(entry) {
    if (!this.social || !entry.metadata?.video?.path) return [];
    const seo = entry.metadata.seo || {};
    const profile = await this.db.getChannelProfile().catch(() => null);
    return this.social.enqueueShort({
      clip: { id: entry.productionId, productionId: entry.productionId, outputPath: entry.metadata.video.path, title: seo.title || entry.title, description: seo.description || '', tags: seo.tags || [] },
      publishTime: new Date().toISOString(),
      containsSyntheticMedia: entry.metadata.containsSyntheticMedia === true,
      profile
    }).catch(error => {
      this.logger.warn(`Short ${entry.productionId} not queued for the other platforms: ${error.message.slice(0, 160)}`);
      return [];
    });
  }

  // Once every part of a series is out, the parts are joined end to end into one 16:9 video (each vertical frame over a
  // blurred copy of itself), chaptered by part, and published like the parts were: they were each approved.
  async compileReactiveSeries(reactiveId) {
    const item = await this.db.getReactiveItem(reactiveId);
    if (!item || item.parts < 2 || item.compilationId) return null;
    const published = await this.publishedParts(item);
    if (published.length < item.parts) return null;
    const bundles = [];
    for (const episode of published) {
      const bundle = await this.db.getProductionBundle(episode.productionId);
      if (!bundle?.assets?.finalVideo?.path) throw new Error(`Part ${episode.part} has no video file`);
      bundles.push({ bundle, entry: episode.entry, part: episode.part });
    }
    const id = `prod_series_${String(item.id).replace(/^reactive_/, '')}`;
    const video = await compileSeries(
      bundles.map(({ bundle }) => ({ path: bundle.assets.finalVideo.path, duration: bundle.assets.finalVideo.duration, captionsPath: bundle.assets.captions?.path })),
      path.join(__dirname, 'data', 'videos', `${id}_final.mp4`)
    );
    const partTitle = ({ bundle, entry }) => String(entry.metadata?.seo?.title || bundle.seo?.title || bundle.script?.title || '').trim();
    const title = (partTitle(bundles[0]).replace(/\s*[(（]\s*partie\s*\d+\s*\/\s*\d+\s*[)）]\s*$/i, '').trim() || item.topic).slice(0, 100);
    // Chapters: one per part, timed on the parts as they were published.
    let at = 0;
    const chapters = [];
    for (const { bundle, part } of bundles) {
      const length = Number(bundle.assets.finalVideo.duration) || 0;
      chapters.push({ start: Math.round(at), end: Math.round(at + length), title: `Partie ${part}` });
      at += length;
    }
    const profile = await this.db.getChannelProfile().catch(() => ({})) || {};
    const first = bundles[0].bundle;
    const examined = first.strategy?.examinedVideo;
    const sources = new Map();
    for (const { bundle } of bundles) {
      const provenance = await this.db.getContentProvenance?.(bundle.id).catch(() => null);
      for (const source of (provenance?.sources || []).filter(entry => entry.status === 'verified')) sources.set(source.url, source);
    }
    const description = [
      `Les ${bundles.length} parties de cette réponse, réunies en une vidéo.`,
      bundles.map(({ entry, part, ...rest }) => `▶️ Partie ${part} : ${partTitle({ entry, ...rest })} : ${entry.youtubeUrl}`).join('\n'),
      subscribeLine(profile.call_to_action, await this.youtubeChannelId()),
      examined?.url ? `📌 Vidéo examinée : « ${examined.title} » (${examined.channel}) : ${examined.url}` : null,
      this.chapterBlock(chapters) || null,
      sources.size ? `SOURCES (vérifiées)\n${[...sources.values()].slice(0, 12).map(source => `• ${source.title}${source.publisher ? ` (${source.publisher})` : ''} : ${source.url}`).join('\n')}` : null
    ].filter(Boolean).join('\n\n').slice(0, 5000);
    const strategy = { ...first.strategy, format: null, part: null, parts: null, seriesOf: bundles.map(({ bundle }) => bundle.id) };
    const seo = { ...(first.seo || {}), title, description, chapters, tags: (first.seo?.tags || []).filter(tag => tag !== 'Shorts') };
    const compilation = {
      id,
      status: 'ready',
      strategy,
      script: { ...(first.script || {}), title },
      thumbnail: null,
      seo,
      assets: {
        finalVideo: { path: video.path, format: 'mp4', aspectRatio: video.aspectRatio, resolution: video.resolution, duration: video.duration },
        audio: { path: video.path, compiled: true },
        captions: video.captionsPath ? { path: video.captionsPath, format: 'srt', language: process.env.CONTENT_LANGUAGE || 'fr' } : null,
        thumbnail: null
      },
      timeline: { created: new Date().toISOString(), readyForUpload: new Date().toISOString() },
      scheduledPublishTime: new Date().toISOString(),
      priority: 'high',
      estimatedDuration: video.duration,
      privacyStatus: bundles[0].entry.metadata?.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
      containsSyntheticMedia: bundles[0].entry.metadata?.containsSyntheticMedia === true,
      contentType: 'long_form'
    };
    await this.db.saveProductionData(compilation);
    await this.db.saveProductionSnapshot(compilation);
    await this.db.saveContentReview(id, {
      status: 'approved',
      reviewNotes: `Assemblage automatique des ${bundles.length} parties publiées (chacune approuvée)`,
      reviewedAt: new Date().toISOString()
    });
    await this.db.updateReactiveItem(item.id, { compilationId: id });
    const entry = await this.agents.publishing.scheduleContent(compilation);
    await this.db.updateProductionStatus(id, entry ? 'scheduled' : 'ready');
    await this.operator.notify({
      type: 'reactive_series_compiled', level: 'info', title: 'Series joined into one video',
      message: `${title}: ${bundles.length} parts, ${Math.round(video.duration)} s`, data: { reactiveId: item.id, contentId: id }
    });
    this.logger.info(`Series ${item.id} joined into ${id} (${bundles.length} parts, ${video.duration}s)`);
    return { id, entry };
  }

  // The operator decides fast: the claim, how fast the video it answers spreads, and the commands.
  async alertReactive(strategy, script, contentId, quality, jevApproval = null) {
    const item = strategy.reactiveId ? await this.db.getReactiveItem(strategy.reactiveId).catch(() => null) : null;
    const url = alertWebhookUrl();
    if (!url) {
      this.logger.warn(`Reactive video ${contentId} is ready for review but no alert webhook is set (EXPERT_REVIEW_WEBHOOK_URL)`);
      return;
    }
    const ping = mention();
    const source = item?.video || {};
    const blocking = quality.passed ? null : `⚠️ **Contrôles bloquants** : ${md(quality.blockingFailures.join(', '))}`;
    const approved = Boolean(jevApproval?.approved);
    const jevLine = approved
      ? `✅ **Approuvée par Jev** : faits vérifiés, ton vérifié, ${jevApproval.fidelity.length} citation(s) fidèle(s) (min ${Math.min(...jevApproval.fidelity.map(item => item.probability))})`
      : jevApproval?.reasons?.length ? `⚠️ **Jev n'a pas approuvé** : ${md(jevApproval.reasons.join(' ; ')).slice(0, 600)}` : null;
    const lines = [
      approved ? '## ⚡ Réponse publiée automatiquement' : '## ⚡ Réponse prête à valider',
      strategy.format === 'short' ? `-# Short${seriesOf(strategy).parts > 1 ? `, partie ${seriesOf(strategy).part}/${seriesOf(strategy).parts} : la suivante est produite une fois celle-ci approuvée` : ''}` : null,
      `${ping.tags.length ? `${ping.tags.join(' ')} ` : ''}**« ${md(script.title)} »**`,
      '',
      `**Affirmation** : ${md(item?.claim || strategy.examinedClaimHint || '')}`,
      source.url ? `**Vidéo d'origine** : ${md(source.channel || '')}, ${Number(source.views || 0).toLocaleString('fr-FR')} vues (${Number(source.viewsPerHour || 0).toLocaleString('fr-FR')} par heure) : <${source.url}>` : null,
      blocking,
      jevLine,
      '',
      ...(approved ? [
        '-# Publication dans le quart d\'heure. Une erreur repérée après coup : `npm run errata -- add <youtubeId> "correction"`.'
      ] : [
        '### Décision',
        `✅ Publier tout de suite : \`npm run reactive -- approve ${contentId}\``,
        `🗑️ Abandonner : \`npm run reactive -- reject ${contentId}\``,
        '-# Revue complète dans le tableau de bord.'
      ])
    ].filter(line => line !== null);
    const content = lines.join('\n').slice(0, 1900);
    try {
      await axios.post(url, { content, text: content.replace(/\*\*|`|## |### |-# /g, ''), allowed_mentions: allowedMentions(ping), event: approved ? 'reactive_auto_approved' : 'reactive_review_required', contentId }, { timeout: 15000 });
    } catch (error) {
      this.logger.warn(`Reactive alert failed for ${contentId}: ${error.message}`);
    }
  }

  async updateJobStage(jobId, stage, progress, details = {}) {
    if (!jobId) return;
    const job = await this.db.getGenerationJob(jobId);
    if (job?.cancelRequested) {
      const error = new Error(job.details?.cancelReason || 'Generation cancelled by operator');
      error.code = 'JOB_CANCELLED';
      throw error;
    }
    await this.db.updateGenerationJob(jobId, { stage, progress, details });
  }

  async generateContent(topic = null, style = null, length = 'medium', options = {}) {
    this.logger.info('Starting content generation pipeline...');
    const { jobId = null, strategyContext: rawStrategyContext = {} } = options;
    const strategyContext = rawStrategyContext || {};
    const profile = await this.db.getChannelProfile() || {};
    const lengthLabels = { short: '2-4 minutes', medium: '8-12 minutes', long: '15-20 minutes' };

    // Step 1: Strategy
    const strategy = await this.runGenerationStage(jobId, 'strategy', 10, async () => {
      const generated = await this.agents.strategy.generateContentStrategy(topic);
      const contentStyles = new Set(['tutorial', 'explainer', 'list', 'review', 'story', ...(isReactMode() ? ['lesson'] : [])]);
      const requestedStyle = style || profile.default_style || null;
      if (requestedStyle && contentStyles.has(requestedStyle.toLowerCase())) {
        generated.contentType = requestedStyle.charAt(0).toUpperCase() + requestedStyle.slice(1).toLowerCase();
      }
      generated.requestedStyle = requestedStyle;
      generated.requestedLengthKey = length;
      generated.requestedLength = lengthLabels[length] || lengthLabels.medium;
      generated.angle = strategyContext.angle || generated.angle;
      generated.planRationale = strategyContext.rationale || null;
      generated.targetAudience = strategyContext.audience || profile.target_audience || generated.targetAudience;
      generated.brandVoice = profile.brand_voice || null;
      generated.channelGoal = strategyContext.objective || profile.goal || null;
      generated.channelValueProposition = strategyContext.valueProposition || null;
      generated.channelConstraints = strategyContext.constraints || null;
      generated.contentPillar = strategyContext.pillar || null;
      generated.callToAction = profile.call_to_action || null;
      generated.origin = strategyContext.origin || 'planned';
      // A manual lesson (no technique given) teaches the one taught least recently.
      generated.technique = strategyContext.technique ||
        (generated.contentType === 'Lesson' ? (await this.agents.strategy.nextTechnique?.())?.id || null : null);
      generated.gapId = strategyContext.gapId || null;
      generated.reactiveId = strategyContext.reactiveId || null;
      // The claim as it was found, since the strategy model may reword the topic.
      generated.examinedClaimHint = strategyContext.claim || null;
      // React mode: the video answered, named, linked and quoted word for word (as text, no footage).
      const reactive = strategyContext.reactiveId ? await this.db.getReactiveItem?.(strategyContext.reactiveId).catch(() => null) : null;
      // A vertical Short, alone or one part of a series, quoting only its own passages.
      generated.format = strategyContext.format === 'short' ? 'short' : null;
      const { part, parts } = seriesOf(strategyContext);
      if (generated.format) Object.assign(generated, { part, parts });
      const passages = generated.format ? partPassages(reactive?.passages || [], part, parts) : reactive?.passages || [];
      generated.examinedVideo = reactive?.video?.url ? {
        title: reactive.video.title,
        channel: reactive.video.channel,
        channelId: reactive.channelId || null,
        url: reactive.video.url,
        passages: passages.map(({ text, timestamp }) => ({ text, ...(timestamp ? { timestamp } : {}) }))
      } : null;
      generated.researchSources = Array.isArray(strategyContext.researchSources)
        ? strategyContext.researchSources
        : [];
      return generated;
    });
    this.logger.info(`Strategy generated: ${strategy.topic}`);

    // Step 2: Script Writing (with the expert's corrections when the last review asked for some)
    const expertRevision = jobId && this.expertReview ? await this.expertReview.revisionRequest(jobId) : null;
    const draft = await this.runGenerationStage(
      jobId,
      'script',
      25,
      () => this.agents.scriptWriter.generateScript(expertRevision ? { ...strategy, expertRevision } : strategy)
    );
    this.logger.info(`Script generated: ${draft.title}`);

    // Step 2b: Expert review of highly specialised subjects, before any time goes into voice, images and montage
    const script = this.expertReview?.enabled()
      ? await this.runGenerationStage(jobId, 'expert_review', 30, () => this.expertReview.gate({ jobId, strategy, script: draft }))
      : draft;

    // Step 3: Thumbnail Design
    const thumbnail = await this.runGenerationStage(
      jobId,
      'thumbnail',
      40,
      () => this.agents.thumbnailDesigner.generateThumbnail(script)
    );
    this.logger.info('Thumbnail generated');

    // Step 4: SEO Optimization
    const seoData = await this.runGenerationStage(
      jobId,
      'seo',
      52,
      () => this.agents.seoOptimizer.optimize(script, strategy)
    );
    this.logger.info('SEO optimization complete');

    // Step 5: Production Management
    const productionData = await this.runGenerationStage(
      jobId,
      'production',
      62,
      () => this.agents.production.processContent({ strategy, script, thumbnail, seo: seoData, jobId })
    );
    this.logger.info('Production processing complete');

    // Re-persist reused production artifacts in case a restart happened between checkpointing and persistence.
    const contentId = await this.db.saveProductionData(productionData);
    await this.db.saveProductionSnapshot(productionData);
    if (!this.provenance) this.provenance = new ProvenanceService(this.db);
    productionData.provenance = await this.provenance.initialize(contentId, productionData);
    if (autoFactChecker.enabled() && (productionData.provenance?.claims || []).length) {
      await this.runGenerationStage(jobId, 'fact_check', 85, async () => {
        try {
          productionData.provenance = await autoFactChecker.autoReview(this.provenance, contentId, { title: script.title }, this.logger);
          const summary = productionData.provenance?.summary || {};
          this.logger.info(`Automated evidence review: ${summary.resolvedClaims || 0}/${summary.claimCount || 0} claims resolved, provenance ${productionData.provenance?.status}`);
        } catch (error) {
          this.logger.warn(`Automated fact-check failed; the production stays in human review: ${error.message.slice(0, 200)}`);
        }
        return productionData.provenance;
      });
    }
    productionData.discoverability = this.discoverability
      ? await this.discoverability.auditProduction(productionData, profile, 'youtube')
      : null;
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Step 6: Quality and approval gate
    return this.runGenerationStage(jobId, 'quality_review', 90, async () => {
      // A reactive video always waits for the operator, who is alerted; it is not slowed by a packaging experiment.
      const reactive = strategy.origin === 'reactive';
      const approvalRequired = reactive || await this.db.getSetting('approval_required') !== 'false';
      const packagingExperiment = approvalRequired && !reactive
        ? await this.preparePackagingExperiment(thumbnail, productionData, seoData, script)
        : null;
      // The description YouTube receives, on this autonomous path as on the operator's: the AI summary, the
      // subscribe line, chapters timed on the narrated scenes, then the verified sources and credits.
      const chapters = await this.buildChapters(contentId);
      const description = await this.composeDescription(contentId, seoData?.description, chapters, profile);
      if (isVertical(productionData.assets?.finalVideo)) {
        productionData.seo = { ...productionData.seo, tags: [...new Set([...(productionData.seo?.tags || []), 'Shorts'])].slice(0, 15) };
      }
      const site = siteLink({ id: contentId, strategy: productionData.strategy, script: productionData.script, seo: productionData.seo });
      productionData.seo = { ...productionData.seo, description, chapters, ...(site ? { siteSlug: site.slug } : {}) };
      await this.db.saveProductionSnapshot(productionData);
      const quality = await this.operator.runQualityChecks(productionData, profile);
      // A reaction that passed every check is approved by Jev instead of waiting for the operator.
      const jevApproval = reactive && quality.passed ? await this.operator.reactiveApproval?.(productionData).catch(error => ({
        approved: false, reasons: [`l'approbation par Jev a échoué (${error.message.slice(0, 120)})`], fidelity: []
      })) : null;
      const autoApproved = Boolean(jevApproval?.approved);
      const reviewStatus = quality.passed
        ? (approvalRequired && !autoApproved ? 'needs_review' : 'approved')
        : 'needs_attention';
      await this.db.saveContentReview(contentId, {
        status: reviewStatus,
        qualityChecks: quality.checks,
        editorData: {
          ...(packagingExperiment ? { packagingExperiment, selectedTitleVariant: 0, selectedThumbnailVariant: 0 } : {}),
          description
        },
        reviewNotes: !quality.passed
          ? `Blocking checks failed: ${quality.blockingFailures.join(', ')}`
          : autoApproved ? `Approuvé par Jev : faits vérifiés, ton vérifié, ${jevApproval.fidelity.length} citation(s) fidèle(s)` : null,
        reviewedAt: approvalRequired && !autoApproved ? null : new Date().toISOString()
      });

      let scheduleEntry = null;
      if (reviewStatus === 'approved') {
        scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
        await this.db.updateProductionStatus(contentId, scheduleEntry ? 'scheduled' : productionData.status);
        if (reactive) await this.alertReactive(strategy, script, contentId, quality, jevApproval);
      } else if (reactive) {
        await this.db.updateProductionStatus(contentId, reviewStatus);
        await this.alertReactive(strategy, script, contentId, quality, jevApproval);
      } else {
        await this.db.updateProductionStatus(contentId, reviewStatus);
        await this.operator.notify({
          type: 'review_required',
          level: quality.passed ? 'info' : 'warning',
          title: quality.passed ? 'Content ready for review' : 'Content needs attention',
          message: `${script.title} ${quality.passed ? 'is ready for approval' : 'failed one or more quality checks'}`,
          data: { contentId, qualityScore: quality.score }
        });
      }

      return {
        contentId,
        title: script.title,
        status: productionData.status,
        reviewStatus,
        qualityScore: quality.score,
        scheduledFor: scheduleEntry ? scheduleEntry.publishTime : null
      };
    });
  }

  async runGenerationStage(jobId, stage, progress, producer) {
    if (!jobId) {
      await this.updateJobStage(jobId, stage, progress);
      return producer();
    }
    if (!this.recovery) {
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
    }
    return this.recovery.run(jobId, stage, progress, producer);
  }

  validateEditorData(input = {}, existing = {}) {
    const output = { ...existing };
    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title || title.length > 100) throw new Error('Title must be between 1 and 100 characters');
      output.title = title;
    }
    if (input.description !== undefined) {
      const description = String(input.description).trim();
      if (description.length > 5000) throw new Error('Description must be 5,000 characters or less');
      output.description = description;
    }
    if (input.tags !== undefined) {
      const tags = Array.isArray(input.tags)
        ? input.tags
        : String(input.tags).split(',');
      output.tags = tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 30);
    }
    if (input.publishTime !== undefined) {
      const date = new Date(input.publishTime);
      if (Number.isNaN(date.getTime())) throw new Error('Publish time must be a valid date');
      output.publishTime = date.toISOString();
    }
    if (input.privacyStatus !== undefined) {
      if (!['private', 'unlisted', 'public'].includes(input.privacyStatus)) throw new Error('Invalid privacy status');
      output.privacyStatus = input.privacyStatus;
    }
    if (input.factChecked !== undefined) output.factChecked = input.factChecked === true;
    if (input.rightsConfirmed !== undefined) output.rightsConfirmed = input.rightsConfirmed === true;
    const experiment = output.packagingExperiment;
    if (input.selectedTitleVariant !== undefined) {
      const selected = Number(input.selectedTitleVariant);
      if (!Number.isInteger(selected) || !experiment?.titleVariants?.[selected]) {
        throw new Error('Selected title variant is invalid');
      }
      output.selectedTitleVariant = selected;
    }
    if (input.selectedThumbnailVariant !== undefined) {
      const selected = Number(input.selectedThumbnailVariant);
      if (!Number.isInteger(selected) || !experiment?.thumbnailVariants?.[selected]) {
        throw new Error('Selected thumbnail variant is invalid');
      }
      output.selectedThumbnailVariant = selected;
    }
    return output;
  }

  buildTitleExperimentVariants(title) {
    const control = String(title || '').trim().slice(0, 100);
    const withoutPunctuation = control.replace(/[.!?]+$/, '');
    return [
      { label: 'Control', title: control },
      { label: 'Step-by-step', title: `${withoutPunctuation}: Step-by-Step`.slice(0, 100) },
      { label: 'Curiosity', title: `${withoutPunctuation}: What Most People Miss`.slice(0, 100) }
    ];
  }

  async preparePackagingExperiment(thumbnail, productionData, seoData, script) {
    const approved = await this.db.listLearningRecommendations({ status: 'approved', limit: 25 });
    const recommendation = approved.find(item => item.proposedChange?.experiment === 'title_thumbnail_variant');
    if (!recommendation) return null;
    try {
      const generated = await this.agents.thumbnailDesigner.generateABVariants(thumbnail.concept);
      return {
        sourceRecommendationId: recommendation.id,
        hypothesis: recommendation.title,
        status: 'draft',
        titleVariants: this.buildTitleExperimentVariants(seoData.title || script.title),
        thumbnailVariants: [
          { label: 'Control', path: productionData.assets?.thumbnail?.path, concept: thumbnail.concept },
          ...generated
        ],
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      this.logger.warn(`Packaging experiment preparation failed without blocking production: ${error.message}`);
      return null;
    }
  }

  // Used by the continuous-operator cron: same guards as POST /api/operator/start.
  async startAutonomousRun() {
    if (this.setupRequired || !this.agents.strategy || !this.autonomous) return null;
    if (this.activeJobs.size || this.startingJobs || await this.reactiveWaiting()) return null;
    await this.readiness?.assertReady('Autonomous production');
    const current = await this.db.getChannelStrategy();
    if (!current || current.status !== 'active') return null;
    return this.autonomous.start(current);
  }

  // For every video published in the last 48 hours without Shorts: propose, render and schedule
  // SHORTS_PER_VIDEO clips, staggered a few hours apart, with the parent's privacy.
  async runAutoShorts() {
    if (!this.shorts || !this.agents.publishing) return;
    if (await this.db.getSetting('auto_shorts') !== 'true') return;
    // Editing, judging and rendering a montage takes minutes: a run never overlaps the previous one.
    if (this.autoShortsRunning) return;
    this.autoShortsRunning = true;
    try {
      await this.editAutoShorts();
    } finally {
      this.autoShortsRunning = false;
    }
  }

  async editAutoShorts() {
    const perVideo = Math.max(1, Math.min(5, Number(process.env.SHORTS_PER_VIDEO || 2)));
    const pipeline = await this.db.getProductionPipeline();
    for (const production of pipeline) {
      const bundle = await this.db.getProductionBundle(production.id);
      if (!bundle || bundle.review_status !== 'approved') continue;
      // A Short is not cut into Shorts, nor a series joined from Shorts.
      if (isVertical(bundle.assets?.finalVideo) || bundle.strategy?.seriesOf) continue;
      const schedule = bundle.schedule;
      if (!schedule || schedule.status !== 'published') continue;
      const publishedAt = new Date(schedule.published_at || schedule.publishedAt || schedule.publish_time || schedule.publishTime || 0);
      if (Date.now() - publishedAt.getTime() > 48 * 3600 * 1000) continue;
      // Shorts approved, published or paused by the operator count; a video gets montages up to SHORTS_PER_VIDEO,
      // never reusing their sentences.
      const shorts = bundle.shorts || [];
      const kept = shorts.filter(clip => ['approved', 'scheduled', 'uploading', 'published', 'reconciliation_required', 'paused'].includes(clip.status));
      if (kept.length >= perVideo) continue;
      // The AI editor already judged this video and found no montage worth publishing.
      if (await this.db.getSetting(`shorts_none_${bundle.id}`)) continue;
      try {
        // Drafts left by an interrupted run are replaced.
        for (const draft of shorts.filter(clip => !kept.includes(clip) && clip.status !== 'cancelled')) {
          await this.db.updateShortClip(draft.id, { status: 'cancelled', error: 'Replaced by a new automatic montage' });
        }
        const clips = await this.shorts.propose(bundle.id, { count: perVideo - kept.length, requireAI: true, append: shorts.length > 0 });
        const list = Array.isArray(clips) ? clips : (clips.clips || []);
        if (!list.length) {
          await this.db.setSetting(`shorts_none_${bundle.id}`, new Date().toISOString(), 'No Short montage passed the editor and the critic');
          this.logger.info(`No Short published for ${bundle.script?.title}: no montage passed the editor and the critic`);
          continue;
        }
        let scheduled = 0;
        for (const clip of list) {
          try {
            // A montage that fails its render checks (captions, length, sound) is never published.
            await this.shorts.render(bundle.id, clip.id);
            const publishTime = new Date(Date.now() + (scheduled * 6 + 1) * 3600 * 1000).toISOString();
            await this.shorts.approve(bundle.id, clip.id, {
              confirmed: true, publishTime,
              privacyStatus: process.env.DEFAULT_PRIVACY_STATUS || 'private'
            });
            scheduled++;
            this.logger.info(`Auto Short scheduled for ${bundle.script?.title}: ${clip.id} at ${publishTime}`);
          } catch (error) {
            this.logger.warn(`Auto Short ${clip.id} dropped: ${error.message.slice(0, 300)}`);
          }
        }
        // One editing attempt per video: a montage that failed is not retried every half hour.
        if (scheduled < list.length) {
          await this.db.setSetting(`shorts_none_${bundle.id}`, new Date().toISOString(), `${list.length - scheduled} Short montage(s) failed their render checks`);
        }
      } catch (error) {
        this.logger.warn(`Auto Shorts skipped for ${bundle.id}: ${error.message.slice(0, 200)}`);
      }
    }
  }

  // The description of a production under review with chapters re-timed on its current scenes. The chapters are kept
  // in the SEO snapshot so their titles survive later repairs.
  async reviewDescription(bundle, editedDescription, profile = {}) {
    const chapters = await this.buildChapters(bundle.id);
    const site = siteLink(bundle);
    const description = editedDescription
      ? await this.finalizeDescription(editedDescription, chapters, profile, site?.line)
      : await this.composeDescription(bundle.id, bundle.seo?.description, chapters, profile);
    // The page address goes out with the description: it is recorded so it never changes afterwards.
    await this.db.saveProductionSnapshot({ ...bundle, seo: { ...bundle.seo, chapters, ...(site ? { siteSlug: site.slug } : {}) } });
    return { chapters, description };
  }

  // Rebuilds and pushes the public verification site a minute after a publication (several close publications make
  // one deployment). Without SITE_BASE_URL there is no site.
  requestSiteUpdate() {
    if (!siteBaseUrl()) return;
    clearTimeout(this.siteTimer);
    this.siteTimer = setTimeout(() => { void this.updateSite(); }, 60000);
    this.siteTimer.unref?.();
  }

  async updateSite() {
    if (!siteBaseUrl()) return null;
    try {
      const result = await deploySite(this.db, { logger: this.logger });
      if (result.deployed || result.reason === 'no change') await this.db.setSetting('site_rebuild_needed', 'false');
      return result;
    } catch (error) {
      this.logger.warn(`Verification site update failed: ${error.message}`);
      return null;
    }
  }

  // Final description of a long video: the AI summary without any timestamps of its own, the subscribe line, then
  // the chapters and the extras below.
  async composeDescription(productionId, baseDescription, chapters = [], profile = {}) {
    const base = stripTimestamps(baseDescription).split('\n').filter(line => !/^(🔔|🔎|📌|▶️)/u.test(line) && line.trim() !== '#Shorts').join('\n')
      .replace(/\n{3,}/g, '\n\n').trim();
    const bundle = await Promise.resolve().then(() => this.db.getProductionBundle(productionId)).catch(() => null);
    const site = siteLink(bundle || { id: productionId });
    const examined = bundle?.strategy?.examinedVideo;
    const examinedLine = examined?.url ? `📌 Vidéo examinée : « ${examined.title} » (${examined.channel}) : ${examined.url}` : null;
    const head = [base, subscribeLine(profile.call_to_action, await this.youtubeChannelId()), site?.line, examinedLine, await this.seriesLine(bundle)]
      .filter(Boolean).join('\n\n');
    const extras = await this.buildDescriptionExtras(productionId, head.length, this.chapterBlock(chapters));
    return [head, extras, isVertical(bundle?.assets?.finalVideo) ? '#Shorts' : null].filter(Boolean).join('\n\n');
  }

  // A part of a series links the parts already out.
  async seriesLine(bundle) {
    const { part, parts } = seriesOf(bundle?.strategy);
    if (parts < 2 || part < 2 || !bundle.strategy?.reactiveId) return null;
    const item = await this.db.getReactiveItem?.(bundle.strategy.reactiveId).catch(() => null);
    const earlier = item ? (await this.publishedParts(item)).filter(episode => episode.part < part) : [];
    return earlier.length ? earlier.map(episode => `▶️ Partie ${episode.part} : ${episode.entry.youtubeUrl}`).join('\n') : null;
  }

  // A description edited in the review studio keeps its wording: its chapter list is re-timed on the current scenes
  // and the subscribe line is put back when it was removed.
  async finalizeDescription(description, chapters = [], profile = {}, siteLine = null) {
    let result = replaceChapterBlock(description, this.chapterBlock(chapters));
    if (!/^🔔/m.test(result)) {
      const [first, ...rest] = result.split('\n\n');
      result = [first, subscribeLine(profile.call_to_action, await this.youtubeChannelId()), ...rest].filter(Boolean).join('\n\n');
    }
    if (siteLine && !/^🔎/m.test(result)) {
      const paragraphs = result.split('\n\n');
      const after = paragraphs.findIndex(paragraph => paragraph.startsWith('🔔'));
      paragraphs.splice(after + 1, 0, siteLine);
      result = paragraphs.join('\n\n');
    }
    return result;
  }

  chapterBlock(chapters = []) {
    return formatChapterBlock(chapters, { totalDuration: chapters.length ? chapters[chapters.length - 1].end : 0 });
  }

  // Chapters of a long video: spans of the narrated scenes timed on their measured durations and titled from what
  // each one says. Titles already chosen for the same scenes are kept, so a scene repair only moves the timestamps.
  async buildChapters(productionId) {
    try {
      const bundle = await this.db.getProductionBundle(productionId);
      const scenes = bundle?.scenes || [];
      // A Short has no chapters.
      if (!scenes.length || isVertical(bundle.assets?.finalVideo)) return [];
      const registers = scriptScenes(bundle.script || {}).map(blueprint => blueprint.register);
      const spans = chapterSpans(scenes, { registers });
      const key = span => span.sceneIds.join(',');
      const known = new Map((bundle.seo?.chapters || []).filter(chapter => Array.isArray(chapter.sceneIds)).map(chapter => [key(chapter), chapter.title]));
      const titles = spans.every(span => known.has(key(span)))
        ? spans.map(span => known.get(key(span)))
        : await titleChapters(spans, this.chapterTextService(), { logger: this.logger });
      return spans.map((span, index) => ({
        start: Number(span.start.toFixed(2)), end: Number(span.end.toFixed(2)),
        time: formatTimestamp(span.start), title: titles[index], sceneIds: span.sceneIds
      }));
    } catch (error) {
      this.logger.warn(`Chapters skipped: ${error.message}`);
      return [];
    }
  }

  chapterTextService() {
    if (!this.chapterText) this.chapterText = this.shorts?.aiTextService || new AITextService(this.credentials?.credentials || {});
    return this.chapterText;
  }

  // The channel id for the subscribe link, asked once to YouTube (1 quota unit) and remembered.
  async youtubeChannelId() {
    const cached = await this.db.getSetting('youtube_channel_id');
    if (cached) return cached;
    const youtube = this.agents?.publishing?.youtube;
    if (!youtube?.channels?.list) return null;
    try {
      const response = await youtube.channels.list({ part: ['id'], mine: true });
      const id = response?.data?.items?.[0]?.id || null;
      if (id) await this.db.setSetting('youtube_channel_id', id, 'Channel id used in the subscribe link of descriptions');
      return id;
    } catch (error) {
      this.logger.warn(`Subscribe link without channel id: ${error.message}`);
      return null;
    }
  }

  // The chapters, the verified sources, the music attribution and the credits of the images and translations shown
  // on screen. The image credits go last and are shortened line by line when the whole description would exceed
  // YouTube's limit.
  async buildDescriptionExtras(productionId, baseLength = 0, chapters = '') {
    let sourcesBlock = '';
    try {
      const provenance = await this.db.getContentProvenance(productionId);
      const verified = (provenance?.sources || []).filter(source => source.status === 'verified').slice(0, 12);
      if (verified.length) {
        const lang = process.env.CONTENT_LANGUAGE || 'en';
        sourcesBlock = `${lang === 'fr' ? 'SOURCES (vérifiées)' : 'SOURCES (verified)'}\n` +
          verified.map(source => `• ${source.title}${source.publisher ? ` (${source.publisher})` : ''} : ${source.url}`).join('\n');
      }
    } catch (error) {
      this.logger.warn(`Sources block skipped: ${error.message}`);
    }
    const blocks = [chapters, sourcesBlock, await this.buildMusicCredits(productionId)].filter(Boolean);
    const [heading, ...credits] = await this.buildInsertCredits(productionId);
    const room = MAX_DESCRIPTION_LENGTH - baseLength - blocks.reduce((sum, block) => sum + block.length + 2, 2);
    while (credits.length && [heading, ...credits].join('\n').length > room) credits.pop();
    if (credits.length) blocks.push([heading, ...credits].join('\n'));
    return blocks.join('\n\n');
  }

  // Attribution required by some audio-library tracks (the .txt next to the track in data/music).
  async buildMusicCredits(productionId) {
    try {
      const bundle = await this.db.getProductionBundle(productionId);
      const credits = bundle?.assets?.music?.credits || [];
      if (!credits.length) return '';
      return `${(process.env.CONTENT_LANGUAGE || 'en') === 'fr' ? 'MUSIQUE' : 'MUSIC'}\n${credits.map(credit => `• ${credit}`).join('\n')}`;
    } catch (error) {
      this.logger.warn(`Music credits skipped: ${error.message}`);
      return '';
    }
  }

  // [heading, ...lines] for the Wikimedia Commons images and scripture translations of the visual inserts.
  async buildInsertCredits(productionId) {
    try {
      const bundle = await this.db.getProductionBundle(productionId);
      const credits = bundle?.assets?.inserts?.credits || [];
      if (!credits.length) return [];
      const fr = (process.env.CONTENT_LANGUAGE || 'en') === 'fr';
      const author = value => {
        const text = String(value || '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').replace(/[\s.;,]+$/, '').trim();
        if (/^(unknown|anonymous|inconnu|anonyme)\b/i.test(text)) return '';
        return text.length > 70 ? `${text.slice(0, 70).replace(/\s+\S*$/, '')}…` : text;
      };
      const lines = credits.map(credit => credit.kind === 'text'
        ? `• ${credit.work} : ${fr ? 'traduction' : 'translation'} ${credit.edition}`
        : `• ${credit.article || credit.file} : ${[author(credit.author), credit.license].filter(Boolean).join(', ')}, Wikimedia Commons ${credit.shortUrl || credit.url}`);
      return [fr ? 'IMAGES ET TEXTES CITÉS' : 'IMAGE AND TEXT CREDITS', ...new Set(lines)];
    } catch (error) {
      this.logger.warn(`Insert credits skipped: ${error.message}`);
      return [];
    }
  }

  validateProfile(input) {
    const textFields = ['channelName', 'goal', 'targetAudience', 'brandVoice', 'defaultStyle', 'callToAction', 'visualStyle', 'timezone'];
    const result = {};
    for (const field of textFields) {
      if (input[field] !== undefined) {
        const value = String(input[field]).trim();
        if (value.length > 500) throw new Error(`${field} is too long`);
        result[field] = value;
      }
    }
    if (input.bannedTopics !== undefined) {
      const topics = Array.isArray(input.bannedTopics) ? input.bannedTopics : String(input.bannedTopics).split(',');
      result.bannedTopics = topics.map(topic => String(topic).trim()).filter(Boolean).slice(0, 50);
    }
    return result;
  }

  decorateContentBundle(bundle) {
    const experiment = bundle.editorData?.packagingExperiment;
    const sceneLabels = new Map((bundle.scenes || []).map(scene => [scene.id, scene.label]));
    return {
      ...bundle,
      scenes: (bundle.scenes || []).map(scene => this.scenes
        ? this.scenes.decorateScene(scene, bundle.id)
        : scene),
      shorts: (bundle.shorts || []).map(clip => ({
        ...clip,
        sourceSceneLabels: clip.sourceSceneIds.map(id => sceneLabels.get(id)).filter(Boolean),
        assetUrls: {
          video: clip.outputPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/video` : null,
          captions: clip.captionsPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/captions` : null
        }
      })),
      assetUrls: {
        video: bundle.assets?.finalVideo?.path && !bundle.assets?.finalVideo?.simulated ? `/api/content/${bundle.id}/asset/video` : null,
        thumbnail: bundle.assets?.thumbnail?.path ? `/api/content/${bundle.id}/asset/thumbnail` : null,
        experimentThumbnails: (experiment?.thumbnailVariants || []).map((_variant, index) =>
          `/api/content/${bundle.id}/asset/experiment-thumbnail-${index}`
        ),
        captions: bundle.assets?.captions?.path ? `/api/content/${bundle.id}/asset/captions` : null,
        script: bundle.assets?.script?.originalPath ? `/api/content/${bundle.id}/asset/script` : null
      }
    };
  }

  async refreshContentReview(productionId, reviewNotes) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) return null;
    const profile = await this.db.getChannelProfile() || {};
    // Repaired scenes move the chapters: re-time them (titles are kept per scene) in the description under review.
    const { chapters, description } = await this.reviewDescription(bundle, bundle.editorData?.description, profile);
    const quality = await this.operator.runQualityChecks({
      ...bundle,
      seo: { ...bundle.seo, description, chapters },
      scheduledPublishTime: bundle.scheduled_publish_time
    }, profile);
    const status = quality.passed ? 'needs_review' : 'needs_attention';
    return this.db.saveContentReview(productionId, {
      status,
      editorData: { ...(bundle.editorData || {}), description, factChecked: false, rightsConfirmed: false },
      qualityChecks: quality.checks,
      reviewNotes: reviewNotes || (quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`),
      reviewedAt: null
    });
  }

  async approveContent(productionId, input) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) {
      const error = new Error('Content not found');
      error.status = 404;
      throw error;
    }
    if (bundle.schedule?.status === 'published') {
      const error = new Error('Content is already published');
      error.status = 409;
      throw error;
    }

    const editorData = this.validateEditorData(input, bundle.editorData);
    const packagingExperiment = editorData.packagingExperiment;
    const thumbnailVariant = packagingExperiment?.thumbnailVariants?.[editorData.selectedThumbnailVariant];
    const titleVariant = packagingExperiment?.titleVariants?.[editorData.selectedTitleVariant];
    if (titleVariant && input.title === undefined) editorData.title = titleVariant.title;
    if (!editorData.factChecked || !editorData.rightsConfirmed) {
      const error = new Error('Confirm the factual review and media rights checks before approval');
      error.status = 409;
      throw error;
    }
    const productionData = {
      id: bundle.id,
      status: bundle.status,
      strategy: bundle.strategy,
      script: { ...bundle.script, title: editorData.title || bundle.script.title },
      thumbnail: bundle.thumbnail,
      seo: {
        ...bundle.seo,
        title: editorData.title || bundle.seo.title,
        tags: editorData.tags || bundle.seo.tags
      },
      assets: thumbnailVariant
        ? { ...bundle.assets, thumbnail: { ...bundle.assets.thumbnail, path: thumbnailVariant.path } }
        : bundle.assets,
      timeline: bundle.timeline,
      scheduledPublishTime: editorData.publishTime || input.publishTime || bundle.scheduled_publish_time,
      priority: bundle.priority,
      estimatedDuration: bundle.estimated_duration,
      privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
      provenance: bundle.provenance,
      containsSyntheticMedia: bundle.provenance?.containsSyntheticMedia === true,
      scenes: bundle.scenes || []
    };
    const profile = await this.db.getChannelProfile() || {};
    const { chapters, description } = await this.reviewDescription(bundle, editorData.description, profile);
    editorData.description = description;
    productionData.seo = { ...productionData.seo, description, chapters };
    const quality = await this.operator.runQualityChecks(productionData, profile);
    if (!quality.passed) {
      await this.db.saveContentReview(bundle.id, {
        status: 'needs_attention', editorData, qualityChecks: quality.checks,
        reviewNotes: `Blocking checks failed: ${quality.blockingFailures.join(', ')}`
      });
      const error = new Error('Content still has blocking quality failures');
      error.status = 409;
      error.quality = quality;
      throw error;
    }

    let scheduleEntry = bundle.schedule;
    if (!scheduleEntry) {
      scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
    } else if (scheduleEntry.status !== 'published') {
      scheduleEntry.title = productionData.script.title;
      scheduleEntry.publishTime = productionData.scheduledPublishTime;
      scheduleEntry.status = 'scheduled';
      scheduleEntry.metadata = {
        ...scheduleEntry.metadata,
        seo: productionData.seo,
        thumbnail: productionData.assets.thumbnail,
        video: productionData.assets.finalVideo,
        audio: productionData.assets.audio,
        captions: productionData.assets.captions,
        privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
        containsSyntheticMedia: productionData.containsSyntheticMedia
      };
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.agents.publishing.loadPublishQueue();
    }
    if (!scheduleEntry) {
      const error = new Error('A real MP4 is required before content can be approved for scheduling');
      error.status = 409;
      throw error;
    }

    await this.db.saveContentReview(bundle.id, {
      status: 'approved', editorData, qualityChecks: quality.checks,
      reviewNotes: input.reviewNotes || 'Approved by operator', reviewedAt: new Date().toISOString()
    });
    await this.db.updateProductionStatus(bundle.id, 'scheduled');
    await this.operator.notify({
      type: 'content_approved', level: 'success', title: 'Content approved',
      message: `${productionData.script.title} is scheduled for ${scheduleEntry.publishTime}`,
      data: { productionId, publishTime: scheduleEntry.publishTime }
    });
    return { productionId, reviewStatus: 'approved', qualityScore: quality.score, schedule: scheduleEntry };
  }

  async start() {
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    // Bind to loopback unless HOST is set explicitly, so the dashboard is never exposed on the LAN by accident.
    const HOST = process.env.HOST || '127.0.0.1';
    this.app.listen(PORT, HOST, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      if (this.setupRequired) {
        console.log(chalk.yellow('\n⚙️  Setup is required. The dashboard is available; run npm run walkthrough to enable generation.'));
      } else {
        console.log(chalk.yellow('\n🤖 Automation is active. Approved content will be published on schedule.'));
      }
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent, strategyContextOf, GENERATION_ORIGINS };
