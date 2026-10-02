const { Database } = require('./database/db');
const { Logger } = require('./utils/logger');
const { CredentialManager } = require('./utils/credential-manager');
const { AudienceEngagementService } = require('./utils/audience-engagement-service');
const { DailyAutomation } = require('./schedules/daily-automation');
const chalk = require('chalk');
const path = require('path');
const { ProductionReadinessService } = require('./utils/production-readiness-service');
const { normalizeTags, validateYouTubeMetadata } = require('./utils/youtube-metadata-validator');

// The tests' model calls must not end up in the real usage log (npm run ai-usage), nor reach the real Jev API.
process.env.AI_USAGE_LOG = 'off';
process.env.JEV = 'off';
// No link to the public verification site in the descriptions the tests compare, unless a test asks for one.
process.env.SITE_BASE_URL = '';
// The suites run in react mode with a neutral test profile; testStandardMode checks the default mode.
process.env.CONTENT_MODE = 'react';
process.env.REACT_PROFILE = path.join(require('os').tmpdir(), `yaa-react-profile-${process.pid}.json`);
require('fs').writeFileSync(process.env.REACT_PROFILE, JSON.stringify({
    "script": {
      "twoPart": true
    },
    "claims": {
      "verdicts": {
        "wrong": {
          "label": "Faux",
          "definition": "shown false"
        },
        "misleading": {
          "label": "Trompeur",
          "definition": "true elements used to mislead"
        },
        "unproven": {
          "label": "Non démontré",
          "definition": "no evidence for it"
        },
        "untestable": {
          "label": "Invérifiable",
          "definition": "cannot be tested"
        },
        "right": {
          "label": "Exact",
          "definition": "holds up",
          "holds": true
        }
      },
      "unknownVerdict": "unproven"
    },
    "techniques": [
      {
        "id": "hindsight",
        "name": "La relecture après coup",
        "definition": "Un texte vague est relu après un événement pour y voir une prédiction.",
        "question": "Pourquoi tant de textes anciens semblent-ils annoncer l'avenir ?",
        "signs": [
          "la prédiction n'a été remarquée qu'après coup",
          "le texte admet plusieurs lectures"
        ]
      },
      {
        "id": "borrowed-authority",
        "name": "La caution empruntée",
        "definition": "On invoque une institution pour une affirmation qu'elle n'a pas faite.",
        "question": "Cette institution a-t-elle vraiment dit cela ?",
        "signs": [
          "aucune publication citée",
          "citation hors contexte"
        ]
      },
      {
        "id": "counting",
        "name": "Les coïncidences comptées",
        "definition": "On compte jusqu'à trouver un nombre qui semble significatif.",
        "question": "Les nombres cachent-ils des messages ?",
        "signs": [
          "la règle de comptage change",
          "les échecs ne sont pas comptés"
        ]
      },
      {
        "id": "hearsay",
        "name": "Le ouï-dire",
        "definition": "Un récit transmis de bouche à oreille est présenté comme une preuve.",
        "question": "Un récit très ancien peut-il être une preuve ?",
        "signs": [
          "aucune source directe",
          "la chaîne de témoins est invérifiable"
        ]
      },
      {
        "id": "authority",
        "name": "L'argument d'autorité",
        "definition": "Une affirmation est tenue pour vraie parce qu'une personne connue l'a dite.",
        "question": "Un expert peut-il se tromper hors de son domaine ?",
        "signs": [
          "la personne parle hors de son domaine",
          "aucune preuve n'est donnée"
        ]
      },
      {
        "id": "anecdote",
        "name": "Le témoignage invérifiable",
        "definition": "Un cas isolé, impossible à vérifier, sert de preuve.",
        "question": "Un témoignage suffit-il ?",
        "signs": [
          "un seul cas",
          "aucun moyen de vérifier"
        ]
      },
      {
        "id": "false-dilemma",
        "name": "Le faux dilemme",
        "definition": "Deux options seulement sont présentées alors qu'il en existe d'autres.",
        "question": "N'y a-t-il vraiment que deux possibilités ?",
        "signs": [
          "d'autres options sont passées sous silence"
        ]
      }
    ],
    "lesson": {
      "every": 4
    },
    "audience": {
      "stances": {
        "moved": "The commenter says the video changed their mind",
        "holds": "The commenter defends the claim the video examines",
        "agrees": "The commenter already agreed with the video",
        "question": "A sincere question about the subject",
        "hostile": "Insults or attacks without an argument",
        "other": "Anything else"
      },
      "goal": "moved",
      "goalLabel": "changed their mind",
      "engaged": [
        "moved",
        "holds",
        "agrees",
        "question"
      ],
      "reach": [
        "holds",
        "moved"
      ],
      "labels": {
        "moved": "changed their mind",
        "holds": "holds the claim",
        "agrees": "already agreed",
        "question": "question",
        "hostile": "hostile",
        "other": "other"
      }
    },
    "discovery": {
      "categories": {
        "test-category": "videos of the test category"
      }
    }
  }));
process.on('exit', () => { try { require('fs').unlinkSync(process.env.REACT_PROFILE); } catch (_error) { /* already gone */ } });
process.env.SITE_REPO = 'example/verifications';

class SystemTest {
  constructor() {
    this.logger = new Logger('SystemTest');
    this.testResults = {};
  }

  async runAllTests() {
    console.log(chalk.cyan.bold('\n🧪 YouTube Automation Agent - System Test'));
    console.log(chalk.gray('═'.repeat(60)));
    
    const tests = [
      { name: 'Database Connection', test: () => this.testDatabase() },
      { name: 'Production Persistence', test: () => this.testProductionPersistence() },
      { name: 'Automation Events Table', test: () => this.testAutomationEventsTable() },
      { name: 'Local Activation Metrics', test: () => this.testActivationMetrics() },
      { name: 'Anonymous Telemetry Opt-in', test: () => this.testAnonymousTelemetryOptIn() },
      { name: 'Operator Workflow API', test: () => this.testOperatorWorkflowAPI() },
      { name: 'Autonomous Channel Operator', test: () => this.testAutonomousChannelOperator() },
      { name: 'Closed-loop Channel Learning', test: () => this.testChannelLearningLoop() },
      { name: 'Controlled Growth Experiments Studio', test: () => this.testGrowthExperimentsStudio() },
      { name: 'Outcome and ROI Studio', test: () => this.testOutcomeROIStudio() },
      { name: 'Scene-Aware Retention Studio', test: () => this.testSceneAwareRetentionStudio() },
      { name: 'Production Readiness Gate', test: () => this.testProductionReadinessGate() },
      { name: 'Durable Multi-Provider Video Generation', test: () => this.testVideoProviderLayer() },
      { name: 'Scene Repair Studio', test: () => this.testSceneRepairStudio() },
      { name: 'Narration Reliability and Recovery', test: () => this.testNarrationReliability() },
      { name: 'Shorts Repurposing Studio', test: () => this.testShortsRepurposingStudio() },
      { name: 'Chapters and Mandatory Subscribe Call', test: () => this.testChaptersAndSubscribe() },
      { name: 'Montage Shorts Editor, Critic and Render', test: () => this.testMontageShorts() },
      { name: 'Studio Voices, Captions and Shorts Editor', test: () => this.testStudioVoiceAndShortsEditor() },
      { name: 'TikTok and Instagram Publishing', test: () => this.testSocialPublishing() },
      { name: 'Research and Provenance Desk', test: () => this.testProvenanceDesk() },
      { name: 'DarkzSEO Discoverability Preflight', test: () => this.testDiscoverabilityPreflight() },
      { name: 'Open Issue Regressions', test: () => this.testOpenIssueRegressions() },
      { name: 'Resumable Generation Checkpoints', test: () => this.testResumableGenerationCheckpoints() },
      { name: 'Expert Review of Specialised Scripts', test: () => this.testExpertReview() },
      { name: 'Lesson Format and Examined Claims', test: () => this.testLessonFormat() },
      { name: 'Public Verification Site', test: () => this.testVerificationSite() },
      { name: 'Topic Gap Finder', test: () => this.testTopicGapFinder() },
      { name: 'Reactive Watch', test: () => this.testReactiveWatch() },
      { name: 'Reactions and Watched Channels', test: () => this.testReactions() },
      { name: 'Persuasion Measurement', test: () => this.testPersuasionMeasurement() },
      { name: 'Analytics Without Impressions', test: () => this.testAnalyticsWithoutImpressions() },
      { name: 'Reaction Shorts And Series', test: () => this.testReactiveShortSeries() },
      { name: 'Standard Content Mode', test: () => this.testStandardMode() },
      { name: 'AI Usage Measurement', test: () => this.testAIUsageMeasurement() },
      { name: 'Jev Client', test: () => this.testJevClient() },
      { name: 'API Validation and Security', test: () => this.testAPIValidationAndSecurity() },
      { name: 'Publishing Safety', test: () => this.testPublishingSafety() },
      { name: 'Multi-Provider Credential Validation', test: () => this.testCredentialValidation() },
      { name: 'AI Text Service Token Compatibility', test: () => this.testAITextServiceTokenParams() },
      { name: 'Placeholder Scheduling Guard', test: () => this.testPlaceholderSchedulingGuard() },
      { name: 'FFmpeg Resolution', test: () => this.testFFmpegResolution() },
      { name: 'Gemini Media Provider Selection', test: () => this.testGeminiMediaProvider() },
      { name: 'Slideshow Renderer', test: () => this.testSlideshowRenderer() },
      { name: 'Evergreen Template Topics', test: () => this.testEvergreenTopics() },
      { name: 'Visual Inserts', test: () => this.testVisualInserts() },
      { name: 'Background Music', test: () => this.testBackgroundMusic() },
      { name: 'Walkthrough Module', test: () => this.testWalkthroughModule() },
      { name: 'Logger System', test: () => this.testLogger() },
      { name: 'Directory Structure', test: () => this.testDirectories() },
      { name: 'Agent Loading', test: () => this.testAgentLoading() },
      { name: 'Configuration Files', test: () => this.testConfiguration() },
      { name: 'Audience Comment Store', test: () => this.testAudienceCommentStore() },
      { name: 'Engagement Insight Store', test: () => this.testEngagementInsightStore() },
      { name: 'Reply Draft Lifecycle Store', test: () => this.testReplyDraftStore() },
      { name: 'YouTube Scope Detection', test: () => this.testYouTubeScopeDetection() },
      { name: 'Audience Comment Sync', test: () => this.testAudienceCommentSync() },
      { name: 'Audience Comment Analysis', test: () => this.testAudienceCommentAnalysis() },
      { name: 'Audience Idea Mining', test: () => this.testAudienceIdeaMining() },
      { name: 'Reply Drafting', test: () => this.testReplyDrafting() },
      { name: 'Reply Approval and Posting', test: () => this.testReplyApprovalAndPosting() },
      { name: 'Engagement AI Provider Wiring', test: () => this.testEngagementAIProviderWiring() },
      { name: 'Engagement Sync Schedule', test: () => this.testEngagementSyncSchedule() },
      { name: 'Growth Experiment Refresh Schedule', test: () => this.testGrowthExperimentRefreshSchedule() }
    ];

    let passed = 0;
    let failed = 0;

    for (const { name, test } of tests) {
      try {
        console.log(chalk.cyan(`\n🔍 Testing ${name}...`));
        await test();
        console.log(chalk.green(`✅ ${name} - PASSED`));
        this.testResults[name] = { status: 'PASSED' };
        passed++;
      } catch (error) {
        console.log(chalk.red(`❌ ${name} - FAILED`));
        console.log(chalk.red(`   Error: ${error.message}`));
        this.testResults[name] = { status: 'FAILED', error: error.message };
        failed++;
      }
    }

    // Display summary
    console.log(chalk.gray('\n' + '═'.repeat(60)));
    console.log(chalk.cyan.bold('📊 Test Summary:'));
    console.log(chalk.green(`✅ Passed: ${passed}`));
    console.log(chalk.red(`❌ Failed: ${failed}`));
    console.log(chalk.cyan(`📝 Total: ${passed + failed}`));

    if (failed === 0) {
      console.log(chalk.green.bold('\n🎉 All tests passed! System is ready to run.'));
      console.log(chalk.cyan('Run: npm start'));
    } else {
      console.log(chalk.yellow.bold('\n⚠️  Some tests failed. Please check the errors above.'));
      console.log(chalk.cyan('Run: npm run setup (to reconfigure)'));
    }

    return failed === 0;
  }

  async testDatabase() {
    const db = new Database();
    await db.initialize();
    
    // Test basic operations
    const stats = await db.getStats();
    if (!stats) throw new Error('Failed to get database stats');
    
    // Test settings
    await db.setSetting('test_key', 'test_value', 'Test setting');
    const value = await db.getSetting('test_key');
    if (value !== 'test_value') throw new Error('Settings read/write failed');
    
    await db.close();
    this.logger.info('Database test completed successfully');
  }

  async testProductionPersistence() {
    const db = new Database();
    await db.initialize();

    const production = {
      id: `prod_test_${Date.now()}`,
      status: 'processing',
      assets: { finalVideo: { path: 'placeholder.mp4' } },
      timeline: { created: new Date().toISOString() },
      scheduledPublishTime: new Date().toISOString(),
      priority: 25,
      estimatedDuration: '1:00'
    };

    const firstId = await db.saveProductionData(production);
    if (firstId !== production.id) {
      throw new Error('saveProductionData did not return the production id');
    }

    const secondId = await db.saveProductionData({
      ...production,
      status: 'ready',
      priority: 90
    });
    if (secondId !== production.id) {
      throw new Error('saveProductionData upsert did not return the production id');
    }

    const saved = await db.getRow('SELECT status, priority FROM productions WHERE id = ?', [production.id]);
    if (!saved || saved.status !== 'ready' || saved.priority !== 90) {
      throw new Error('saveProductionData did not upsert the existing production row');
    }

    await db.executeQuery('DELETE FROM productions WHERE id = ?', [production.id]);
    await db.close();
    this.logger.info('Production persistence test completed successfully');
  }

  async testAutomationEventsTable() {
    const db = new Database();
    await db.initialize();

    await db.executeQuery(
      'INSERT INTO automation_events (event_type, status, data, created_at) VALUES (?, ?, ?, datetime("now"))',
      ['test_event', 'success', JSON.stringify({ ok: true })]
    );

    const row = await db.getRow(
      'SELECT event_type, status, data FROM automation_events WHERE event_type = ? ORDER BY created_at DESC',
      ['test_event']
    );

    if (!row || row.status !== 'success') {
      throw new Error('automation_events row was not persisted');
    }

    await db.executeQuery('DELETE FROM automation_events WHERE event_type = ?', ['test_event']);
    await db.close();
    this.logger.info('Automation events table test completed successfully');
  }

  async testActivationMetrics() {
    const fs = require('fs').promises;
    const { ActivationMetrics } = require('./utils/activation-metrics');
    const db = new Database();
    await db.initialize();
    const id = `activation_test_${Date.now()}`;
    const videoPath = path.join(__dirname, 'temp', `${id}.mp4`);
    const mp4Header = Buffer.from([
      0x00, 0x00, 0x00, 0x18,
      0x66, 0x74, 0x79, 0x70,
      0x69, 0x73, 0x6f, 0x6d
    ]);

    try {
      await fs.mkdir(path.dirname(videoPath), { recursive: true });
      await fs.writeFile(videoPath, mp4Header);
      await db.saveProductionData({
        id,
        status: 'ready',
        assets: { finalVideo: { path: videoPath, simulated: false } },
        timeline: { readyForUpload: new Date().toISOString() },
        scheduledPublishTime: null,
        priority: 1,
        estimatedDuration: '0:01'
      });

      const activation = new ActivationMetrics(db);
      const summary = await activation.getSummary();
      if (!summary.milestones.firstRealVideo.achieved || summary.counts.realVideos < 1) {
        throw new Error('A verified non-simulated MP4 was not counted as activation');
      }

      await fs.writeFile(videoPath, Buffer.from('renamed-but-not-an-mp4'));
      const invalidContainerSummary = await activation.getSummary();
      if (invalidContainerSummary.counts.realVideos >= summary.counts.realVideos) {
        throw new Error('A file with an .mp4 extension but no MP4 signature was counted as activation');
      }

      await fs.writeFile(videoPath, mp4Header);
      await db.updateProductionData({
        id,
        status: 'simulated',
        assets: { finalVideo: { path: videoPath, simulated: true } },
        timeline: {},
        scheduledPublishTime: null,
        priority: 1
      });
      const simulatedSummary = await activation.getSummary();
      if (simulatedSummary.counts.realVideos >= summary.counts.realVideos) {
        throw new Error('A simulated MP4 was incorrectly counted as activation');
      }
    } finally {
      await db.executeQuery('DELETE FROM productions WHERE id = ?', [id]);
      await fs.unlink(videoPath).catch(() => {});
      await db.close();
    }

    this.logger.info('Local activation metrics test completed successfully');
  }

  async testAnonymousTelemetryOptIn() {
    const { AnonymousTelemetry } = require('./utils/anonymous-telemetry');
    const savedEnabled = process.env.ANONYMOUS_TELEMETRY_ENABLED;
    const savedEndpoint = process.env.ANONYMOUS_TELEMETRY_ENDPOINT;
    const db = new Database();
    await db.initialize();
    try {
      delete process.env.ANONYMOUS_TELEMETRY_ENABLED;
      delete process.env.ANONYMOUS_TELEMETRY_ENDPOINT;
      const telemetry = new AnonymousTelemetry(db, this.logger);
      if (telemetry.configuration().enabled) throw new Error('Anonymous telemetry was enabled without opt-in');

      process.env.ANONYMOUS_TELEMETRY_ENABLED = 'true';
      process.env.ANONYMOUS_TELEMETRY_ENDPOINT = 'http://example.com/events';
      if (telemetry.configuration().enabled) throw new Error('Anonymous telemetry accepted a non-HTTPS endpoint');
    } finally {
      if (savedEnabled === undefined) delete process.env.ANONYMOUS_TELEMETRY_ENABLED;
      else process.env.ANONYMOUS_TELEMETRY_ENABLED = savedEnabled;
      if (savedEndpoint === undefined) delete process.env.ANONYMOUS_TELEMETRY_ENDPOINT;
      else process.env.ANONYMOUS_TELEMETRY_ENDPOINT = savedEndpoint;
      await db.close();
    }
    this.logger.info('Anonymous telemetry opt-in test completed successfully');
  }

  async testOperatorWorkflowAPI() {
    const { YouTubeAutomationAgent } = require('./index');
    const { OperatorService } = require('./utils/operator-service');
    const db = new Database();
    await db.initialize();
    let server;
    let job;
    let learningRecommendation;

    try {
      job = await db.createGenerationJob({ topic: 'Operator workflow test', style: 'explainer', length: 'short' });
      await db.updateGenerationJob(job.id, { status: 'running', stage: 'script', progress: 25 });
      const updated = await db.getGenerationJob(job.id);
      if (updated.stage !== 'script' || updated.progress !== 25) {
        throw new Error('Generation job progress was not persisted');
      }

      const operator = new OperatorService(db);
      operator.notify = async () => null;
      const quality = await operator.runQualityChecks({
        script: { title: 'Test title', fullScript: 'x'.repeat(250) },
        seo: { title: 'Test title', description: 'x'.repeat(80), tags: ['one', 'two', 'three'] },
        assets: { finalVideo: { path: 'placeholder.info', simulated: true } }
      }, { bannedTopics: [] });
      if (quality.passed || !quality.blockingFailures.includes('video')) {
        throw new Error('Quality gate did not block a simulated video');
      }

      const agent = new YouTubeAutomationAgent();
      agent.db = db;
      agent.operator = operator;
      agent.agents = {
        analytics: {
          getRecentAnalytics: async () => ({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] })
        }
      };
      agent.scheduler = {
        isEnabled: true,
        pauseAutomation: async function() { this.isEnabled = false; },
        resumeAutomation: async function() { this.isEnabled = true; }
      };
      agent.isInitialized = true;
      agent.setupAPI();
      server = await new Promise(resolve => {
        const running = agent.app.listen(0, () => resolve(running));
      });
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      const dashboard = await response.json();
      if (
        !response.ok ||
        !Array.isArray(dashboard.jobs) ||
        !Array.isArray(dashboard.pipeline) ||
        !Array.isArray(dashboard.operatorRuns) ||
        dashboard.activation?.privacy !== 'local-only'
      ) {
        throw new Error('Operator dashboard API did not return its data contract');
      }
      const unavailableStart = await fetch(`http://127.0.0.1:${port}/api/operator/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      });
      if (unavailableStart.status !== 503) {
        throw new Error('Autonomous operator did not fail closed when its strategy agent was unavailable');
      }

      learningRecommendation = await db.saveLearningRecommendation({
        fingerprint: `operator-api-${Date.now()}`,
        category: 'format',
        title: 'Test evidence-backed recommendation',
        rationale: 'Created only for API contract verification.',
        evidence: { sampleSize: 4 },
        proposedChange: { target: 'future_plans', prefer: 'tutorial' },
        confidence: 'medium'
      });
      const approveLearning = await fetch(
        `http://127.0.0.1:${port}/api/learning/recommendations/${learningRecommendation.id}/approve`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      );
      const approvedLearning = await approveLearning.json();
      if (!approveLearning.ok || approvedLearning.result?.status !== 'approved') {
        throw new Error('Learning recommendation review API did not persist approval');
      }
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      if (job) await db.executeQuery('DELETE FROM generation_jobs WHERE id = ?', [job.id]);
      if (learningRecommendation) await db.executeQuery('DELETE FROM learning_recommendations WHERE id = ?', [learningRecommendation.id]);
      await db.close();
    }

    this.logger.info('Operator workflow API test completed successfully');
  }

  async testAutonomousChannelOperator() {
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
    const db = new Database();
    await db.initialize();
    const previousStrategy = await db.getChannelStrategy();
    let run;
    let recoverableJob;

    try {
      const strategy = await db.saveChannelStrategy({
        objective: 'Teach small teams to automate useful work',
        audience: 'Small business operators',
        valueProposition: 'Practical steps without hype',
        contentPillars: ['AI workflows', 'Automation playbooks'],
        cadencePerWeek: 2,
        videosPerRun: 2,
        defaultFormat: 'tutorial',
        defaultLength: 'short',
        successMetric: 'Returning viewers',
        constraints: 'Do not invent statistics',
        status: 'active'
      });
      if (strategy.contentPillars.length !== 2 || strategy.cadence_per_week !== 2) {
        throw new Error('Channel strategy was not persisted correctly');
      }

      const strategyAgent = new ContentStrategyAgent(db, {});
      // This test runs on the real database: the lesson cadence and measured gaps would otherwise depend on it.
      strategyAgent.lessonDue = async () => null;
      strategyAgent.openGaps = async () => [];
      strategyAgent.analyzeTrends = async function() {
        this.trendingTopics = [{
          topic: 'practical AI workflows', score: 8, sources: ['trending'],
          evidence: [{
            url: 'https://www.youtube.com/watch?v=research123',
            title: 'Practical AI workflows', publisher: 'Evidence channel', sourceType: 'video'
          }]
        }];
        this.competitorData = [];
      };
      // General YouTube trends are ignored by default (they leaked unrelated trailers into scripts)...
      const savedTrending = process.env.STRATEGY_USE_TRENDING;
      delete process.env.STRATEGY_USE_TRENDING;
      const nicheOnly = await strategyAgent.researchAndPlanChannel(strategy);
      if (nicheOnly.research.sources.includes('YouTube most-popular videos') || nicheOnly.research.sourceCatalog.length !== 0) {
        throw new Error('General YouTube trends were used without STRATEGY_USE_TRENDING');
      }
      // ...and still labeled as evidence when the operator opts in.
      process.env.STRATEGY_USE_TRENDING = 'true';
      let planned;
      try {
        planned = await strategyAgent.researchAndPlanChannel(strategy);
      } finally {
        if (savedTrending === undefined) delete process.env.STRATEGY_USE_TRENDING; else process.env.STRATEGY_USE_TRENDING = savedTrending;
      }
      if (
        planned.plan.length !== 2 || !planned.research.sources.includes('YouTube most-popular videos') ||
        planned.research.sourceCatalog.length !== 1 || planned.plan[0].sourceUrls.length !== 1
      ) {
        throw new Error('Strategy did not produce an evidence-labeled autonomous plan');
      }

      const receivedInputs = [];
      let resumedJobs = 0;
      const operator = new AutonomousChannelOperator(db, {
        researchAndPlan: async () => planned,
        startGenerationJob: async input => {
          receivedInputs.push(input);
          return { id: `fake-job-${receivedInputs.length}` };
        },
        waitForGenerationJob: async jobId => ({
          id: jobId,
          status: 'completed',
          production_id: `production-${jobId}`,
          details: { reviewStatus: 'needs_review' }
        }),
        resumeGenerationJob: async jobId => {
          resumedJobs++;
          await db.updateGenerationJob(jobId, { status: 'completed', productionId: `production-${jobId}` });
          return db.getGenerationJob(jobId);
        }
      });
      run = await operator.start(strategy);
      await operator.activeRuns.get(run.id);
      const completed = await db.getOperatorRun(run.id);
      if (
        completed.status !== 'waiting_review' ||
        completed.generatedJobs.length !== 2 ||
        receivedInputs.some(input => input.source !== 'autonomous_operator' || !input.strategyContext?.angle) ||
        receivedInputs[0].strategyContext.researchSources.length !== 1
      ) {
        throw new Error('Autonomous operator did not execute the planned workflow');
      }

      recoverableJob = await db.createGenerationJob({ topic: planned.plan[0].topic, source: 'autonomous_operator' });
      await db.updateGenerationJob(recoverableJob.id, { status: 'interrupted', stage: 'script' });
      const interruptedJobs = completed.generatedJobs.map((item, index) => index === 0
        ? { ...item, jobId: recoverableJob.id, status: 'interrupted', reviewStatus: null }
        : item);
      await db.updateOperatorRun(run.id, {
        status: 'interrupted',
        stage: 'producing_1_of_2',
        progress: 40,
        generatedJobs: interruptedJobs,
        error: 'The application restarted before this operator run finished',
        completedAt: new Date().toISOString()
      });
      await operator.resume(run.id, strategy);
      await operator.activeRuns.get(run.id);
      const recoveredRun = await db.getOperatorRun(run.id);
      if (resumedJobs !== 1 || recoveredRun.status !== 'waiting_review' || recoveredRun.generatedJobs[0].status !== 'completed') {
        throw new Error('Autonomous operator did not continue from its saved plan and interrupted job');
      }
    } finally {
      if (run) {
        const stored = await db.getOperatorRun(run.id);
        for (const item of stored?.generatedJobs || []) {
          if (item.ideaId) await db.executeQuery('DELETE FROM content_ideas WHERE id = ?', [item.ideaId]);
        }
        await db.executeQuery('DELETE FROM operator_runs WHERE id = ?', [run.id]);
      }
      if (previousStrategy) {
        await db.saveChannelStrategy({
          objective: previousStrategy.objective,
          audience: previousStrategy.audience,
          valueProposition: previousStrategy.value_proposition,
          contentPillars: previousStrategy.contentPillars,
          cadencePerWeek: previousStrategy.cadence_per_week,
          videosPerRun: previousStrategy.videos_per_run,
          defaultFormat: previousStrategy.default_format,
          defaultLength: previousStrategy.default_length,
          successMetric: previousStrategy.success_metric,
          constraints: previousStrategy.constraints,
          status: previousStrategy.status
        });
      } else {
        await db.executeQuery("DELETE FROM channel_strategies WHERE id = 'default'");
      }
      if (recoverableJob) await db.executeQuery('DELETE FROM generation_jobs WHERE id = ?', [recoverableJob.id]);
      await db.close();
    }

    this.logger.info('Autonomous channel operator test completed successfully');
  }

  async testChannelLearningLoop() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-learning-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'learning.db');
    await db.initialize();

    try {
      const learning = new ChannelLearningEngine(db);
      const report = (videoId, format, performanceScore, ctr, retention, simulated = false) => ({
        videoId,
        videoDetails: {
          title: `${format} automation guide`,
          publishedAt: new Date(Date.now() - 8 * 86400000).toISOString()
        },
        analytics: {
          simulated,
          views: { totalViews: 500, totalImpressions: 5000, averageCTR: ctr },
          watchTime: { averageViewPercentage: retention, averageViewDuration: 240, totalWatchTime: 2000 },
          engagement: { engagementRate: format === 'tutorial' ? 6 : 2 }
        },
        thumbnailMetrics: { impressions: 5000, clickThroughRate: ctr },
        performance: { score: performanceScore, grade: 'B' }
      });
      const context = format => ({
        strategy: { topic: `${format} topic`, contentType: format, requestedLengthKey: 'medium' },
        script: { hook: 'A concise opening that immediately promises a useful and concrete result.' },
        thumbnail: { concept: { composition: 'centered' } }
      });

      await learning.capture(report('learning-tutorial-1', 'tutorial', 88, 7.5, 62), context('tutorial'), '7d');
      await learning.capture(report('learning-tutorial-2', 'tutorial', 84, 7, 58), context('tutorial'), '7d');
      await learning.capture(report('learning-list-1', 'list', 52, 3.5, 39), context('list'), '7d');
      await learning.capture(report('learning-list-2', 'list', 48, 3, 35), context('list'), '7d');
      await learning.capture(report('learning-simulated', 'review', 99, 12, 90, true), context('review'), '7d');

      const summary = await learning.getSummary();
      const recommendation = summary.recommendations.find(item => item.category === 'format');
      if (summary.measuredVideos !== 4 || !recommendation || !/tutorial/.test(recommendation.title)) {
        throw new Error('Learning engine did not derive a real-evidence format recommendation');
      }
      if (summary.recommendations.some(item => /review/.test(item.title))) {
        throw new Error('Simulated analytics influenced a learning recommendation');
      }

      const approved = await db.reviewLearningRecommendation(recommendation.id, 'approved');
      if (approved.status !== 'approved') throw new Error('Learning recommendation approval was not persisted');

      const strategyAgent = new ContentStrategyAgent(db, {});
      strategyAgent.analyzeTrends = async function() {
        this.trendingTopics = [];
        this.competitorData = [];
      };
      const planned = await strategyAgent.researchAndPlanChannel({
        objective: 'Teach useful automation',
        audience: 'Small teams',
        value_proposition: 'Practical guidance',
        contentPillars: ['Automation'],
        videos_per_run: 1,
        default_format: 'tutorial',
        default_length: 'medium'
      });
      if (
        planned.research.approvedLearnings.length !== 1 ||
        !planned.research.sources.includes('Operator-approved channel performance learnings')
      ) {
        throw new Error('Approved learning was not supplied to autonomous planning');
      }

      const due = await learning.getDueMeasurementWindows({
        youtube_id: 'unmeasured-video',
        published_at: new Date(Date.now() - 8 * 86400000).toISOString()
      });
      if (!due.includes('24h') || !due.includes('7d')) {
        throw new Error('24-hour and 7-day learning windows were not scheduled');
      }

      const { YouTubeAutomationAgent } = require('./index');
      const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
      const workflow = new YouTubeAutomationAgent();
      const titleVariants = workflow.buildTitleExperimentVariants('Automate Your Weekly Reporting');
      const selected = workflow.validateEditorData(
        { selectedTitleVariant: 1, selectedThumbnailVariant: 2 },
        { packagingExperiment: { titleVariants, thumbnailVariants: [{}, {}, {}] } }
      );
      if (titleVariants.length !== 3 || selected.selectedTitleVariant !== 1 || selected.selectedThumbnailVariant !== 2) {
        throw new Error('Packaging experiment selections were not validated');
      }

      const thumbnailDesigner = new ThumbnailDesignerAgent(db, {});
      thumbnailDesigner.createThumbnail = async (_concept, suffix) => `base-${suffix}`;
      thumbnailDesigner.addTextOverlay = async (_path, _concept, suffix) => `overlay-${suffix}`;
      thumbnailDesigner.optimizeForYouTube = async (_path, suffix) => `optimized-${suffix}.jpg`;
      const thumbnailVariants = await thumbnailDesigner.generateABVariants({
        primaryText: 'GUIDE',
        colors: { primary: 'blue', secondary: 'white', accent: 'green' },
        composition: 'split'
      });
      if (thumbnailVariants.length !== 3 || thumbnailVariants.some(item => !item.path.endsWith('.jpg'))) {
        throw new Error('Approved packaging learning did not produce complete thumbnail variants');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Closed-loop channel learning test completed successfully');
  }

  async testGrowthExperimentsStudio() {
    const fs = require('fs').promises;
    const os = require('os');
    const { GrowthExperimentService } = require('./utils/growth-experiment-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-experiments-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'experiments.db');
    await db.initialize();
    const productionId = 'experiment-production';
    const thumbnails = await Promise.all(['control', 'variant-a', 'variant-b'].map(async name => {
      const file = path.join(directory, `${name}.jpg`);
      await fs.writeFile(file, Buffer.from(`thumbnail-${name}`));
      return file;
    }));

    try {
      await db.saveProductionData({
        id: productionId, status: 'published',
        assets: { thumbnail: { path: thumbnails[0] }, finalVideo: { path: 'fixture.mp4' } },
        timeline: {}, scheduledPublishTime: new Date().toISOString(), priority: 50, estimatedDuration: '8:00'
      });
      await db.saveProductionSnapshot({
        id: productionId,
        strategy: { topic: 'Controlled growth' },
        script: { title: 'Control title' },
        thumbnail: { path: thumbnails[0] },
        seo: { title: 'Control title', description: 'Fixture', tags: [] }
      });
      const sourceLearning = await db.saveLearningRecommendation({
        fingerprint: 'growth-experiment-source', category: 'packaging',
        title: 'Test packaging', rationale: 'CTR trails the channel baseline.',
        evidence: { measuredVideos: 4 }, proposedChange: { experiment: 'title_thumbnail_variant' }, confidence: 'medium'
      });
      await db.reviewLearningRecommendation(sourceLearning.id, 'approved');
      await db.saveContentReview(productionId, {
        status: 'approved',
        editorData: {
          packagingExperiment: {
            sourceRecommendationId: sourceLearning.id,
            hypothesis: 'A clearer promise improves qualified clicks.',
            titleVariants: [
              { label: 'Control', title: 'Control title' },
              { label: 'Clear benefit', title: 'A Clearer Automation Benefit' },
              { label: 'Curiosity', title: 'The Automation Detail You Missed' }
            ],
            thumbnailVariants: [
              { label: 'Control', path: thumbnails[0] },
              { label: 'Clear benefit', path: thumbnails[1] },
              { label: 'Curiosity', path: thumbnails[2] }
            ]
          }
        }
      });
      const schedule = await db.saveScheduleEntry({
        productionId, title: 'Control title', publishTime: new Date(Date.now() - 8 * 86400000).toISOString(),
        status: 'published', priority: 50,
        metadata: { seo: { title: 'Control title', description: 'Fixture', tags: [] }, thumbnail: { path: thumbnails[0] } }
      });
      schedule.status = 'published';
      schedule.youtubeId = 'youtube-experiment-1';
      schedule.youtubeUrl = 'https://www.youtube.com/watch?v=youtube-experiment-1';
      schedule.publishedAt = new Date(Date.now() - 8 * 86400000).toISOString();
      await db.updateScheduleEntry(schedule);

      const cumulative = [
        { impressions: 10000, clicks: 500, views: 700 },
        { impressions: 11000, clicks: 550, views: 770 },
        { impressions: 12000, clicks: 650, views: 860 },
        { impressions: 13000, clicks: 690, views: 920 }
      ];
      let reportIndex = 0;
      const analytics = {
        analyzeVideoPerformance: async () => {
          const point = cumulative[Math.min(reportIndex++, cumulative.length - 1)];
          return {
            analytics: {
              simulated: false,
              views: { totalViews: point.views, totalImpressions: point.impressions, averageCTR: point.clicks / point.impressions * 100 },
              watchTime: { totalWatchTime: point.views * 4, averageViewPercentage: 55 },
              engagement: { engagementRate: 4.5 },
              outcomes: { netSubscribers: Math.floor(point.views / 100), estimatedRevenue: point.views / 100 }
            },
            thumbnailMetrics: { impressions: point.impressions, clickThroughRate: point.clicks / point.impressions * 100 }
          };
        }
      };
      const applied = [];
      const publishing = {
        applyVideoPackaging: async (videoId, packaging) => applied.push({ videoId, ...packaging })
      };
      let clock = Date.now();
      const service = new GrowthExperimentService(db, analytics, publishing, { now: () => new Date(clock) });
      let experiment = await service.create({ productionId, armDurationHours: 24, minImpressions: 100 });
      if (experiment.status !== 'draft' || experiment.arms.length !== 3 || !experiment.arms[0].isControl) {
        throw new Error('Experiment plan did not persist a control and complete variant arms');
      }

      let confirmationBlocked = false;
      try { await service.approve(experiment.id); } catch (error) { confirmationBlocked = error.code === 'EXPERIMENT_CONFIRMATION_REQUIRED'; }
      if (!confirmationBlocked) throw new Error('Experiment approval did not require explicit confirmation');
      experiment = await service.approve(experiment.id, { confirmed: true });
      experiment = await service.start(experiment.id, { confirmed: true });
      if (experiment.status !== 'running' || applied.length !== 1) throw new Error('Approved experiment did not start on its control arm');

      for (let index = 0; index < 3; index++) {
        clock += 24 * 3600000;
        experiment = await service.refresh(experiment.id);
      }
      if (
        experiment.status !== 'awaiting_winner' || !experiment.winningArmId ||
        experiment.arms.find(arm => arm.id === experiment.winningArmId)?.label !== 'Clear benefit' ||
        experiment.result.guardrails.passed !== true || applied.at(-1).title !== 'Control title'
      ) {
        throw new Error('Experiment did not select an evidence-backed winner and restore the control');
      }

      experiment = await service.adoptWinner(experiment.id, { confirmed: true });
      const learned = (await db.listLearningRecommendations({ status: 'approved', limit: 20 }))
        .find(item => item.evidence?.experimentId === experiment.id);
      if (experiment.status !== 'adopted' || !learned || applied.at(-1).title !== 'A Clearer Automation Benefit') {
        throw new Error('Winner adoption did not update packaging and approve the resulting learning');
      }

      const storedSamples = await db.listExperimentSamples(experiment.id);
      if (storedSamples.length < 6 || storedSamples.some(sample => !Number.isFinite(sample.metrics.impressions))) {
        throw new Error('Experiment evidence samples were not durably stored');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Controlled Growth Experiments Studio test completed successfully');
  }

  async testOutcomeROIStudio() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
    const { YouTubeAutomationAgent } = require('./index');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-outcomes-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'outcomes.db');
    await db.initialize();

    try {
      const validated = new YouTubeAutomationAgent().validateChannelStrategy({
        objective: 'Grow a durable automation audience', audience: 'Small teams',
        contentPillars: ['Automation', 'Tool reviews'], primaryKpi: 'subscribers',
        targetValue: 40, targetWindowDays: 28, monthlyBudget: 100,
        outcomeCurrency: 'USD', status: 'active'
      });
      const strategy = await db.saveChannelStrategy(validated);
      if (strategy.primary_kpi !== 'subscribers' || strategy.target_value !== 40 || strategy.target_window_days !== 28) {
        throw new Error('Structured outcome strategy was not validated and persisted');
      }

      const learning = new ChannelLearningEngine(db);
      const report = (videoId, format, subscribers, revenue) => ({
        videoId,
        videoDetails: { title: `${format} outcome fixture`, publishedAt: new Date(Date.now() - 8 * 86400000).toISOString() },
        analytics: {
          simulated: false,
          views: { totalViews: 1000, totalImpressions: 10000, averageCTR: 5 },
          watchTime: { averageViewPercentage: 45, averageViewDuration: 240, totalWatchTime: 4000 },
          engagement: { engagementRate: 4 },
          outcomes: {
            subscribersAvailable: true, subscribersGained: subscribers + 1, subscribersLost: 1,
            netSubscribers: subscribers, revenueAvailable: true, estimatedRevenue: revenue,
            monetizedPlaybacks: 500, playbackBasedCpm: 8, currency: 'USD'
          }
        },
        thumbnailMetrics: { impressions: 10000, clickThroughRate: 5 },
        performance: { score: 70, grade: 'B' }
      });
      const context = (format, pillar) => ({
        strategy: { topic: `${format} topic`, contentType: format, requestedLengthKey: 'medium', contentPillar: pillar },
        script: { hook: 'A concise, outcome-aligned opening.' },
        thumbnail: { concept: { composition: 'centered' } },
        productionCost: { amount: 2, currency: 'USD', complete: true, providers: ['fixture-video'] }
      });
      await learning.capture(report('outcome-tutorial-1', 'tutorial', 12, 5), context('tutorial', 'Automation'), '7d');
      await learning.capture(report('outcome-tutorial-2', 'tutorial', 10, 5), context('tutorial', 'Automation'), '7d');
      await learning.capture(report('outcome-list-1', 'list', 2, 5), context('list', 'Tool reviews'), '7d');
      await learning.capture(report('outcome-list-2', 'list', 1, 5), context('list', 'Tool reviews'), '7d');

      const summary = await learning.getSummary();
      const recommendation = summary.recommendations.find(item => item.category === 'outcome_alignment');
      if (
        summary.outcome.goal.id !== 'subscribers' || summary.outcome.observed !== 25 ||
        summary.outcome.progressPercent !== 62.5 || summary.outcome.economics.roi !== 150 ||
        !recommendation || recommendation.status !== 'pending' || recommendation.proposedChange.autoApply !== false
      ) {
        throw new Error('Outcome evidence did not produce the expected goal scorecard and approval-gated recommendation');
      }

      const analytics = new AnalyticsOptimizationAgent(db, { getYouTubeAuth: () => ({}) });
      analytics.youtubeAnalytics = {
        reports: {
          query: async ({ metrics }) => {
            if (metrics.includes('estimatedRevenue')) throw new Error('not monetized');
            return { data: { rows: [[7, 2]] } };
          }
        }
      };
      const outcomes = await analytics.getOutcomeAnalytics('outcome-video', '2026-08-01', '2026-08-07');
      if (!outcomes.subscribersAvailable || outcomes.netSubscribers !== 5 || outcomes.revenueAvailable || outcomes.estimatedRevenue !== null) {
        throw new Error('Unavailable monetization evidence was converted into a false zero');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Outcome and ROI Studio test completed successfully');
  }

  async testSceneAwareRetentionStudio() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-retention-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'retention.db');
    await db.initialize();

    try {
      const learning = new ChannelLearningEngine(db);
      const points = Array.from({ length: 100 }, (_, index) => {
        const elapsedRatio = (index + 1) / 100;
        let audienceWatchRatio;
        let relativeRetentionPerformance;
        if (elapsedRatio <= 0.17) {
          audienceWatchRatio = 1 - elapsedRatio * 0.4;
          relativeRetentionPerformance = 0.64;
        } else if (elapsedRatio <= 0.5) {
          audienceWatchRatio = 0.93 - ((elapsedRatio - 0.17) / 0.33) * 0.48;
          relativeRetentionPerformance = 0.31;
        } else {
          audienceWatchRatio = 0.45 - (elapsedRatio - 0.5) * 0.08;
          relativeRetentionPerformance = 0.7;
        }
        return {
          elapsedRatio,
          audienceWatchRatio,
          relativeRetentionPerformance,
          startedWatching: index === 0 ? 800 : 0,
          stoppedWatching: elapsedRatio > 0.17 && elapsedRatio <= 0.5 ? 5 : 1,
          totalSegmentImpressions: 800
        };
      });
      const context = {
        productionId: 'retention-production',
        contentFormat: 'long_form',
        title: 'Scene retention fixture',
        publishedAt: new Date(Date.now() - 8 * 86400000).toISOString(),
        retentionDuration: 90,
        retentionScenes: [
          { id: 'scene-hook', position: 0, label: 'Hook', duration: 15 },
          { id: 'scene-intro', position: 1, label: 'Introduction', duration: 30 },
          { id: 'scene-demo', position: 2, label: 'Demonstration', duration: 45 }
        ]
      };
      const snapshot = await learning.captureRetention({
        available: true,
        simulated: false,
        videoId: 'retention-video-1',
        title: context.title,
        publishedAt: context.publishedAt,
        durationSeconds: 90,
        points
      }, context, '7d', { views: 800, impressions: 12000 });

      if (
        !snapshot || snapshot.points.length !== 100 || snapshot.sceneMetrics.length !== 3 ||
        snapshot.summary.primaryDropoff?.id !== 'scene-intro' || snapshot.confidence !== 'high'
      ) {
        throw new Error('The real retention curve was not mapped to the expected scene evidence');
      }
      const recommendation = (await db.listLearningRecommendations({ limit: 20 }))
        .find(item => item.category === 'scene_retention');
      if (!recommendation || recommendation.status !== 'pending' || recommendation.proposedChange.autoEditPublishedContent !== false) {
        throw new Error('Scene retention learning bypassed pending review or published-content safety');
      }
      const approvedBeforeReview = await db.listLearningRecommendations({ status: 'approved', limit: 20 });
      if (approvedBeforeReview.some(item => item.id === recommendation.id)) {
        throw new Error('Pending scene retention learning entered autonomous planning');
      }
      await db.reviewLearningRecommendation(recommendation.id, 'approved');
      const approvedAfterReview = await db.listLearningRecommendations({ status: 'approved', limit: 20 });
      if (!approvedAfterReview.some(item => item.id === recommendation.id)) {
        throw new Error('Approved scene retention learning was not made available to planning');
      }

      const skipped = await learning.captureRetention({
        available: true,
        simulated: true,
        videoId: 'retention-simulated',
        durationSeconds: 90,
        points
      }, context, '7d', { views: 1000 });
      if (skipped !== null || (await db.listRetentionSnapshots({ limit: 10 })).length !== 1) {
        throw new Error('Simulated retention evidence was persisted');
      }

      const clipped = db.buildRetentionSceneContext(context.retentionScenes, {
        startSeconds: 10,
        duration: 35,
        sourceSceneIds: ['scene-hook', 'scene-intro']
      });
      if (clipped.length !== 2 || clipped[0].duration !== 5 || clipped[1].duration !== 30) {
        throw new Error('Shorts retention context did not clip the source scene timeline correctly');
      }

      const analytics = new AnalyticsOptimizationAgent(db, { getYouTubeAuth: () => ({}) });
      analytics.youtubeAnalytics = {
        reports: {
          query: async () => ({
            data: {
              columnHeaders: [
                'elapsedVideoTimeRatio', 'audienceWatchRatio', 'relativeRetentionPerformance',
                'startedWatching', 'stoppedWatching', 'totalSegmentImpressions'
              ].map(name => ({ name })),
              rows: [[0.01, 0.99, 0.7, 10, 1, 10]]
            }
          })
        }
      };
      const apiCurve = await analytics.getAudienceRetention('fixture-video', null, 'PT2M30S');
      if (!apiCurve.available || apiCurve.durationSeconds !== 150 || apiCurve.points[0].audienceWatchRatio !== 0.99) {
        throw new Error('YouTube audience retention response was not normalized correctly');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Scene-Aware Retention Studio test completed successfully');
  }

  async testProductionReadinessGate() {
    const fs = require('fs').promises;
    const os = require('os');
    let savedRun = null;
    const db = {
      generateId: () => 'readiness_test',
      saveReadinessRun: async run => {
        savedRun = {
          ...run,
          started_at: run.startedAt,
          completed_at: run.completedAt
        };
        return savedRun;
      },
      getLatestReadinessRun: async () => savedRun
    };
    const passingProbe = label => async () => ({ message: `${label} verified` });
    const service = new ProductionReadinessService(db, { credentials: {} }, {
      probes: {
        text: passingProbe('Text'),
        image: passingProbe('Image'),
        videoProvider: passingProbe('Video provider'),
        narration: passingProbe('Narration'),
        videoAssembly: passingProbe('Video'),
        youtube: passingProbe('YouTube'),
        metadata: passingProbe('Metadata')
      }
    });
    const passed = await service.run({ includePaidMedia: true });
    if (passed.status !== 'passed' || passed.checks.length !== 7 || !savedRun) {
      throw new Error('A successful readiness run was not persisted correctly');
    }
    await service.assertReady('Test automation');

    const failingService = new ProductionReadinessService(db, { credentials: {} }, {
      probes: {
        text: passingProbe('Text'),
        image: passingProbe('Image'),
        videoProvider: passingProbe('Video provider'),
        narration: passingProbe('Narration'),
        videoAssembly: passingProbe('Video'),
        youtube: async () => { throw new Error('token rejected sk-secret-value'); },
        metadata: passingProbe('Metadata')
      }
    });
    const failed = await failingService.run();
    if (failed.status !== 'failed' || failed.blockingFailures[0] !== 'youtube_access') {
      throw new Error('A blocking readiness probe did not fail closed');
    }
    if (failed.checks.find(check => check.id === 'youtube_access').message.includes('sk-secret-value')) {
      throw new Error('Readiness diagnostics did not redact a provider-shaped secret');
    }
    let blocked = false;
    try {
      await failingService.assertReady('Test publishing');
    } catch (error) {
      blocked = error.status === 409;
    }
    if (!blocked) throw new Error('Failed readiness did not block protected automation');

    const tags = normalizeTags(['#Automation', 'automation', 'bad"tag', 'x'.repeat(140)]);
    const metadata = validateYouTubeMetadata({
      title: 'A valid title',
      description: 'A valid upload description.',
      tags,
      metadata: { category: 22, language: 'en' }
    });
    if (!metadata.valid || tags[0] !== 'Automation' || tags.includes('automation') || tags.some(tag => tag.includes('"') || tag.length > 100)) {
      throw new Error('YouTube metadata normalization is unsafe or invalid');
    }

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-readiness-db-'));
    const persistenceDb = new Database();
    persistenceDb.dbPath = path.join(directory, 'readiness.db');
    try {
      await persistenceDb.initialize();
      await persistenceDb.saveReadinessRun(passed);
      const persisted = await persistenceDb.getLatestReadinessRun();
      if (persisted?.id !== passed.id || persisted.checks.length !== 7 || persisted.summary.passed !== 7) {
        throw new Error('Readiness evidence did not round-trip through SQLite');
      }
    } finally {
      await persistenceDb.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Production readiness gate test completed successfully');
  }

  async testVideoProviderLayer() {
    const fs = require('fs').promises;
    const os = require('os');
    const { runFFmpeg, checkFFmpeg } = require('./utils/ffmpeg');
    const { MediaGenerationService } = require('./utils/media-generation-service');
    const {
      VideoProvider, VideoProviderRegistry, SeedanceProvider, MiniMaxH3Provider,
      GoogleOmniProvider, KlingProvider, WanProvider
    } = require('./utils/video-providers');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-media-provider-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'media.db');
    await db.initialize();
    const job = await db.createGenerationJob({ topic: 'Provider durability test' });
    const source = path.join(directory, 'source.mp4');
    let createCalls = 0;
    let pollCalls = 0;

    try {
      if (!(await checkFFmpeg())) {
        this.logger.warn('Skipping provider MP4 durability assertion because FFmpeg is unavailable');
        return;
      }
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=1', '-c:v', 'mpeg4', source]);
      const fake = new VideoProvider('seedance', {
        model: 'bytedance/seedance-2.5',
        capabilities: { minDuration: 4, maxDuration: 30, cancellation: true }
      });
      fake.isAvailable = () => true;
      fake.createTask = async () => {
        createCalls++;
        return { externalTaskId: 'prediction-1', status: 'queued' };
      };
      fake.getTask = async id => {
        pollCalls++;
        return { externalTaskId: id, status: 'succeeded', outputUrl: 'fake://video' };
      };
      fake.downloadResult = async (_task, outputPath) => {
        await fs.copyFile(source, outputPath);
        return outputPath;
      };
      const registry = new VideoProviderRegistry({}, { providers: { seedance: fake } });
      const service = new MediaGenerationService(db, {}, { registry, pollIntervalMs: 10, sleep: async () => {} });
      const output = path.join(directory, 'output.mp4');
      const input = {
        jobId: job.id,
        productionId: 'prod-provider-test',
        scene: { index: 0 },
        provider: fake,
        outputPath: output,
        request: { prompt: 'A red frame', duration: 4, resolution: '720p', aspectRatio: '16:9' }
      };
      const first = await service.generateClip(input);
      const second = await service.generateClip(input);
      const tasks = await db.listMediaGenerationTasks(job.id);
      if (createCalls !== 1 || pollCalls !== 1 || !second.reused || tasks.length !== 1) {
        throw new Error('A completed provider task was duplicated instead of being reused');
      }
      if (first.task.external_task_id !== 'prediction-1' || tasks[0].model !== 'bytedance/seedance-2.5') {
        throw new Error('Provider task identity and model evidence did not persist');
      }
      const providers = registry.list();
      for (const id of ['seedance', 'minimax_h3', 'google_omni', 'kling', 'wan', 'slideshow']) {
        if (!providers.find(provider => provider.id === id)) throw new Error(`Missing video provider: ${id}`);
      }
      const shortOnly = new VideoProvider('wan', { model: 'wan-test', capabilities: { minDuration: 2, maxDuration: 15, firstFrame: true } });
      shortOnly.isAvailable = () => true;
      const routed = new VideoProviderRegistry({}, { providers: { seedance: fake, wan: shortOnly } });
      if (routed.select('auto', ['wan', 'seedance'], { duration: 20 }).id !== 'seedance') {
        throw new Error('Automatic video routing ignored the requested duration capability');
      }
      if (routed.select('auto', ['seedance', 'wan'], { duration: 8, generateAudio: true }).id !== 'slideshow') {
        throw new Error('Automatic video routing selected a provider without requested native audio support');
      }
      const listedJob = (await db.listGenerationJobs(10)).find(item => item.id === job.id);
      if (listedJob?.mediaTasks?.length !== 1 || listedJob.mediaTasks[0].external_task_id !== 'prediction-1') {
        throw new Error('Generation job history did not expose its durable provider task');
      }

      let seedanceSubmission;
      const seedance = new SeedanceProvider({}, { client: { predictions: {
        create: async submission => {
          seedanceSubmission = submission;
          return { id: 'seedance-task', status: 'starting' };
        }
      } } });
      const seedanceTask = await seedance.createTask({ prompt: 'Seedance scene', duration: 30, aspectRatio: '16:9' });
      if (seedanceTask.externalTaskId !== 'seedance-task' || seedanceSubmission.model !== 'bytedance/seedance-2.5' || seedanceSubmission.input.duration !== 30) {
        throw new Error('Seedance adapter did not submit the expected Replicate task');
      }
      const fileOutput = seedance.normalizeTask({ id: 'file-output', status: 'succeeded', output: { url: () => new URL('https://example.com/video.mp4') } });
      if (fileOutput.outputUrl !== 'https://example.com/video.mp4') throw new Error('Seedance FileOutput was not normalized');

      let minimaxBody;
      const minimax = new MiniMaxH3Provider({}, { apiKey: 'test', http: {
        post: async (_url, body) => { minimaxBody = body; return { data: { task_id: 'h3-task' } }; }
      } });
      const minimaxTask = await minimax.createTask({ prompt: 'H3 scene', duration: 15, resolution: '2K', aspectRatio: '9:16' });
      if (minimaxTask.externalTaskId !== 'h3-task' || minimaxBody.model !== 'MiniMax-H3' || minimaxBody.content[0].type !== 'text') {
        throw new Error('MiniMax H3 adapter did not submit the expected multimodal task');
      }

      let googleName;
      const google = new GoogleOmniProvider({}, { client: {
        interactions: { create: async () => ({ id: 'omni-task', output_video: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/omni-file:download?alt=media' } }) },
        files: { get: async ({ name }) => { googleName = name; return { state: { name: 'ACTIVE' } }; } }
      } });
      const googleTask = await google.createTask({ prompt: 'Omni scene', aspectRatio: '16:9' });
      await google.getTask(googleTask.externalTaskId);
      if (googleTask.status !== 'queued' || googleName !== 'files/omni-file') throw new Error('Gemini Omni URI task was not normalized for polling');

      let klingBody;
      const kling = new KlingProvider({}, { accessKey: 'access', secretKey: 'secret', http: {
        post: async (_url, body) => { klingBody = body; return { data: { data: { task_id: 'kling-task' } } }; }
      } });
      const klingTask = await kling.createTask({ prompt: 'Kling scene', duration: 8, aspectRatio: '16:9' });
      if (klingTask.externalTaskId !== 'kling-task' || klingBody.model_name !== 'kling-v3-omni' || klingBody.sound !== 'off') {
        throw new Error('Kling adapter did not submit the expected task');
      }

      let wanBody;
      const wan = new WanProvider({}, { apiKey: 'test', http: {
        post: async (_url, body) => { wanBody = body; return { data: { output: { task_id: 'wan-task' } } }; }
      } });
      const wanTask = await wan.createTask({ prompt: 'Wan scene', duration: 10, resolution: '720p', aspectRatio: '16:9' });
      if (wanTask.externalTaskId !== 'wan-task' || wanBody.model !== 'wan2.7-t2v-2026-06-12' || wanBody.parameters.resolution !== '720P') {
        throw new Error('Wan adapter did not submit the expected task-specific model payload');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Durable multi-provider video generation test completed successfully');
  }

  async testSceneRepairStudio() {
    const fs = require('fs').promises;
    const os = require('os');
    const sharp = require('sharp');
    const { SceneRepairService, buildInitialSceneManifest } = require('./utils/scene-repair-service');
    const { OperatorService } = require('./utils/operator-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-scene-repair-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'scenes.db');
    await db.initialize();

    try {
      const imagePath = path.join(directory, 'scene.png');
      const oldVideoPath = path.join(directory, 'old.mp4');
      const originalAudioPath = path.join(directory, 'original.mp3');
      await sharp({ create: { width: 320, height: 180, channels: 3, background: '#203a5f' } }).png().toFile(imagePath);
      await fs.writeFile(oldVideoPath, Buffer.from('previous final video'));
      await fs.writeFile(originalAudioPath, Buffer.from('previous narration'));
      const production = {
        id: `prod_scene_${Date.now()}`,
        status: 'ready',
        script: {
          title: 'Repair one scene',
          fullScript: 'A complete factual-review-safe script for testing selective scene repair without replacing the entire production.',
          hook: { text: 'Fix one weak moment without starting over.' },
          introduction: { greeting: 'Hello.', topicIntro: 'Scene repair matters.', valueProposition: 'Save time and credits.' },
          mainContent: { sections: [
            { title: 'Selective repair', content: 'Keep the scenes that work and replace only the scene that does not.' },
            { title: 'Examples', content: ['Example 1: [Specific case study]', 'A real example without template markers.'] }
          ] },
          conclusion: { recap: ['Preserve good work.'], finalThought: 'Review the repaired timeline.' },
          callToAction: {
            type: 'call_to_action', duration: '15 seconds', subscribe: 'Subscribe.', like: 'Like.',
            comment: 'Comment.', nextVideo: 'Watch the next video.'
          }
        },
        seo: { title: 'Repair one scene', description: 'A detailed description of selective scene repair for video production workflows.', tags: ['video', 'repair', 'workflow'] },
        strategy: { topic: 'Selective scene repair' },
        assets: {
          video: { visualAssets: [imagePath] },
          audio: { path: originalAudioPath, status: 'ready', simulated: false, provider: 'fixture-tts', model: 'fixture-voice' },
          thumbnail: { path: imagePath },
          finalVideo: { path: oldVideoPath, simulated: false, duration: '1:00', provider: { actualProvider: 'slideshow' } }
        },
        timeline: { readyForUpload: new Date().toISOString() },
        scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(),
        priority: 50,
        estimatedDuration: '1:00'
      };
      await db.saveProductionData(production);
      await db.saveProductionSnapshot(production);
      await db.saveContentReview(production.id, { status: 'needs_review', editorData: {}, qualityChecks: [] });
      await db.saveContentProvenance(production.id, {
        sources: [], claims: [], containsSyntheticMedia: false, status: 'not_required',
        summary: { sourceCount: 0, verifiedSources: 0, claimCount: 0, resolvedClaims: 0, highRiskClaims: 0, unresolvedClaims: 0 }
      });
      await db.saveChannelProfile({ channelName: 'Test channel', visualStyle: 'animated' });

      const manifest = buildInitialSceneManifest(production, { actualProvider: 'slideshow', model: 'local-ffmpeg' });
      if (manifest.length < 3 || manifest.some(scene => scene.assetPath !== imagePath)) {
        throw new Error('Initial scene manifest did not preserve the script structure and visual assets');
      }
      const examplesScene = manifest.find(scene => scene.label === 'Examples');
      const ctaScene = manifest.find(scene => scene.label === 'Call to action');
      if (/\[[^\]]*\]/.test(examplesScene?.scriptText || '') || examplesScene?.scriptText !== 'A real example without template markers.') {
        throw new Error('Template placeholders leaked into scene narration');
      }
      if (ctaScene?.scriptText !== 'Subscribe. Like. Comment. Watch the next video.') {
        throw new Error('Call-to-action metadata leaked into spoken narration');
      }
      // The image model writes (and misspells) any sentence it is given: the closing scene reuses the previous image.
      const ctaPlan = require('./utils/scene-repair-service').scriptScenes(production.script).find(scene => scene.label === 'Call to action');
      if (/subscribe|watch/i.test(ctaPlan?.prompt || '') || ctaPlan?.illustration !== 'previous') {
        throw new Error('The call-to-action image prompt must not carry the spoken sentence');
      }
      await db.replaceProductionScenes(production.id, manifest);
      for (const scene of await db.listProductionScenes(production.id)) {
        await db.updateProductionScene(production.id, scene.id, {
          audioPath: originalAudioPath, narrationStatus: 'current',
          narrationProvider: 'fixture-tts', narrationModel: 'fixture-voice'
        });
      }
      const roundTrip = await db.listProductionScenes(production.id);
      if (roundTrip.length !== manifest.length || roundTrip[0].scriptText !== manifest[0].scriptText) {
        throw new Error('Scene manifest did not round-trip through SQLite');
      }

      const fakeProvider = {
        id: 'seedance', model: 'seedance-test',
        normalizeRequest: request => ({ ...request, duration: Math.min(4, Number(request.duration || 4)) })
      };
      let useSlideshow = false;
      let regeneratedVisualStyle = null;
      const fakeGenerator = {
        mediaGeneration: {
          settings: async () => ({ provider: 'seedance', order: ['seedance'], clipDuration: 4, resolution: '720p', aspectRatio: '16:9' }),
          registry: { select: () => useSlideshow ? { id: 'slideshow' } : fakeProvider, get: () => fakeProvider },
          generateClip: async ({ outputPath }) => {
            await fs.mkdir(path.dirname(outputPath), { recursive: true });
            await fs.writeFile(outputPath, Buffer.from('generated scene video'));
            return { outputPath, task: { model: fakeProvider.model, external_task_id: 'scene-task-1' } };
          },
          isValidVideo: async () => true
        },
        generateVisualAssets: async (_prompt, style) => { regeneratedVisualStyle = style; return [imagePath]; },
        async generateTTSAudio(_text, outputPath) {
          await fs.writeFile(outputPath, Buffer.from('scene narration'));
          this.lastNarrationResult = {
            status: 'ready', path: outputPath, provider: 'fixture-tts', model: 'fixture-voice-v2',
            externalTaskId: 'narration-task-1', generatedAt: new Date().toISOString(),
            cost: { provider: 'fixture-tts', amount: null, invoiceRequired: true }
          };
          return outputPath;
        },
        isUsableAudioFile: async filePath => Boolean(filePath && await fs.stat(filePath).then(stat => stat.size > 0).catch(() => false)),
        renderMediaTimeline: async (_segments, outputPath) => { await fs.writeFile(outputPath, Buffer.from('rebuilt visual timeline')); return outputPath; },
        addAudioToVideo: async (videoPath, _audioPath, outputPath) => { await fs.copyFile(videoPath, outputPath); return outputPath; }
      };
      const service = new SceneRepairService(db, fakeGenerator, { dataRoot: directory, logger: this.logger });
      service.rebuildNarration = async () => originalAudioPath;
      const first = roundTrip[0];
      const edited = await service.updateScene(production.id, first.id, {
        scriptText: `${first.scriptText} Updated narration.`, prompt: `${first.prompt} Brighter composition.`, factualChange: false
      });
      if (edited.status !== 'visual_stale' || edited.narrationStatus !== 'stale' || edited.revision !== first.revision + 1) {
        throw new Error('Scene edits did not invalidate only the scene rebuild and narration state');
      }

      const quality = await new OperatorService(db).runQualityChecks({ ...(await db.getProductionBundle(production.id)), scenes: await db.listProductionScenes(production.id) }, {});
      if (quality.passed || !quality.blockingFailures.includes('scene_integrity')) {
        throw new Error('Approval quality checks did not block an unrepaired scene');
      }
      const estimate = await service.regenerationEstimate(production.id, first.id);
      if (!estimate.paid || estimate.provider !== 'seedance') throw new Error('Paid scene estimate did not expose provider billing risk');
      let paidBlocked = false;
      try {
        await service.regenerate(production.id, first.id, { regenerateNarration: true });
      } catch (error) {
        paidBlocked = error.code === 'PAID_CONFIRMATION_REQUIRED';
      }
      if (!paidBlocked) throw new Error('Paid scene regeneration started without explicit confirmation');
      const regenerated = await service.regenerate(production.id, first.id, { confirmPaid: true, regenerateNarration: true });
      if (
        regenerated.scene.status !== 'needs_rebuild' || regenerated.scene.externalTaskId !== 'scene-task-1' ||
        regenerated.scene.narrationStatus !== 'current' || regenerated.scene.narrationProvider !== 'fixture-tts' ||
        regenerated.scene.narrationTaskId !== 'narration-task-1'
      ) {
        throw new Error('Confirmed selective regeneration did not persist visual and narration evidence');
      }
      useSlideshow = true;
      await service.regenerate(production.id, roundTrip[1].id);
      if (regeneratedVisualStyle !== 'animated') {
        throw new Error('Scene regeneration ignored the configured channel visual style');
      }

      const second = roundTrip[1];
      const replacement = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#ad3d45' } }).png().toBuffer();
      let rightsBlocked = false;
      try {
        await service.replaceAsset(production.id, second.id, { buffer: replacement, contentType: 'image/png', filename: 'replacement.png' });
      } catch (error) {
        rightsBlocked = error.code === 'RIGHTS_CONFIRMATION_REQUIRED';
      }
      if (!rightsBlocked) throw new Error('Uploaded scene asset bypassed rights confirmation');
      const replaced = await service.replaceAsset(production.id, second.id, {
        buffer: replacement, contentType: 'image/png', filename: 'replacement.png', rightsConfirmed: true
      });
      if (replaced.assetOrigin !== 'uploaded' || !replaced.rightsConfirmed || replaced.status !== 'needs_rebuild') {
        throw new Error('Replacement asset evidence did not persist');
      }

      const ordered = await service.reorder(production.id, (await db.listProductionScenes(production.id)).map(scene => scene.id).reverse());
      if (ordered[0].id === first.id) throw new Error('Scene timeline order did not persist');
      const rebuilt = await service.rebuild(production.id);
      const finalBundle = await db.getProductionBundle(production.id);
      if (!rebuilt.finalVideo || finalBundle.assets.finalVideo.previousPath !== oldVideoPath || finalBundle.scenes.some(scene => scene.status !== 'ready')) {
        throw new Error('Scene rebuild did not preserve the prior video and finalize every scene');
      }
      // A Short stays a Short: a rebuild lays the repaired scenes out vertically again, into new files.
      await db.updateProductionData({
        id: production.id, status: 'ready', timeline: finalBundle.timeline || {},
        assets: { ...finalBundle.assets, finalVideo: { ...finalBundle.assets.finalVideo, aspectRatio: '9:16', resolution: '1080x1920' } },
        scheduledPublishTime: finalBundle.scheduled_publish_time, priority: finalBundle.priority
      });
      const verticalRenders = [];
      service.renderShort = async (rebuiltProduction, rebuiltScenes, options) => {
        const file = path.join(options.directory, `${rebuiltProduction.id}_short${options.suffix}.mp4`);
        await fs.writeFile(file, 'vertical');
        verticalRenders.push({ landscape: rebuiltProduction.assets.finalVideo.path, scenes: rebuiltScenes.length });
        return { path: file, format: 'mp4', aspectRatio: '9:16', resolution: '1080x1920', duration: 90, layout: 'montage', captionsPath: null };
      };
      const rebuiltShort = await service.rebuild(production.id);
      const shortBundle = await db.getProductionBundle(production.id);
      if (verticalRenders.length !== 1 || verticalRenders[0].landscape !== rebuiltShort.finalVideo || shortBundle.assets.finalVideo.aspectRatio !== '9:16' ||
        !/_short_repair_\d+\.mp4$/.test(shortBundle.assets.finalVideo.path) || shortBundle.assets.landscapeVideo?.path !== rebuiltShort.finalVideo ||
        shortBundle.assets.landscapeVideo.aspectRatio !== '16:9') {
        throw new Error('A repaired Short was not laid out vertically again');
      }
      const revisions = await db.listProductionSceneRevisions(production.id);
      for (const action of ['edit', 'regenerate', 'replace_asset', 'reorder', 'rebuild']) {
        if (!revisions.some(revision => revision.action === action)) throw new Error(`Scene revision history is missing ${action}`);
      }

      const locked = await service.updateScene(production.id, ordered[0].id, { locked: true });
      let lockBlocked = false;
      try {
        await service.updateScene(production.id, locked.id, { prompt: 'Unauthorized locked edit' });
      } catch (error) {
        lockBlocked = error.status === 409;
      }
      if (!lockBlocked) throw new Error('Locked scene accepted an edit');
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Scene Repair Studio test completed successfully');
  }

  async testNarrationReliability() {
    const fs = require('fs').promises;
    const os = require('os');
    const { SceneRepairService } = require('./utils/scene-repair-service');
    const { OperatorService } = require('./utils/operator-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-narration-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'narration.db');
    await db.initialize();

    try {
      const productionId = 'prod-narration-recovery';
      const visualPath = path.join(directory, 'scene.png');
      const videoPath = path.join(directory, 'video.mp4');
      await fs.writeFile(visualPath, Buffer.from('visual'));
      await fs.writeFile(videoPath, Buffer.from('video'));
      const production = {
        id: productionId, status: 'ready',
        strategy: { topic: 'Narration recovery' },
        script: {
          title: 'Narration recovery',
          fullScript: 'A complete script that demonstrates reliable narration recovery and explicit operator controls.'.repeat(4)
        },
        seo: {
          title: 'Narration recovery',
          description: 'A detailed explanation of reliable narration recovery for production workflows.',
          tags: ['narration', 'recovery', 'workflow']
        },
        assets: {
          audio: { path: path.join(directory, 'missing.mp3.info'), status: 'unavailable', simulated: true, error: 'Provider quota exhausted' },
          finalVideo: { path: videoPath, simulated: false }, thumbnail: { path: visualPath }
        },
        timeline: {}, priority: 50, scheduledPublishTime: new Date(Date.now() + 86400000).toISOString()
      };
      await db.saveProductionData(production);
      await db.saveProductionSnapshot(production);
      await db.replaceProductionScenes(productionId, [{
        id: 'scene-narration-1', label: 'Opening', scriptText: 'This narration must be recovered.',
        prompt: 'Opening visual', duration: 8, assetType: 'image', assetOrigin: 'generated', assetPath: visualPath,
        status: 'ready', narrationStatus: 'unavailable', narrationError: 'Provider quota exhausted', rightsConfirmed: true
      }]);

      const blockedQuality = await new OperatorService(db).runQualityChecks({
        ...production, scenes: await db.listProductionScenes(productionId)
      }, {});
      if (blockedQuality.passed || !blockedQuality.blockingFailures.includes('narration')) {
        throw new Error('Missing narration did not block production quality');
      }

      let failProvider = true;
      const generator = {
        async generateTTSAudio(_text, outputPath) {
          if (failProvider) {
            this.lastNarrationResult = {
              status: 'failed', provider: 'openai', model: 'gpt-4o-mini-tts',
              generatedAt: new Date().toISOString(), error: 'Provider quota exhausted',
              cost: { provider: 'openai', amount: null, invoiceRequired: true }
            };
            throw new Error('Provider quota exhausted');
          }
          await fs.writeFile(outputPath, Buffer.from('recovered narration'));
          this.lastNarrationResult = {
            status: 'ready', path: outputPath, provider: 'openai', model: 'gpt-4o-mini-tts',
            externalTaskId: 'tts-task-1', generatedAt: new Date().toISOString(),
            cost: { provider: 'openai', amount: null, invoiceRequired: true }
          };
          return outputPath;
        },
        isUsableAudioFile: async filePath => Boolean(filePath && await fs.stat(filePath).then(stat => stat.size > 0).catch(() => false))
      };
      const service = new SceneRepairService(db, generator, {
        dataRoot: directory, logger: this.logger, getMediaDuration: async () => 5.25
      });

      let confirmationBlocked = false;
      try {
        await service.regenerateNarration(productionId, 'scene-narration-1');
      } catch (error) {
        confirmationBlocked = error.code === 'NARRATION_COST_CONFIRMATION_REQUIRED';
      }
      if (!confirmationBlocked) throw new Error('Narration regeneration bypassed the provider-cost confirmation');

      let outagePersisted = false;
      try {
        await service.regenerateNarration(productionId, 'scene-narration-1', { confirmCost: true });
      } catch (_error) {
        const failed = await db.getProductionScene(productionId, 'scene-narration-1');
        outagePersisted = failed.narrationStatus === 'failed' && failed.narrationProvider === 'openai' && /quota/.test(failed.narrationError);
      }
      if (!outagePersisted) throw new Error('Narration provider failure evidence was not persisted');

      failProvider = false;
      const recovered = await service.regenerateNarration(productionId, 'scene-narration-1', { confirmCost: true });
      if (
        recovered.narrationStatus !== 'current' || recovered.narrationProvider !== 'openai' ||
        recovered.narrationModel !== 'gpt-4o-mini-tts' || recovered.narrationTaskId !== 'tts-task-1' ||
        recovered.status !== 'needs_rebuild' || recovered.duration !== 5.75
      ) {
        throw new Error('Narration-only recovery did not preserve provider evidence and rebuild state');
      }

      let weakSilenceBlocked = false;
      try {
        await service.setSilenceOverride(productionId, { enabled: true, confirmed: true, reason: 'silent' });
      } catch (error) {
        weakSilenceBlocked = /at least 10/.test(error.message);
      }
      if (!weakSilenceBlocked) throw new Error('Intentional silence was accepted without a meaningful reason');

      await service.setSilenceOverride(productionId, {
        enabled: true, confirmed: true, reason: 'This visual demonstration intentionally uses captions only.'
      });
      const silenceBundle = await db.getProductionBundle(productionId);
      const silenceQuality = await new OperatorService(db).runQualityChecks(silenceBundle, {});
      const narrationCheck = silenceQuality.checks.find(check => check.id === 'narration');
      if (!narrationCheck?.passed || silenceBundle.scenes[0].narrationStatus !== 'intentional_silence') {
        throw new Error('Confirmed intentional silence did not satisfy the narration evidence gate');
      }

      const revisions = await db.listProductionSceneRevisions(productionId);
      for (const action of ['regenerate_narration', 'confirm_intentional_silence']) {
        if (!revisions.some(revision => revision.action === action)) throw new Error(`Narration history is missing ${action}`);
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Narration reliability and recovery test completed successfully');
  }

  async testShortsRepurposingStudio() {
    const fs = require('fs').promises;
    const os = require('os');
    const { runFFmpeg } = require('./utils/ffmpeg');
    const { ShortsRepurposingService } = require('./utils/shorts-repurposing-service');
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-shorts-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'shorts.db');
    await db.initialize();

    try {
      const productionId = 'prod-shorts-studio';
      const sourceVideo = path.join(directory, 'source.mp4');
      const audioPath = path.join(directory, 'narration.m4a');
      const thumbnailPath = path.join(directory, 'thumbnail.jpg');
      await runFFmpeg([
        '-y', '-f', 'lavfi', '-i', 'color=c=#203a5f:s=640x360:r=24:d=4',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceVideo
      ]);
      await fs.writeFile(audioPath, Buffer.from('narration evidence'));
      await fs.writeFile(thumbnailPath, Buffer.from('thumbnail evidence'));
      const production = {
        id: productionId, status: 'scheduled',
        strategy: { topic: 'Repurpose one production', contentType: 'tutorial' },
        script: { title: 'Repurpose one production', fullScript: 'A complete source script for producing several useful vertical excerpts from one approved production.'.repeat(4) },
        seo: {
          title: 'Repurpose one production',
          description: 'A detailed source description for a safe and efficient vertical repurposing workflow.',
          tags: ['repurposing', 'shorts', 'workflow']
        },
        assets: {
          finalVideo: { path: sourceVideo, simulated: false, duration: 4 },
          audio: { path: audioPath, status: 'ready', simulated: false, provider: 'fixture-tts' },
          thumbnail: { path: thumbnailPath }
        },
        timeline: {}, priority: 50,
        scheduledPublishTime: new Date(Date.now() + 86400000).toISOString()
      };
      await db.saveProductionData(production);
      await db.saveProductionSnapshot(production);
      await db.saveContentReview(productionId, {
        status: 'approved', editorData: { factChecked: true, rightsConfirmed: true },
        qualityChecks: [], reviewedAt: new Date().toISOString()
      });
      await db.saveContentProvenance(productionId, {
        sources: [], claims: [], containsSyntheticMedia: true, status: 'not_required',
        summary: { sourceCount: 0, verifiedSources: 0, claimCount: 0, resolvedClaims: 0, highRiskClaims: 0, unresolvedClaims: 0 }
      });
      await db.replaceProductionScenes(productionId, [
        { id: 'short-source-1', label: 'Hook', scriptText: 'One strong idea can reach more than one audience.', prompt: 'Opening', duration: 1.4, assetType: 'video', assetPath: sourceVideo, audioPath, status: 'ready', narrationStatus: 'current', rightsConfirmed: true },
        { id: 'short-source-2', label: 'Method', scriptText: 'Use the approved scene evidence to build a vertical excerpt.', prompt: 'Method', duration: 1.3, assetType: 'video', assetPath: sourceVideo, audioPath, status: 'ready', narrationStatus: 'current', rightsConfirmed: true },
        { id: 'short-source-3', label: 'Result', scriptText: 'Render locally and review every Short before it reaches the schedule.', prompt: 'Result', duration: 1.3, assetType: 'video', assetPath: sourceVideo, audioPath, status: 'ready', narrationStatus: 'current', rightsConfirmed: true }
      ]);

      const publishing = new PublishingSchedulingAgent(db, {});
      const service = new ShortsRepurposingService(db, publishing, {
        dataRoot: path.join(directory, 'shorts'), width: 360, height: 640, logger: this.logger
      });
      const proposed = await service.propose(productionId, { count: 3 });
      if (proposed.length !== 3 || proposed.some(clip => !clip.sourceSceneIds.length || clip.status !== 'proposed')) {
        throw new Error('Short drafts did not preserve source-scene identity');
      }
      const edited = await service.update(productionId, proposed[0].id, {
        title: 'One approved video, three vertical moments', layout: 'blur',
        tags: ['Shorts', 'repurposing', 'workflow']
      });
      if (edited.title.length > 100 || edited.layout !== 'blur') throw new Error('Short draft edits did not persist');
      const rendered = await service.render(productionId, edited.id);
      if (rendered.status !== 'rendered' || !rendered.outputPath || !rendered.captionsPath) {
        throw new Error('Local vertical rendering did not persist its MP4 and captions');
      }
      await runFFmpeg(['-v', 'error', '-i', rendered.outputPath, '-f', 'null', '-']);

      let approvalBlocked = false;
      try {
        await service.approve(productionId, rendered.id, {});
      } catch (error) {
        approvalBlocked = error.code === 'SHORT_APPROVAL_REQUIRED';
      }
      if (!approvalBlocked) throw new Error('Short scheduling bypassed explicit approval confirmation');
      const scheduled = await service.approve(productionId, rendered.id, {
        confirmed: true, publishTime: new Date(Date.now() + 172800000).toISOString(), privacyStatus: 'private'
      });
      const schedule = await db.getLatestScheduleEntry(rendered.id);
      if (
        scheduled.status !== 'scheduled' || !schedule || schedule.metadata.contentType !== 'short' ||
        schedule.metadata.sourceProductionId !== productionId || schedule.metadata.containsSyntheticMedia !== true
      ) {
        throw new Error('Approved Short did not inherit evidence into an independent schedule entry');
      }
      schedule.status = 'published';
      schedule.youtubeId = 'youtube-short-1';
      schedule.youtubeUrl = 'https://www.youtube.com/shorts/youtube-short-1';
      schedule.publishedAt = new Date().toISOString();
      await db.updateScheduleEntry(schedule);
      await publishing.syncShortStatus(schedule, 'published');
      const published = await db.getShortClip(rendered.id);
      const context = await db.getPublishedContentContext('youtube-short-1');
      const attributes = new ChannelLearningEngine(db).extractAttributes({ videoDetails: { title: published.title } }, context);
      if (published.status !== 'published' || context.contentFormat !== 'short' || attributes.surface !== 'shorts' || attributes.format !== 'shorts') {
        throw new Error('Published Short did not remain separate in analytics learning context');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Shorts Repurposing Studio test completed successfully');
  }

  async testChaptersAndSubscribe() {
    const fs = require('fs').promises;
    const os = require('os');
    const chapters = require('./utils/chapters');
    const { subscribeLine, hasSubscribeCall } = require('./utils/subscribe-cta');
    const { OperatorService } = require('./utils/operator-service');
    const { ScriptWriterAgent } = require('./agents/script-writer-agent');
    const { YouTubeAutomationAgent } = require('./index');
    const { GenerationRecoveryService } = require('./utils/generation-recovery-service');
    const savedLanguage = process.env.CONTENT_LANGUAGE;
    process.env.CONTENT_LANGUAGE = 'fr';
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-chapters-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'chapters.db');
    await db.initialize();

    try {
      // YouTube rules: 00:00 first, at least three, ascending, ten seconds each; the hook opens the first chapter,
      // the call to action closes the last one and a chapter under ten seconds joins its neighbour.
      const scenes = [
        { id: 's0', position: 0, label: 'Hook', duration: 16.2, scriptText: 'En 1989, des physiciens ont envoyé des électrons un par un.' },
        { id: 's1', position: 1, label: 'Une expérience qui défie le bon sens', duration: 77.7, scriptText: 'Prends une source de lumière et deux fentes.' },
        { id: 's2', position: 2, label: 'Quand on regarde, tout change', duration: 86.5, scriptText: 'Par quelle fente passe chaque particule ?' },
        { id: 's3', position: 3, label: 'Un détour', duration: 6, scriptText: 'Un mot sur Feynman.' },
        { id: 's4', position: 4, label: 'Le vrai prix de la pensée magique', duration: 84.4, scriptText: 'Si tu es malade, tu as mal pensé.' },
        { id: 's5', position: 5, label: 'Call to action', duration: 6.1, scriptText: 'Abonne-toi pour ne rien manquer.' }
      ];
      const spans = chapters.chapterSpans(scenes);
      if (
        spans.length !== 3 || spans[0].start !== 0 || spans[0].sceneIds.join() !== 's0,s1' ||
        spans[1].sceneIds.join() !== 's2,s3' || spans[2].sceneIds.join() !== 's4,s5' || spans[0].title !== 'Une expérience qui défie le bon sens'
      ) {
        throw new Error(`Chapter spans ignore the hook, the CTA or the ten-second rule: ${JSON.stringify(spans.map(span => span.sceneIds))}`);
      }
      const total = scenes.reduce((sum, scene) => sum + scene.duration, 0);
      const block = chapters.formatChapterBlock(spans, { totalDuration: total, lang: 'fr' });
      if (block !== 'CHAPITRES\n00:00 Une expérience qui défie le bon sens\n01:33 Quand on regarde, tout change\n03:06 Le vrai prix de la pensée magique') {
        throw new Error(`Chapter block is not in YouTube's format: ${JSON.stringify(block)}`);
      }
      if (chapters.formatChapterBlock(spans.slice(0, 2), { totalDuration: total })) throw new Error('Fewer than three chapters must not be listed');
      const tooShort = chapters.validateChapters([{ start: 0, title: 'A' }, { start: 8, title: 'B' }, { start: 30, title: 'C' }], 60);
      if (!tooShort.some(error => error.includes('chapter 1 lasts 8s'))) throw new Error('A chapter under ten seconds was accepted');
      if (!chapters.validateChapters([{ start: 2, title: 'A' }, { start: 20, title: 'Hook' }, { start: 40, title: 'C' }], 60).length) {
        throw new Error('A first chapter after 00:00 or an internal label was accepted');
      }
      if (chapters.formatTimestamp(3725, true) !== '1:02:05' || chapters.formatTimestamp(93) !== '01:33') throw new Error('Timestamps are badly formatted');
      const flattened = chapters.stripTimestamps('Texte. CHAPITRES 00:00 Un 01:20 Deux 10:27 Trois SOURCES (vérifiées) • x');
      if (flattened !== 'Texte. SOURCES (vérifiées) • x') throw new Error(`One-line chapters were not removed: ${flattened}`);
      const replaced = chapters.replaceChapterBlock('Résumé.\n\n⏱️ TIMESTAMPS:\n00:00 Introduction\n00:20 Faux\n\nSOURCES (vérifiées)\n• a', block);
      if (replaced !== `Résumé.\n\n${block}\n\nSOURCES (vérifiées)\n• a` || chapters.parseChapters(replaced).length !== 3) {
        throw new Error(`Estimated timestamps were not replaced by the real chapters: ${JSON.stringify(replaced)}`);
      }

      // Titles say what each chapter explains; a wrong answer from the model keeps the scene titles.
      const titler = answer => ({ isAvailable: () => true, generateText: async () => answer });
      const titled = await chapters.titleChapters(spans, titler(JSON.stringify({ titles: ["L'expérience des fentes de Young", "L'effet de la mesure", 'La culpabilisation des malades'] })));
      if (titled[1] !== "L'effet de la mesure") throw new Error('Chapter titles from the narration were not used');
      const fallback = await chapters.titleChapters(spans, titler('{"titles":["un seul"]}'));
      if (fallback.join('|') !== spans.map(span => span.title).join('|')) throw new Error('A malformed title answer did not fall back to the scene titles');

      // The subscribe call is mandatory: in the closing narration and in the description.
      const writer = new ScriptWriterAgent(null, {});
      const strategy = { callToAction: 'Abonne-toi pour ne rien manquer. Sources en description.' };
      if (writer.normalizeAICTA('Toutes les sources sont en description.', strategy).subscribe !== strategy.callToAction) {
        throw new Error('A closing line without a subscribe call was kept');
      }
      if (writer.normalizeAICTA('Abonne-toi, et dis-moi en commentaire.', strategy).subscribe !== 'Abonne-toi, et dis-moi en commentaire.') {
        throw new Error("The model's own subscribe line was replaced");
      }
      if (!hasSubscribeCall(writer.normalizeAICTA('', { callToAction: 'Merci.' }).subscribe)) throw new Error('No default subscribe line');
      const line = subscribeLine(strategy.callToAction, 'UC123', 'fr');
      if (line !== '🔔 Abonne-toi pour ne rien manquer : https://www.youtube.com/channel/UC123?sub_confirmation=1') {
        throw new Error(`Subscribe line is malformed: ${line}`);
      }
      const operator = new OperatorService(db);
      const gate = await operator.runQualityChecks({
        script: { title: 'Titre', fullScript: 'x'.repeat(250), callToAction: { subscribe: 'Merci de ton attention.' } },
        seo: { title: 'Titre', description: 'Une description détaillée de la vidéo pour les spectateurs curieux.', tags: ['a', 'b', 'c'] },
        assets: { finalVideo: { path: path.join(directory, 'missing.mp4'), simulated: false, duration: 300 } }
      }, {});
      for (const id of ['chapters_valid', 'subscribe_cta_spoken', 'subscribe_cta_description']) {
        if (!gate.blockingFailures.includes(id)) throw new Error(`The quality gate did not block on ${id}`);
      }

      // The autonomous path uploads the composed description: summary, subscribe line, real chapters.
      const productionId = 'prod-chapters-auto';
      const videoPath = path.join(directory, 'video.mp4');
      const thumbnailPath = path.join(directory, 'thumbnail.jpg');
      await fs.writeFile(videoPath, Buffer.from('video'));
      await fs.writeFile(thumbnailPath, Buffer.from('thumbnail'));
      await db.saveChannelProfile({ callToAction: strategy.callToAction });
      await db.setSetting('approval_required', 'false');
      await db.setSetting('youtube_channel_id', 'UC123');
      const scheduled = [];
      const agent = new YouTubeAutomationAgent();
      agent.db = db;
      agent.recovery = new GenerationRecoveryService(db, { logger: agent.logger, baseDelayMs: 0, updateJobStage: (...args) => agent.updateJobStage(...args) });
      agent.readiness = { assertReady: async () => true };
      agent.operator = { runQualityChecks: async () => ({ passed: true, score: 100, checks: [], blockingFailures: [] }), notify: async () => null };
      agent.chapterText = titler(JSON.stringify({ titles: ["L'expérience des fentes de Young", "L'effet de la mesure", 'La culpabilisation des malades'] }));
      agent.agents = {
        strategy: { generateContentStrategy: async () => ({ topic: 'Chapitres réels', contentType: 'Explainer' }) },
        scriptWriter: { generateScript: async () => ({ title: 'Chapitres réels', fullScript: 'Un script complet.' }) },
        thumbnailDesigner: { generateThumbnail: async () => ({ path: thumbnailPath, concept: {} }) },
        seoOptimizer: { optimize: async () => ({ title: 'Chapitres réels', description: 'Un résumé sincère.\n\n00:00 Introduction\n00:20 Estimé', tags: ['a', 'b', 'c'] }) },
        production: {
          processContent: async input => {
            await db.replaceProductionScenes(productionId, scenes.map(scene => ({ ...scene, prompt: scene.label, status: 'ready', narrationStatus: 'current' })));
            return {
              id: productionId, status: 'ready', ...input,
              assets: { finalVideo: { path: videoPath, simulated: false }, thumbnail: { path: thumbnailPath } },
              timeline: {}, scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(), priority: 50, estimatedDuration: '5:00'
            };
          }
        },
        publishing: { scheduleContent: async production => { scheduled.push(production); return { id: 'schedule-1' }; } }
      };
      const job = await db.createGenerationJob({ topic: 'Chapitres réels', source: 'manual' });
      await db.updateGenerationJob(job.id, { status: 'failed', stage: 'strategy' });
      await agent.resumeGenerationJob(job.id);
      await agent.waitForGenerationJob(job.id);
      const uploaded = scheduled[0]?.seo?.description || '';
      const expected = 'Un résumé sincère.\n\n🔔 Abonne-toi pour ne rien manquer : https://www.youtube.com/channel/UC123?sub_confirmation=1\n\n' +
        "CHAPITRES\n00:00 L'expérience des fentes de Young\n01:33 L'effet de la mesure\n03:06 La culpabilisation des malades";
      if (uploaded !== expected) throw new Error(`The autonomous path did not schedule the composed description: ${JSON.stringify(uploaded)}`);
      const review = await db.getProductionBundle(productionId);
      if (review.editorData.description !== expected || review.seo.chapters?.length !== 3) {
        throw new Error('The composed description or the chapters were not kept for review');
      }
    } finally {
      if (savedLanguage === undefined) delete process.env.CONTENT_LANGUAGE; else process.env.CONTENT_LANGUAGE = savedLanguage;
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Chapters and mandatory subscribe call test completed successfully');
  }

  async testMontageShorts() {
    const fs = require('fs').promises;
    const os = require('os');
    const { runFFmpeg } = require('./utils/ffmpeg');
    const timing = require('./utils/narration-timing');
    const { ShortsRepurposingService } = require('./utils/shorts-repurposing-service');
    const saved = { language: process.env.CONTENT_LANGUAGE, music: process.env.BACKGROUND_MUSIC };
    process.env.BACKGROUND_MUSIC = 'off';
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-montage-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'montage.db');
    await db.initialize();

    try {
      // Three narrated scenes with word timings: two of argument, then the call to action. The call to action has no
      // illustration of its own (it reuses the previous one, as in the long video).
      const sceneDir = path.join(directory, 'scenes');
      await fs.mkdir(sceneDir, { recursive: true });
      const texts = [
        ['On répète partout que le poisson rouge oublie tout en trois secondes.', 'Cette idée vient pourtant d\'une plaisanterie jamais vérifiée en laboratoire.', 'Elle promet une réponse simple à une question pourtant très complexe.'],
        ['Le problème, c\'est que les poissons apprennent des parcours entiers.', 'Des chercheurs les entraînent à retrouver une sortie pendant des mois.', 'Leur mémoire dure donc bien plus que trois secondes au bout du compte.'],
        ['Abonne-toi pour ne rien manquer.']
      ];
      const scenes = [];
      for (const [position, sentences] of texts.entries()) {
        const words = [];
        let cursor = 0.1;
        for (const sentence of sentences) {
          const tokens = sentence.split(' ');
          const step = (position === 2 ? 2.4 : 5.4) / tokens.length;
          for (const token of tokens) {
            words.push({ text: token, start: Number(cursor.toFixed(3)), end: Number((cursor + step * 0.9).toFixed(3)) });
            cursor += step;
          }
          cursor += 0.3;
        }
        const duration = Number((cursor + 0.1).toFixed(2));
        const audioPath = path.join(sceneDir, `00${position}_r1.mp3`);
        await runFFmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=${300 + position * 100}:duration=${duration}`, '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', audioPath]);
        await timing.writeWordTimings(audioPath, { provider: 'fixture', text: sentences.join(' '), words });
        if (position < 2) {
          await runFFmpeg(['-y', '-f', 'lavfi', '-i', `color=c=${position ? '#552222' : '#223355'}:s=640x360`, '-frames:v', '1', path.join(sceneDir, `00${position}_illustration.png`)]);
        }
        scenes.push({
          id: `montage-scene-${position}`, position, label: ['La mémoire du poisson rouge', 'Ce que montrent les études', 'Call to action'][position],
          scriptText: sentences.join(' '), prompt: 'scene', duration, assetType: 'video', assetPath: path.join(sceneDir, `00${position}_r1.mp4`),
          audioPath, status: 'ready', narrationStatus: 'current', rightsConfirmed: true
        });
      }
      const productionId = 'prod-montage';
      const sourceVideo = path.join(directory, 'source.mp4');
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=24:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceVideo]);
      const production = {
        id: productionId, status: 'scheduled',
        strategy: { topic: 'La mémoire du poisson rouge' },
        script: { title: 'Le poisson rouge oublie-t-il tout ?' },
        seo: { title: 'Le poisson rouge oublie-t-il tout ?', description: 'Description.', tags: ['poisson', 'mémoire'] },
        assets: {
          finalVideo: { path: sourceVideo, simulated: false },
          audio: { path: scenes[0].audioPath, status: 'ready', simulated: false, provider: 'fixture-tts' }
        },
        timeline: {}, priority: 50, scheduledPublishTime: new Date(Date.now() + 86400000).toISOString()
      };
      await db.saveProductionData(production);
      await db.saveProductionSnapshot(production);
      await db.saveContentReview(productionId, { status: 'approved', editorData: {}, qualityChecks: [], reviewedAt: new Date().toISOString() });
      await db.saveContentProvenance(productionId, {
        sources: [], claims: [], containsSyntheticMedia: true, status: 'not_required',
        summary: { sourceCount: 0, verifiedSources: 0, claimCount: 0, resolvedClaims: 0, highRiskClaims: 0, unresolvedClaims: 0 }
      });
      await db.replaceProductionScenes(productionId, scenes);
      await db.saveChannelProfile({ channelName: 'Ma chaîne', callToAction: 'Abonne-toi pour ne rien manquer.' });

      // Opening sentences that lean on what came before are refused; "Ce que…" and "Il y a…" are not back-references.
      const transcriptFor = list => list.map((text, index) => ({ index, sceneId: 'a', register: 'main', text, start: index * 8, end: index * 8 + 6, timed: true, cta: false }));
      const opener = new ShortsRepurposingService(null, null, { logger: this.logger });
      const opens = text => Boolean(opener.buildSelection(
        { cuts: [[0, 2]], title: 't', scores: {} },
        transcriptFor([text, 'Deuxième phrase assez longue pour durer.', 'Troisième phrase qui conclut le propos.'])
      ));
      if (!opens('Ce que tu crois ne change rien.') || !opens('Il y a deux mille ans, déjà.') || opens('Ce mécanisme a un nom.') || opens('Là, tout change.') || opens('Mais personne ne choisit.')) {
        throw new Error('The opening sentence rule misjudged a back-reference');
      }
      if (opener.buildSelection({ cuts: [[2, 2], [0, 1]], title: 't' }, transcriptFor(['A.', 'B.', 'C.']))) throw new Error('Reordered cuts were accepted');
      // A cold open plays one sentence of the same argument first, without repeating it.
      const opened = opener.buildSelection({ cuts: [[0, 0], [2, 3]], hook: 3, title: 't' }, transcriptFor(['Le poisson oublie.', 'Hors sujet.', 'Les poissons apprennent.', 'Personne ne l\'a mesuré.']));
      if (!opened || opened.coldOpen !== 3 || opened.sentences.join() !== '3,0,2' || opener.buildSelection({ cuts: [[0, 1]], hook: 3, title: 't' }, transcriptFor(['A b c.', 'D e f.', 'G h i.', 'J k l.']))) {
        throw new Error('The cold open was not placed first, or came from outside the argument');
      }

      // Model answers cut right before their last brace, or followed by commentary, still parse as the object.
      const { extractJson } = require('./utils/ai-json');
      const truncated = extractJson('{"scores":{"hook":7},"drop":[1],"verdict":"publish","reason":"ok"');
      const commented = extractJson('{"scores":{"hook":8},"drop":[]}\n\nNote : la phrase {2} est longue.');
      if (truncated.scores?.hook !== 7 || commented.scores?.hook !== 8) throw new Error('A truncated or commented JSON answer lost its object');

      // Editor, critic, second round with the critic's reasons, then a tightened montage judged again.
      const prompts = [];
      let editorCalls = 0;
      let criticCalls = 0;
      const ai = {
        model: 'default', isAvailable: () => true,
        generateText: async prompt => {
          prompts.push(prompt);
          const scores = { hook: 9, standalone: 9, density: 9, payoff: 9 };
          if (prompt.includes('Edit at most')) {
            editorCalls++;
            if (editorCalls === 1) {
              return JSON.stringify({ shorts: [
                { cuts: [[0, 0], [3, 4]], title: 'Le poisson rouge oublie-t-il tout ?', description: 'Une idée reçue.', scores, why: 'Une idée.' },
                { cuts: [[2, 4]], title: 'Ouverture sur un pronom', description: 'x', scores, why: 'x' }
              ] });
            }
            return JSON.stringify({ shorts: [{ cuts: [[0, 0], [2, 5]], title: 'Le poisson rouge oublie-t-il tout ?', description: 'Une idée reçue. Tu y croyais ?', scores, why: 'Une idée.' }] });
          }
          criticCalls++;
          const verdict = { scores: { hook: 9, clarity: 9, density: 9, fidelity: 9, payoff: 9 }, swipeAt: null, drop: [], verdict: 'publish', reason: 'Tient debout.' };
          if (criticCalls === 1) return JSON.stringify({ ...verdict, scores: { ...verdict.scores, hook: 5 }, swipeAt: 1, verdict: 'reject', reason: 'accroche trop lente' });
          if (criticCalls === 2) return JSON.stringify({ ...verdict, drop: [2] });
          return JSON.stringify(verdict);
        }
      };
      const service = new ShortsRepurposingService(db, { scheduleContent: async () => ({ id: 'schedule-montage' }) }, {
        dataRoot: path.join(directory, 'shorts'), width: 360, height: 640, logger: this.logger, aiTextService: ai, minScore: 7
      });
      const [clip] = await service.propose(productionId, { count: 1, requireAI: true });
      if (!prompts.some(prompt => prompt.includes('Edit at most') && prompt.includes('accroche trop lente'))) {
        throw new Error("The second editing round did not read the critic's reasons");
      }
      if (
        !clip || clip.layout !== 'native' || clip.segments.length !== 2 || clip.critic.revised !== true ||
        clip.segments.map(segment => `${segment.first}-${segment.last}`).join() !== '0-0,3-5' ||
        clip.cta?.kind !== 'narration' || clip.cta.text !== 'Abonne-toi pour ne rien manquer.' ||
        !clip.description.includes('\n\n🔔 Abonne-toi pour ne rien manquer.\n\n#Shorts')
      ) {
        throw new Error(`The montage was not edited, judged, tightened and closed on the subscribe line: ${JSON.stringify(clip)}`);
      }
      if (await service.illustrationFor(scenes[2], scenes) !== path.join(sceneDir, '001_illustration.png')) {
        throw new Error("The call to action did not reuse the previous scene's illustration");
      }

      // Render: the captions are exactly the words heard, on the montage's own timeline.
      const rendered = await service.render(productionId, clip.id);
      const srt = await fs.readFile(rendered.captionsPath, 'utf8');
      const captioned = srt.split('\n\n').map(block => block.split('\n').slice(2).join(' ')).join(' ').replace(/\s+/g, ' ').trim();
      const heard = [texts[0][0], texts[1][0], texts[1][1], texts[1][2], texts[2][0]].join(' ');
      if (captioned !== heard) throw new Error(`Montage captions differ from the narration: ${captioned}`);
      const timeline = service.montageTimeline(clip.segments, clip.cta);
      if (rendered.status !== 'rendered' || Math.abs(rendered.duration - timeline.total) > 0.01 || timeline.segments[1].at <= timeline.segments[0].end - timeline.segments[0].start) {
        throw new Error('The montage was not rendered on its planned timeline');
      }
      let caught = null;
      try {
        await service.verifyRender(rendered.outputPath, { total: timeline.total + 3, cues: [], words: [{ text: 'autre' }], expectedText: 'texte' });
      } catch (error) {
        caught = error.message;
      }
      if (!caught || !caught.includes('lasts') || !caught.includes('not exactly the words heard')) throw new Error('Render checks did not catch a wrong length or wrong captions');

      // A second editing pass never reuses the sentences of a published Short.
      await db.updateShortClip(clip.id, { status: 'published' });
      const transcript = await service.buildTranscript(await db.getProductionBundle(productionId), scenes);
      const used = service.usedSentences([await db.getShortClip(clip.id)], transcript);
      if ([0, 3, 4, 5].some(index => !used.has(index)) || used.has(1)) throw new Error(`Used sentences were misread: ${[...used]}`);
      editorCalls = 0;
      criticCalls = 10;
      const more = await service.propose(productionId, { count: 1, requireAI: true, append: true });
      if (more.length !== 0 || (await db.listShortClips(productionId)).length !== 1) throw new Error('A new Short reused the sentences of a published one');

      // Long-video captions follow the voice word by word on the measured scene timeline.
      const longSrt = await timing.srtFromScenes(scenes);
      if (!longSrt.startsWith('1\n00:00:00,100 --> ') || !longSrt.includes(`${(scenes[0].duration + 0.1).toFixed(3).replace('.', ',').padStart(6, '0')}`)) {
        throw new Error(`Long-video captions are not on the measured timeline: ${longSrt.slice(0, 200)}`);
      }
    } finally {
      for (const [key, name] of [['language', 'CONTENT_LANGUAGE'], ['music', 'BACKGROUND_MUSIC']]) {
        if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
      }
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Montage Shorts test completed successfully');
  }

  async testStudioVoiceAndShortsEditor() {
    const fs = require('fs').promises;
    const os = require('os');
    const http = require('http');
    const { runFFmpeg } = require('./utils/ffmpeg');
    const timing = require('./utils/narration-timing');
    const { displayLabel, glueTypography } = require('./utils/visualizer');
    const { wordBudget } = require('./agents/script-writer-agent');
    const { ShortsRepurposingService } = require('./utils/shorts-repurposing-service');
    const elevenLabs = require('./utils/elevenlabs-tts');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-voice-'));
    const saved = { base: process.env.ELEVENLABS_BASE_URL, model: process.env.ELEVENLABS_MODEL, language: process.env.ELEVENLABS_LANGUAGE_CODE };
    let server = null;

    try {
      // Captions break on punctuation and follow word timings.
      const words = [
        { text: 'Sauf', start: 0, end: 0.3 }, { text: 'que', start: 0.3, end: 0.5 }, { text: 'personne', start: 0.5, end: 0.9 },
        { text: 'ne', start: 0.9, end: 1.0 }, { text: 'le', start: 1.0, end: 1.4 }, { text: 'mesure', start: 1.4, end: 1.5 },
        { text: 'vraiment.', start: 1.5, end: 2.0 }, { text: 'Essaie.', start: 2.4, end: 2.9 }
      ];
      const cues = timing.captionCues('', 3, { words, maxWords: 8 });
      if (cues.length !== 2 || cues[0].text !== 'Sauf que personne ne le mesure vraiment.' || Math.abs(cues[1].start - 2.4) > 0.001) {
        throw new Error(`Captions did not follow punctuation and word timings: ${JSON.stringify(cues)}`);
      }
      const sentences = timing.timedSentences('Sauf que personne ne le mesure vraiment. Essaie.', 3, words);
      if (sentences.length !== 2 || sentences[1].start !== 2.4 || sentences[0].end !== 2.0) throw new Error('Sentence timings were not taken from the words');
      if (displayLabel('Hook') || displayLabel('Call to action') || displayLabel('Le problème des dieux multiples') !== 'Le problème des dieux multiples') {
        throw new Error('Internal scene labels must never be burned on screen');
      }
      if (!glueTypography('EXISTAIT ? CE').includes('\u00a0?')) throw new Error('French punctuation was not glued to its word');
      const budget = wordBudget('8-12 minutes');
      if (budget.from < 8 * budget.wpm || budget.to > 12 * budget.wpm) throw new Error('Word budget falls outside the requested length');

      // ElevenLabs: with-timestamps request, prosody context, chunking and word sidecar, against a local fake API.
      const tone = path.join(directory, 'tone.mp3');
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', tone]);
      const audio = (await fs.readFile(tone)).toString('base64');
      const requests = [];
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const payload = JSON.parse(body || '{}');
          requests.push({ url: req.url, key: req.headers['xi-api-key'], payload });
          if (payload.language_code) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ detail: { status: 'invalid', message: 'language_code is not supported for this model' } }));
          }
          const characters = [...payload.text];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            audio_base64: audio,
            alignment: {
              characters,
              character_start_times_seconds: characters.map((_, index) => index * 0.02),
              character_end_times_seconds: characters.map((_, index) => index * 0.02 + 0.02)
            }
          }));
        });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      process.env.ELEVENLABS_BASE_URL = `http://127.0.0.1:${server.address().port}`;
      process.env.ELEVENLABS_MODEL = 'eleven_v3';
      process.env.ELEVENLABS_LANGUAGE_CODE = 'fr';
      const longText = Array.from({ length: 60 }, (_, index) => `Phrase numéro ${index + 1} du récit, assez longue pour peser dans le découpage des requêtes.`).join(' ');
      const output = path.join(directory, 'scene.mp3');
      const result = await elevenLabs.synthesize(longText, output, { previousText: 'Scène précédente.', nextText: 'Scène suivante.', apiKey: 'test-key', voiceId: 'voice-1' });
      const accepted = requests.filter(request => !request.payload.language_code);
      if (!accepted.length || accepted.length < 2) throw new Error('Long narration was not split into several requests');
      if (!requests.every(request => request.url.startsWith('/v1/text-to-speech/voice-1/with-timestamps') && request.key === 'test-key')) {
        throw new Error('ElevenLabs was not called on the with-timestamps endpoint with the account key');
      }
      if (accepted[0].payload.previous_text !== 'Scène précédente.' || accepted[accepted.length - 1].payload.next_text !== 'Scène suivante.') {
        throw new Error('Neighbouring scene text was not sent for prosody continuity');
      }
      if (requests.filter(request => request.payload.language_code).length !== 1) throw new Error('A rejected optional field was sent again');
      const stored = await timing.readWordTimings(output);
      if (!stored || stored.length !== longText.split(' ').length || !(stored[stored.length - 1].start > 1)) {
        throw new Error('Word timings were not written with chunk offsets');
      }
      if (!(result.cost.amount > 0) || result.characters < longText.length - 60) throw new Error('Narration cost was not reported');

      // Azure: WordBoundary offsets are reported against the SSML, where the text is XML-escaped; they must
      // land on the original space-separated words, and untimed punctuation inherits the previous end.
      const azure = require('./utils/azure-tts');
      const spoken = "Tom & Jerry : l'argument tient-il ? Non.";
      const built = azure.buildSsml(spoken, { language: 'fr-FR', voice: 'fr-FR-HenriNeural', rate: '-5%' });
      if (!built.ssml.includes('Tom &amp; Jerry') || !built.ssml.includes('<prosody rate="-5%">')) throw new Error('SSML was not escaped or lacks the prosody rate');
      const at = (fragment, seconds, length) => ({ textOffset: built.ssml.indexOf(fragment, built.prefix), start: seconds, end: seconds + length });
      const azureWords = azure.wordsFromBoundaries(spoken, [
        at('Tom', 0, 0.3), at('Jerry', 0.5, 0.4), at('l&apos;', 1.0, 0.1), at('argument', 1.1, 0.5),
        at('tient-il', 1.7, 0.4), at('Non', 2.6, 0.3)
      ], built, 10);
      const expected = [['Tom', 10, 10.3], ['&', 10.3, 10.3], ['Jerry', 10.5, 10.9], [':', 10.9, 10.9], ["l'argument", 11, 11.6], ['tient-il', 11.7, 12.1], ['?', 12.1, 12.1], ['Non.', 12.6, 12.9]];
      const mismatch = expected.find(([text, start, end], index) => !azureWords[index] || azureWords[index].text !== text ||
        Math.abs(azureWords[index].start - start) > 1e-6 || Math.abs(azureWords[index].end - end) > 1e-6);
      if (azureWords.length !== expected.length || mismatch) throw new Error(`Azure word timings are misaligned: ${JSON.stringify(azureWords)}`);

      // Shorts editor guard-rails: only self-contained, critical montages of the right length survive.
      const transcript = [
        { index: 0, sceneId: 'a', register: 'opening', text: 'On dit que le poisson oublie.', start: 0, end: 6, timed: true },
        { index: 1, sceneId: 'a', register: 'opening', text: 'Cela paraît évident.', start: 6.2, end: 12, timed: true },
        { index: 2, sceneId: 'b', register: 'main', text: 'Deuxième problème.', start: 12.2, end: 16, timed: true },
        { index: 3, sceneId: 'b', register: 'main', text: 'Les poissons apprennent des parcours.', start: 16.2, end: 22, timed: true },
        { index: 4, sceneId: 'b', register: 'main', text: 'Leur mémoire dure donc des mois.', start: 22.2, end: 34, timed: true },
        { index: 5, sceneId: 'c', register: 'main', text: 'Abonne-toi.', start: 34.2, end: 36, timed: true, cta: true }
      ];
      const editor = new ShortsRepurposingService(null, null, { logger: this.logger, minScore: 7 });
      const scores = { hook: 8, standalone: 9, density: 8, payoff: 8 };
      const good = { cuts: [[0, 0], [3, 4]], title: 'Le poisson rouge oublie-t-il tout ?', description: 'Essaie.', scores };
      const kept = editor.validateSelections([
        { cuts: [[0, 1]], title: 'Opening only', scores },
        { cuts: [[2, 4]], title: 'Starts on a back-reference', scores },
        { cuts: [[1, 1], [3, 4]], title: 'Opens on a pronoun', scores },
        { cuts: [[3, 3]], title: 'Too short', scores },
        { cuts: [[3, 5]], title: 'Takes the call to action', scores },
        { ...good, scores: { ...scores, density: 6 } },
        good,
        { ...good, title: 'Shares a sentence' }
      ], transcript, 3);
      if (kept.length !== 1 || kept[0].title !== good.title || kept[0].sceneIds.join() !== 'a,b' || kept[0].segments.length !== 2 || kept[0].speech > 25) {
        throw new Error(`Shorts editor kept the wrong montages: ${JSON.stringify(kept.map(item => item.title))}`);
      }
      if (editor.validateSelections([good], transcript, 1, { allowCuts: false }).length) throw new Error('A montage was accepted where only one passage can be rendered');
    } finally {
      if (server) await new Promise(resolve => server.close(resolve));
      if (saved.base === undefined) delete process.env.ELEVENLABS_BASE_URL; else process.env.ELEVENLABS_BASE_URL = saved.base;
      if (saved.model === undefined) delete process.env.ELEVENLABS_MODEL; else process.env.ELEVENLABS_MODEL = saved.model;
      if (saved.language === undefined) delete process.env.ELEVENLABS_LANGUAGE_CODE; else process.env.ELEVENLABS_LANGUAGE_CODE = saved.language;
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Studio voice, captions and Shorts editor test completed successfully');
  }

  async testSocialPublishing() {
    const fs = require('fs').promises;
    const os = require('os');
    const { TikTokPublisher, chunkPlan } = require('./utils/social-publishers/tiktok');
    const { InstagramPublisher } = require('./utils/social-publishers/instagram');
    const { buildSocialCaption } = require('./utils/social-publishers/caption');
    const { SocialPublishingService } = require('./utils/social-publishing-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-social-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'social.db');
    await db.initialize();
    const savedPlatforms = process.env.SOCIAL_PLATFORMS;
    const quiet = { info() {}, warn() {}, error() {}, success() {} };
    const noWait = { sleep: async () => {}, pollIntervalMs: 0, logger: quiet };
    // Records every request and answers through `handler`; upload streams are closed instead of being read.
    const stubHttp = handler => {
      const calls = [];
      return {
        calls,
        request: async config => {
          calls.push(config);
          if (typeof config.data?.destroy === 'function') config.data.destroy();
          return handler(config, calls);
        }
      };
    };
    const ok = data => ({ data: { data, error: { code: 'ok' } } });

    try {
      const videoPath = path.join(directory, 'short.mp4');
      await fs.writeFile(videoPath, Buffer.alloc(4096, 1));

      const caption = buildSocialCaption({
        title: 'Einstein, la Lune et le mot « observer »',
        description: 'Ce que « observer » veut vraiment dire en physique.\n\n#Shorts\n\nVidéo complète : https://www.youtube.com/watch?v=abc\n🔔 Abonne-toi : https://www.youtube.com/channel/UC1?sub_confirmation=1',
        tags: ['astronomie', 'Shorts', "éclipse solaire", 'ciel', 'science', 'Einstein', 'extra'],
        profile: { call_to_action: 'Abonne-toi pour ne rien manquer. Sources et références en description.' },
        language: 'fr'
      });
      const hashtagLine = caption.split('\n').pop();
      if (
        !caption.includes('Abonne-toi pour ne rien manquer.') || /youtube\.com|#shorts/i.test(caption) ||
        !caption.includes('Vidéo complète sur YouTube (lien en bio)') || hashtagLine.split(' ').length !== 5 ||
        !hashtagLine.startsWith('#astronomie #éclipsesolaire') || caption.length > 2200
      ) {
        throw new Error(`Social caption is malformed:\n${caption}`);
      }
      const long = buildSocialCaption({ title: 'Titre', description: 'mot '.repeat(1500), tags: ['science'], language: 'fr' });
      if (long.length > 2200 || !long.includes('Abonne-toi pour la suite.') || !long.endsWith('#science')) {
        throw new Error('A long description must give way to the subscribe line and the hashtags');
      }
      const big = chunkPlan(70 * 1024 * 1024);
      if (big.chunkSize !== 10 * 1024 * 1024 || big.count !== 7 || chunkPlan(4096).count !== 1) {
        throw new Error('TikTok chunk plan does not follow the media transfer rules');
      }

      // TikTok draft: inbox init, one-chunk upload, then the inbox notification.
      const draftHttp = stubHttp(config => {
        if (config.url.endsWith('/v2/post/publish/inbox/video/init/')) return ok({ publish_id: 'p-draft', upload_url: 'https://upload.tiktok.test/draft' });
        if (config.method === 'PUT') return { status: 201, data: {} };
        if (config.url.endsWith('/v2/post/publish/status/fetch/')) return ok({ status: 'SEND_TO_USER_INBOX' });
        throw new Error(`Unexpected TikTok call ${config.url}`);
      });
      const draft = new TikTokPublisher({
        credentials: { client_key: 'ck', client_secret: 'cs' },
        tokens: { access_token: 'tt-access', refresh_token: 'tt-refresh', expires_at: Date.now() + 3600000 },
        http: draftHttp, mode: 'draft', ...noWait
      });
      const draftResult = await draft.publish({ videoPath, caption });
      const draftInit = draftHttp.calls[0];
      const draftPut = draftHttp.calls.find(call => call.method === 'PUT');
      if (
        draftResult.status !== 'draft_sent' || draftResult.externalId !== 'p-draft' ||
        draftInit.data.source_info.video_size !== 4096 || draftInit.data.source_info.total_chunk_count !== 1 ||
        draftInit.headers.Authorization !== 'Bearer tt-access' || draftPut.headers['Content-Range'] !== 'bytes 0-4095/4096' ||
        draftPut.headers['Content-Type'] !== 'video/mp4'
      ) {
        throw new Error('TikTok draft upload did not follow the inbox flow');
      }

      // TikTok direct with an expired token: refresh first, fall back to SELF_ONLY, flag AI content.
      const savedTokens = [];
      const directHttp = stubHttp(config => {
        if (config.url.endsWith('/v2/oauth/token/')) {
          if (!config.data.includes('grant_type=refresh_token') || !config.data.includes('refresh_token=tt-refresh')) throw new Error('Bad refresh request');
          return { data: { access_token: 'tt-new', refresh_token: 'tt-refresh-2', expires_in: 86400, open_id: 'open-1' } };
        }
        if (config.method !== 'PUT' && config.headers.Authorization !== 'Bearer tt-new') throw new Error('Stale TikTok token used');
        if (config.url.endsWith('/creator_info/query/')) return ok({ privacy_level_options: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'] });
        if (config.url.endsWith('/v2/post/publish/video/init/')) return ok({ publish_id: 'p-direct', upload_url: 'https://upload.tiktok.test/direct' });
        if (config.method === 'PUT') return { status: 201, data: {} };
        if (config.url.endsWith('/status/fetch/')) return ok({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7311] });
        throw new Error(`Unexpected TikTok call ${config.url}`);
      });
      const direct = new TikTokPublisher({
        credentials: { client_key: 'ck', client_secret: 'cs', username: 'ma.chaine' },
        tokens: { access_token: 'tt-old', refresh_token: 'tt-refresh', expires_at: Date.now() - 1000 },
        http: directHttp, mode: 'direct', privacyLevel: 'PUBLIC_TO_EVERYONE',
        saveTokens: async tokens => savedTokens.push(tokens), ...noWait
      });
      const directResult = await direct.publish({ videoPath, caption, containsSyntheticMedia: true });
      const directInit = directHttp.calls.find(call => call.url.endsWith('/v2/post/publish/video/init/'));
      if (
        directResult.status !== 'published' || directResult.url !== 'https://www.tiktok.com/@ma.chaine/video/7311' ||
        directInit.data.post_info.privacy_level !== 'SELF_ONLY' || directInit.data.post_info.is_aigc !== true ||
        directInit.data.post_info.title !== caption || savedTokens[0]?.access_token !== 'tt-new' ||
        savedTokens[0]?.refresh_token !== 'tt-refresh-2'
      ) {
        throw new Error('TikTok direct post did not refresh, fall back to an offered privacy level, or flag AI content');
      }

      // Instagram: token refreshed in its last 10 days, resumable container, upload, wait, publish, permalink.
      let statusChecks = 0;
      const igSaved = [];
      const igHttp = stubHttp(config => {
        if (config.url === 'https://graph.instagram.com/refresh_access_token') {
          if (config.params.grant_type !== 'ig_refresh_token' || config.params.access_token !== 'ig-old') throw new Error('Bad Instagram refresh');
          return { data: { access_token: 'ig-new', token_type: 'bearer', expires_in: 5184000 } };
        }
        if (config.url.startsWith('https://rupload.facebook.com/')) {
          if (config.headers.Authorization !== 'OAuth ig-new' || config.headers.offset !== '0' || config.headers.file_size !== '4096') throw new Error('Bad rupload headers');
          return { data: { success: true } };
        }
        if (config.params?.access_token !== 'ig-new') throw new Error('Stale Instagram token used');
        if (config.url.endsWith('/ig-user/media')) {
          const params = config.params;
          if (params.media_type !== 'REELS' || params.upload_type !== 'resumable' || params.is_ai_generated !== true || params.caption !== caption) throw new Error('Bad Instagram container');
          return { data: { id: 'container-1', uri: 'https://rupload.facebook.com/ig-api-upload/v25.0/container-1' } };
        }
        if (config.url.endsWith('/container-1')) return { data: { status_code: ++statusChecks > 1 ? 'FINISHED' : 'IN_PROGRESS' } };
        if (config.url.endsWith('/ig-user/media_publish')) {
          if (config.params.creation_id !== 'container-1') throw new Error('Wrong container published');
          return { data: { id: 'media-9' } };
        }
        if (config.url.endsWith('/media-9')) return { data: { permalink: 'https://www.instagram.com/reel/xyz/' } };
        throw new Error(`Unexpected Instagram call ${config.url}`);
      });
      const instagram = new InstagramPublisher({
        tokens: { access_token: 'ig-old', user_id: 'ig-user', expires_at: Date.now() + 3 * 86400000 },
        http: igHttp, saveTokens: async tokens => igSaved.push(tokens), ...noWait
      });
      const igResult = await instagram.publish({ videoPath, caption, containsSyntheticMedia: true });
      if (
        igResult.status !== 'published' || igResult.externalId !== 'media-9' || igResult.url !== 'https://www.instagram.com/reel/xyz/' ||
        statusChecks !== 2 || igSaved[0]?.access_token !== 'ig-new' || igSaved[0].expires_at < Date.now() + 50 * 86400000
      ) {
        throw new Error('Instagram Reel did not refresh its token, upload, wait for processing, and publish');
      }

      // A platform's token refresh rewrites its own entry and keeps the other logins on disk.
      const credentialManager = new CredentialManager();
      credentialManager.tokensPath = path.join(directory, 'tokens.json');
      await fs.writeFile(credentialManager.tokensPath, JSON.stringify({ youtube: { refresh_token: 'yt' }, instagram: { access_token: 'ig' } }));
      await credentialManager.saveTokenFor('tiktok', { refresh_token: 'tt' });
      const merged = JSON.parse(await fs.readFile(credentialManager.tokensPath, 'utf8'));
      if (merged.youtube?.refresh_token !== 'yt' || merged.instagram?.access_token !== 'ig' || merged.tiktok?.refresh_token !== 'tt') {
        throw new Error('Saving one platform token dropped another platform login');
      }

      // Queue: one row per configured platform, idempotent, retried before the upload, never after it.
      process.env.SOCIAL_PLATFORMS = 'youtube,tiktok,instagram,threads';
      const productionId = 'prod-social';
      const [clip, later] = await db.replaceShortClips(productionId, [
        { title: 'Short à publier', description: 'Description du Short.', tags: ['science'], status: 'scheduled', outputPath: videoPath, inheritedEvidence: { ready: true } },
        { title: 'Short de demain', description: 'Autre Short.', tags: ['science'], status: 'scheduled', outputPath: videoPath, inheritedEvidence: { ready: true } }
      ]);
      const outcomes = { tiktok: [], instagram: [] };
      const fake = platform => ({
        isConfigured: () => true,
        publish: async input => {
          const next = outcomes[platform].shift();
          if (next instanceof Error) throw next;
          return { ...next, metadata: { seenCaption: input.caption } };
        },
        checkStatus: async () => ({ status: 'published', externalId: 'ig-media', url: 'https://www.instagram.com/reel/ok/' })
      });
      const service = new SocialPublishingService(db, {
        logger: quiet,
        publishers: { tiktok: fake('tiktok'), instagram: fake('instagram'), threads: { isConfigured: () => false } }
      });
      const past = new Date(Date.now() - 60000).toISOString();
      await service.enqueueShort({ clip, publishTime: past, containsSyntheticMedia: true, profile: { call_to_action: 'Abonne-toi pour ne rien manquer.' } });
      const queued = await service.enqueueShort({ clip, publishTime: past });
      await service.enqueueShort({ clip: later, publishTime: new Date(Date.now() + 86400000).toISOString() });
      if (queued.length !== 2 || queued.map(post => post.platform).join(',') !== 'instagram,tiktok' || queued.some(post => post.metadata.containsSyntheticMedia !== true)) {
        throw new Error('Social posts were not queued once per configured platform');
      }

      outcomes.tiktok.push({ status: 'draft_sent', externalId: 'p-1' });
      outcomes.instagram.push(new Error('Instagram container creation failed: temporary'));
      let summary = await service.processQueue();
      let [igPost, ttPost] = await service.listForClip(clip.id);
      if (
        summary.drafts !== 1 || ttPost.status !== 'draft_sent' || ttPost.externalId !== 'p-1' ||
        !ttPost.metadata.seenCaption.includes('Abonne-toi pour ne rien manquer.') ||
        igPost.status !== 'scheduled' || igPost.attempts !== 1 || !igPost.error.includes('temporary')
      ) {
        throw new Error('Social queue did not record a draft and schedule a retry for a failure before the upload');
      }
      if ((await service.listForClip(later.id)).some(post => post.status !== 'scheduled' || post.attempts !== 0)) {
        throw new Error('A Short due tomorrow was published early');
      }

      const lost = new Error('socket hang up');
      lost.uploadStarted = true;
      lost.externalId = 'container-lost';
      outcomes.instagram.push(lost);
      summary = await service.processQueue();
      [igPost] = await service.listForClip(clip.id);
      if (summary.reconciliation !== 1 || igPost.status !== 'reconciliation_required' || igPost.externalId !== 'container-lost') {
        throw new Error('An upload with an unknown outcome must wait for reconciliation, not be retried');
      }
      summary = await service.processQueue();
      if (summary.reconciliation || outcomes.instagram.length) throw new Error('A post awaiting reconciliation was sent again');

      await db.updateSocialPost(igPost.id, { status: 'scheduled', attempts: 2, error: null });
      outcomes.instagram.push(new Error('Instagram container creation failed: invalid video'));
      summary = await service.processQueue();
      [igPost] = await service.listForClip(clip.id);
      if (summary.failed !== 1 || igPost.status !== 'failed' || igPost.attempts !== 3) {
        throw new Error('A post that keeps failing must stop after three attempts');
      }

      await db.updateSocialPost(igPost.id, { status: 'scheduled', attempts: 0, error: null });
      outcomes.instagram.push({ status: 'processing', externalId: 'container-2', metadata: {} });
      await service.processQueue();
      [igPost] = await service.listForClip(clip.id);
      if (igPost.status !== 'published' || igPost.url !== 'https://www.instagram.com/reel/ok/') {
        throw new Error('A Reel still processing was not picked up by the next status check');
      }
    } finally {
      if (savedPlatforms === undefined) delete process.env.SOCIAL_PLATFORMS; else process.env.SOCIAL_PLATFORMS = savedPlatforms;
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('TikTok and Instagram publishing test completed successfully');
  }

  async testProvenanceDesk() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ProvenanceService } = require('./utils/provenance-service');
    const { OperatorService } = require('./utils/operator-service');
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-provenance-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'provenance.db');
    await db.initialize();
    const productionId = 'prod-provenance-test';
    const videoPath = path.join(directory, 'video.mp4');
    const audioPath = path.join(directory, 'narration.mp3');
    await fs.writeFile(videoPath, Buffer.from('test-video'));
    await fs.writeFile(audioPath, Buffer.from('test-audio'));

    try {
      await db.saveProductionData({
        id: productionId,
        status: 'needs_review',
        assets: { finalVideo: { path: videoPath, simulated: false }, audio: { path: audioPath, status: 'ready', simulated: false, provider: 'fixture-tts' } },
        timeline: {}, scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(),
        priority: 50, estimatedDuration: '1:00'
      });
      const production = {
        id: productionId,
        strategy: {
          topic: 'Evidence-aware automation',
          researchSources: [{
            url: 'https://example.com/research/fact',
            title: 'Official research evidence',
            publisher: 'Example Institute',
            sourceType: 'official'
          }]
        },
        script: {
          title: 'Evidence-aware automation',
          fullScript: 'A sufficiently detailed script with a factual statement that must be reviewed before this production can be approved.'.repeat(3),
          callToAction: { subscribe: 'Subscribe for the next videos.' },
          claims: [{
            text: 'The documented workflow reduces repeated manual steps.',
            riskLevel: 'standard',
            sourceUrls: ['https://example.com/research/fact']
          }]
        },
        seo: {
          title: 'Evidence-aware automation',
          description: 'A detailed description of an evidence-aware automation workflow for careful channel operators.\n\n🔔 Subscribe for the next videos.\n\nCHAPTERS\n00:00 Why evidence matters\n00:40 The documented workflow\n01:30 What the review changes',
          tags: ['automation', 'evidence', 'workflow']
        },
        assets: { finalVideo: { path: videoPath, simulated: false, duration: 150 }, audio: { path: audioPath, status: 'ready', simulated: false, provider: 'fixture-tts' } }
      };
      await db.saveProductionSnapshot(production);

      const provenanceService = new ProvenanceService(db);
      const initialized = await provenanceService.initialize(productionId, production);
      if (
        initialized.status !== 'blocked' || initialized.sources.length !== 1 ||
        initialized.claims.length !== 1 || initialized.claims[0].sourceIds.length !== 1
      ) {
        throw new Error('Generated research sources and claims were not initialized as unresolved provenance');
      }

      const publishGuard = new PublishingSchedulingAgent(db, {});
      publishGuard.publishQueue = [{ productionId, status: 'scheduled', metadata: {} }];
      let blockedPublishRejected = false;
      try {
        await publishGuard.publishContent(productionId);
      } catch (error) {
        blockedPublishRejected = error.code === 'PROVENANCE_BLOCKED';
      }
      if (!blockedPublishRejected) throw new Error('Publishing did not independently enforce the provenance gate');

      let unverifiedSupportRejected = false;
      try {
        await provenanceService.review(productionId, {
          sources: initialized.sources,
          claims: [{ ...initialized.claims[0], status: 'supported' }]
        });
      } catch (error) {
        unverifiedSupportRejected = /verified source/.test(error.message);
      }
      if (!unverifiedSupportRejected) throw new Error('A claim was supported without reviewer-verified evidence');

      const reviewed = await provenanceService.review(productionId, {
        sources: initialized.sources.map(source => ({ ...source, status: 'verified' })),
        claims: [{ ...initialized.claims[0], status: 'supported' }],
        containsSyntheticMedia: true
      });
      if (reviewed.status !== 'verified' || !reviewed.containsSyntheticMedia || reviewed.summary.unresolvedClaims !== 0) {
        throw new Error('A complete evidence review was not persisted as verified');
      }

      const bundle = await db.getProductionBundle(productionId);
      const quality = await new OperatorService(db).runQualityChecks({ ...production, provenance: bundle.provenance }, {});
      if (!quality.passed || !quality.checks.find(check => check.id === 'provenance' && check.passed)) {
        throw new Error('Verified provenance did not satisfy the production quality gate');
      }

      let uploadRequest;
      const publishing = new PublishingSchedulingAgent(db, {});
      publishing.youtube = {
        videos: { insert: async request => { uploadRequest = request; return { data: { id: 'provenance-video' } }; } }
      };
      await publishing.uploadToYouTube({
        publishTime: new Date(Date.now() + 86400000).toISOString(),
        metadata: {
          seo: production.seo,
          video: { path: videoPath },
          privacyStatus: 'private',
          containsSyntheticMedia: true
        }
      });
      if (uploadRequest?.requestBody?.status?.containsSyntheticMedia !== true) {
        throw new Error('Synthetic-media disclosure was not handed to the YouTube upload request');
      }

      let emptyWaiverRejected = false;
      try {
        new ProvenanceService(db).build({
          sources: reviewed.sources,
          claims: [{ ...reviewed.claims[0], status: 'waived', notes: '' }]
        });
      } catch (error) {
        emptyWaiverRejected = /reviewer note/.test(error.message);
      }
      if (!emptyWaiverRejected) throw new Error('A claim waiver without a reviewer note was accepted');
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Research and provenance desk test completed successfully');
  }

  async testDiscoverabilityPreflight() {
    const fs = require('fs').promises;
    const os = require('os');
    const { DiscoverabilityService } = require('./utils/discoverability-service');
    const { DarkzSEOAdapter } = require('./utils/discoverability-adapters/darkzseo');
    const { OperatorService } = require('./utils/operator-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-discoverability-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'discoverability.db');
    await db.initialize();
    const productionId = 'prod-discoverability-test';
    const fakeAdapter = {
      audit: async content => ({
        schemaVersion: '1.0',
        engine: { name: 'darkzseo', version: '1.4.0' },
        mode: 'content',
        target: content.id,
        status: 'attention_required',
        summary: {
          severity: { CRITICAL: 0, HIGH: 1, MEDIUM: 0, LOW: 0, INFO: 0 },
          category: { SEO: 0, GEO: 1, AIO: 0, AEO: 0 }
        },
        findings: [{
          ruleId: 'geo.trust_network', category: 'GEO', severity: 'HIGH',
          applicability: ['youtube', 'content'],
          message: 'Trust Network: Long content lacks authority links',
          remediation: 'Add a verified authority source.'
        }]
      })
    };

    try {
      const bundledReport = await new DarkzSEOAdapter({ scriptPath: null }).audit({
        id: 'bundled-audit', platform: 'youtube', brand: 'AgentTube', title: 'Best workflow review',
        description: 'A useful comparison.', transcript: 'Detailed content '.repeat(100),
        sections: [{ title: 'What should you choose?', content: 'answer '.repeat(61) }]
      });
      if (
        bundledReport.engine.version !== '1.4.0-bundled' ||
        !bundledReport.findings.some(finding => finding.ruleId === 'aio.comparison_intent') ||
        !bundledReport.findings.some(finding => finding.ruleId === 'aio.direct_answer')
      ) {
        throw new Error('The bundled discoverability audit did not provide the public content contract');
      }
      const configuredPath = process.env.DARKZSEO_PATH;
      delete process.env.DARKZSEO_PATH;
      try {
        if (new DarkzSEOAdapter().scriptPath !== null) {
          throw new Error('DarkzSEO selected an external Python checkout without explicit configuration');
        }
      } finally {
        if (configuredPath === undefined) delete process.env.DARKZSEO_PATH;
        else process.env.DARKZSEO_PATH = configuredPath;
      }
      const brokenExternal = new DarkzSEOAdapter({ scriptPath: 'broken-darkzseo.py' });
      brokenExternal.auditExternal = async () => {
        const error = new Error('No module named darkzseo');
        error.code = 'DARKZSEO_FAILED';
        throw error;
      };
      const fallbackReport = await brokenExternal.audit({
        id: 'external-fallback', platform: 'youtube', title: 'Fallback audit'
      });
      if (fallbackReport.engine.version !== '1.4.0-bundled' || fallbackReport.status === 'unavailable') {
        throw new Error('A broken external DarkzSEO runtime did not fall back to the bundled audit');
      }
      await db.saveProductionData({
        id: productionId, status: 'needs_review', assets: {}, timeline: {},
        scheduledPublishTime: null, priority: 50, estimatedDuration: '1:00'
      });
      const production = {
        id: productionId,
        script: { title: 'AgentTube discoverability', fullScript: 'Detailed content '.repeat(200), sections: [] },
        seo: { title: 'AgentTube discoverability', description: 'A detailed discoverability review.', chapters: [] },
        provenance: { sources: [] }
      };
      await db.saveProductionSnapshot(production);
      const service = new DiscoverabilityService(db, { adapter: fakeAdapter });
      const first = await service.auditProduction(production, { channel_name: 'AgentTube' });
      if (first.engineVersion !== '1.4.0' || first.findings.length !== 1 || first.pendingCount !== 1) {
        throw new Error('The versioned DarkzSEO report was not persisted');
      }

      const quality = await new OperatorService(db).runQualityChecks({ ...production, discoverability: first }, {});
      const discoverabilityCheck = quality.checks.find(check => check.id === 'discoverability');
      if (!discoverabilityCheck || discoverabilityCheck.passed || discoverabilityCheck.blocking) {
        throw new Error('High-priority discoverability guidance was not advisory and visible');
      }

      let shortReasonRejected = false;
      try {
        await service.reviewFinding(first.findings[0].id, { status: 'dismissed', reason: 'no' });
      } catch (error) {
        shortReasonRejected = /at least 5/.test(error.message);
      }
      if (!shortReasonRejected) throw new Error('A false-positive dismissal without reviewer evidence was accepted');

      await service.reviewFinding(first.findings[0].id, { status: 'dismissed', reason: 'The cited source is attached in the approved evidence desk.' });
      const second = await service.auditProduction(production, { channel_name: 'AgentTube' });
      if (second.findings[0].reviewStatus !== 'dismissed' || second.pendingCount !== 0) {
        throw new Error('Finding review evidence did not carry forward across matching audits');
      }
      const reviewedQuality = await new OperatorService(db).runQualityChecks({ ...production, discoverability: second }, {});
      if (!reviewedQuality.checks.find(check => check.id === 'discoverability' && check.passed)) {
        throw new Error('A dismissed false positive remained an actionable quality warning');
      }

      const { YouTubeAutomationAgent } = require('./index');
      const apiAgent = new YouTubeAutomationAgent();
      apiAgent.db = db;
      apiAgent.operator = new OperatorService(db);
      apiAgent.discoverability = service;
      apiAgent.setupAPI();
      const server = await new Promise(resolve => {
        const listener = apiAgent.app.listen(0, '127.0.0.1', () => resolve(listener));
      });
      try {
        const address = server.address();
        const apiHeaders = { 'content-type': 'application/json', ...(process.env.API_KEY ? { 'x-api-key': process.env.API_KEY } : {}) };
        const runResponse = await fetch(`http://127.0.0.1:${address.port}/api/content/${productionId}/discoverability/run`, {
          method: 'POST', headers: apiHeaders, body: JSON.stringify({ platform: 'youtube' })
        });
        const runPayload = await runResponse.json();
        if (!runResponse.ok || runPayload.audit?.schemaVersion !== '1.0' || !runPayload.result?.discoverability) {
          throw new Error('Discoverability run API did not return the persisted versioned audit');
        }
        const apiFinding = runPayload.audit.findings[0];
        const reviewResponse = await fetch(`http://127.0.0.1:${address.port}/api/discoverability/findings/${apiFinding.id}`, {
          method: 'PATCH', headers: apiHeaders, body: JSON.stringify({ status: 'accepted' })
        });
        const reviewPayload = await reviewResponse.json();
        if (!reviewResponse.ok || reviewPayload.result?.finding?.reviewStatus !== 'accepted') {
          throw new Error('Discoverability review API did not persist the operator decision');
        }
      } finally {
        await new Promise(resolve => server.close(resolve));
      }

      const unavailableService = new DiscoverabilityService(db, {
        adapter: { audit: async () => { const error = new Error('Python is not installed'); error.code = 'DARKZSEO_UNAVAILABLE'; throw error; } }
      });
      const unavailable = await unavailableService.auditProduction(production, { channel_name: 'AgentTube' });
      if (unavailable.status !== 'unavailable' || unavailable.errorCode !== 'DARKZSEO_UNAVAILABLE' || unavailable.findings.length !== 0) {
        throw new Error('An unavailable DarkzSEO runtime was not stored explicitly');
      }
      const unavailableQuality = await new OperatorService(db).runQualityChecks({ ...production, discoverability: unavailable }, {});
      const unavailableCheck = unavailableQuality.checks.find(check => check.id === 'discoverability');
      if (!unavailableCheck || unavailableCheck.passed || unavailableCheck.blocking) {
        throw new Error('DarkzSEO runtime availability did not remain an explicit non-blocking check');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('DarkzSEO discoverability preflight test completed successfully');
  }

  async testOpenIssueRegressions() {
    const { ModernAuth } = require('./modern-auth');
    const { ProductionManagementAgent } = require('./agents/production-management-agent');
    const { YouTubeAutomationAgent } = require('./index');

    const auth = new ModernAuth();
    const fixedRedirect = auth.resolveRedirect({
      youtube: { redirect_uris: ['http://127.0.0.1'] }
    });
    if (fixedRedirect.hostname !== '127.0.0.1' || fixedRedirect.port < 8000 || fixedRedirect.pathname !== '/') {
      throw new Error('OAuth did not use a desktop-app loopback redirect with a local dynamic port');
    }

    const visualStyles = [];
    const productionAgent = Object.create(ProductionManagementAgent.prototype);
    productionAgent.db = { getChannelProfile: async () => ({ visual_style: 'animated' }) };
    productionAgent.logger = this.logger;
    productionAgent.aiVideoGenerator = {
      generateVisualAssets: async (prompt, style) => {
        visualStyles.push({ prompt, style });
        return [`asset-${visualStyles.length}.png`];
      }
    };
    const productionData = {
      script: { title: 'Configured visuals', mainContent: { sections: [{ title: 'Clear demonstration' }] } },
      assets: {}, timeline: {}, estimatedDuration: '1:00'
    };
    await productionAgent.generateVideoContent(productionData);
    if (!visualStyles.length || visualStyles.some(item => item.style !== 'animated' || /ethereal|mystical|dreamscape/i.test(item.prompt))) {
      throw new Error('Initial scene generation mixed hardcoded ethereal cues with the configured visual style');
    }

    const pipeline = new YouTubeAutomationAgent();
    pipeline.db = {
      getChannelProfile: async () => ({}),
      saveProductionData: async data => data.id,
      saveProductionSnapshot: async () => {},
      getSetting: async () => 'true',
      saveContentReview: async () => {},
      updateProductionStatus: async () => {}
    };
    pipeline.provenance = { initialize: async () => ({ sources: [], claims: [], status: 'not_required' }) };
    pipeline.operator = {
      runQualityChecks: async () => ({ passed: true, score: 100, checks: [], blockingFailures: [] }),
      notify: async () => {}
    };
    pipeline.preparePackagingExperiment = async () => null;
    pipeline.agents = {
      strategy: { generateContentStrategy: async () => ({ topic: 'Null context', angle: 'Original angle' }) },
      scriptWriter: { generateScript: async strategy => ({ title: strategy.topic, fullScript: 'Complete script.' }) },
      thumbnailDesigner: { generateThumbnail: async () => ({ path: 'thumbnail.png' }) },
      seoOptimizer: { optimize: async script => ({ title: script.title, description: 'Description', tags: ['test'] }) },
      production: { processContent: async input => ({
        id: 'null-context-production', status: 'ready', ...input, assets: {}, timeline: {},
        scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(), priority: 50
      }) },
      publishing: { scheduleContent: async () => null }
    };
    const generated = await pipeline.generateContent(null, null, 'short', { strategyContext: null });
    if (generated.contentId !== 'null-context-production') {
      throw new Error('A null manual strategy context still prevented generation');
    }

    this.logger.info('Open issue regression test completed successfully');
  }

  async testResumableGenerationCheckpoints() {
    const fs = require('fs').promises;
    const os = require('os');
    const { YouTubeAutomationAgent } = require('./index');
    const { GenerationRecoveryService } = require('./utils/generation-recovery-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-recovery-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'recovery.db');
    await db.initialize();

    const thumbnailPath = path.join(directory, 'thumbnail.jpg');
    const videoPath = path.join(directory, 'video.mp4');
    await fs.writeFile(thumbnailPath, Buffer.from('thumbnail'));
    await fs.writeFile(videoPath, Buffer.from('video'));
    const strategy = {
      topic: 'Checkpointed automation',
      contentType: 'Tutorial',
      requestedStyle: 'tutorial',
      requestedLengthKey: 'short'
    };
    const script = {
      title: 'Checkpointed automation',
      fullScript: 'A complete script that can be reused after an interrupted generation run.',
      mainContent: [{ text: 'Reusable content' }]
    };
    let strategyCalls = 0;
    let scriptCalls = 0;
    let productionCalls = 0;

    try {
      const agent = new YouTubeAutomationAgent();
      agent.db = db;
      agent.recovery = new GenerationRecoveryService(db, {
        logger: agent.logger,
        baseDelayMs: 0,
        updateJobStage: (...args) => agent.updateJobStage(...args)
      });
      agent.readiness = { assertReady: async () => true };
      agent.operator = {
        runQualityChecks: async () => ({ passed: true, score: 100, checks: [{ passed: true }], blockingFailures: [] }),
        notify: async () => null
      };
      agent.agents = {
        strategy: { generateContentStrategy: async () => { strategyCalls++; return strategy; } },
        scriptWriter: { generateScript: async () => { scriptCalls++; return script; } },
        thumbnailDesigner: { generateThumbnail: async () => ({ path: thumbnailPath, concept: {} }) },
        seoOptimizer: { optimize: async () => ({ title: script.title, description: 'A complete description.', tags: ['automation'] }) },
        production: {
          processContent: async input => {
            productionCalls++;
            return {
              id: `recovery-production-${Date.now()}`,
              status: 'ready',
              ...input,
              assets: {
                finalVideo: { path: videoPath, simulated: false },
                thumbnail: { path: thumbnailPath }
              },
              timeline: {},
              scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(),
              priority: 50,
              estimatedDuration: '2:00'
            };
          }
        },
        publishing: { scheduleContent: async () => null }
      };

      const job = await db.createGenerationJob({
        topic: strategy.topic,
        style: 'tutorial',
        length: 'short',
        source: 'manual',
        strategyContext: { objective: 'Test recovery' }
      });
      await db.saveGenerationCheckpoint(job.id, 'strategy', {
        status: 'completed', artifact: strategy, completedAt: new Date().toISOString()
      });
      await db.saveGenerationCheckpoint(job.id, 'script', {
        status: 'completed', artifact: script, completedAt: new Date().toISOString()
      });
      await db.updateGenerationJob(job.id, { status: 'running', stage: 'thumbnail', progress: 40 });
      await db.markInterruptedJobs();
      const interrupted = await db.getGenerationJob(job.id);
      if (interrupted.status !== 'interrupted' || interrupted.stage !== 'thumbnail') {
        throw new Error('Restart recovery did not preserve the interrupted stage');
      }

      const resumed = await agent.resumeGenerationJob(job.id);
      if (resumed.details?.resumeFrom !== 'thumbnail') {
        throw new Error('Resume did not select the first incomplete stage');
      }
      await agent.waitForGenerationJob(job.id);
      const completed = await db.getGenerationJob(job.id);
      const checkpoints = await db.listGenerationCheckpoints(job.id);
      if (
        completed.status !== 'completed' ||
        checkpoints.filter(item => item.status === 'completed').length !== 6 ||
        strategyCalls !== 0 || scriptCalls !== 0 || productionCalls !== 1 ||
        !completed.details.reusedStages.includes('strategy') || !completed.details.reusedStages.includes('script')
      ) {
        throw new Error('Generation did not resume from verified checkpoints');
      }

      let transientAttempts = 0;
      const transientJob = await db.createGenerationJob({ topic: 'Transient retry' });
      const recovered = await agent.recovery.run(transientJob.id, 'strategy', 10, async () => {
        transientAttempts++;
        if (transientAttempts === 1) {
          const error = new Error('Temporary provider failure');
          error.status = 503;
          throw error;
        }
        return { topic: 'Recovered strategy' };
      });
      const transientCheckpoint = await db.getGenerationCheckpoint(transientJob.id, 'strategy');
      if (recovered.topic !== 'Recovered strategy' || transientAttempts !== 2 || transientCheckpoint.attempt_count !== 2) {
        throw new Error('A retry-safe transient stage failure was not recovered with bounded attempts');
      }

      const invalidJob = await db.createGenerationJob({ topic: 'Invalid dependency' });
      await db.saveGenerationCheckpoint(invalidJob.id, 'strategy', {
        status: 'completed', artifact: {}, completedAt: new Date().toISOString()
      });
      await db.saveGenerationCheckpoint(invalidJob.id, 'script', {
        status: 'completed', artifact: script, completedAt: new Date().toISOString()
      });
      await agent.recovery.run(invalidJob.id, 'strategy', 10, async () => ({ topic: 'Rebuilt dependency' }));
      if (await db.getGenerationCheckpoint(invalidJob.id, 'script')) {
        throw new Error('A stale downstream checkpoint survived invalid upstream artifact recovery');
      }
    } finally {
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Resumable generation checkpoints test completed successfully');
  }

  async testAIUsageMeasurement() {
    const fs = require('fs').promises;
    const os = require('os');
    const { execFileSync } = require('child_process');
    const aiUsage = require('./utils/ai-usage');
    const claudeCode = require('./utils/claude-code-provider');
    const { AITextService } = require('./utils/ai-text-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-usage-'));
    const saved = { log: process.env.AI_USAGE_LOG, bin: process.env.CLAUDE_CODE_BIN, provider: process.env.TEXT_PROVIDER };
    // Stands in for `claude -p --output-format json`: a result with its usage, a failure on demand, or an older CLI's text.
    const bin = path.join(directory, 'claude');
    await fs.writeFile(bin, `#!/bin/sh
input=$(cat)
case "$input" in
  *FAIL*) echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"overloaded","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":0},"modelUsage":{"claude-opus-5":{}}}'; exit 1 ;;
  *TEXT*) echo 'plain answer' ;;
  *) echo '{"type":"result","subtype":"success","is_error":false,"result":"  the answer  ","num_turns":1,"total_cost_usd":0.25,"usage":{"input_tokens":12,"cache_creation_input_tokens":13000,"cache_read_input_tokens":14000,"output_tokens":800,"server_tool_use":{"web_search_requests":3}},"modelUsage":{"claude-opus-5":{"costUSD":0.25}}}' ;;
esac
`, { mode: 0o755 });
    const log = path.join(directory, 'usage.jsonl');
    process.env.AI_USAGE_LOG = log;
    process.env.CLAUDE_CODE_BIN = bin;
    process.env.TEXT_PROVIDER = 'claude-code';
    try {
      // 1. A call made for a video is recorded with its purpose, its job, its tokens and its cost; the answer is the text.
      const service = new AITextService({});
      const answer = await aiUsage.withContext({ jobId: 'job_usage' }, () => service.generateText('Write the script', { purpose: 'script' }));
      const [first] = aiUsage.read();
      if (answer !== 'the answer' || first?.purpose !== 'script' || first.jobId !== 'job_usage' || first.provider !== 'claude-code' ||
        first.model !== 'claude-opus-5' || first.inputTokens !== 12 || first.cacheCreationTokens !== 13000 || first.cacheReadTokens !== 14000 ||
        first.outputTokens !== 800 || first.webSearches !== 3 || first.costUsd !== 0.25 || first.ok !== true || !(first.durationMs >= 0)) {
        throw new Error('A Claude Code call was not recorded with its purpose, job, tokens and cost');
      }

      // 2. A failure still rejects, and is recorded with what it used.
      try {
        await claudeCode.runClaudeCode({ prompt: 'FAIL now', purpose: 'seo' });
        throw new Error('failure resolved');
      } catch (error) {
        if (!error.message.includes('overloaded')) throw new Error(`A failed Claude Code call was not reported: ${error.message}`);
      }
      const failed = aiUsage.read()[1];
      if (failed?.purpose !== 'seo' || failed.ok !== false || failed.costUsd !== 0.01 || failed.jobId || !failed.error.includes('overloaded')) {
        throw new Error('A failed Claude Code call was not recorded');
      }

      // 3. Without a purpose, the call is named after its caller; an older CLI's text answer still goes through.
      const plain = await claudeCode.runClaudeCode({ prompt: 'TEXT please' });
      const unnamed = aiUsage.read()[2];
      if (plain !== 'plain answer' || !/test\.js:\d+/.test(unnamed?.purpose || '') || unnamed.ok !== true) {
        throw new Error(`An unlabelled call was not named after its caller (${unnamed?.purpose})`);
      }

      // 4. The summary puts the most expensive purpose first, and the report prints it.
      const [top] = aiUsage.summarize(aiUsage.read());
      if (top.name !== 'script' || top.calls !== 1 || top.inputTokens !== 27012 || top.cacheTokens !== 27000) {
        throw new Error('The usage summary does not rank purposes by cost');
      }
      const report = execFileSync(process.execPath, [path.join(__dirname, 'scripts', 'ai-usage.js'), '--all'], {
        env: { ...process.env, AI_USAGE_LOG: log }, encoding: 'utf8'
      });
      if (!report.includes('3 appels') || !/script\s+1\s+27,0 k\s+800\s+3\s+0,25 \$\s+96 %/.test(report) || !report.includes('Par vidéo : 1 vidéo, 0,25 $')) {
        throw new Error(`The usage report is wrong:\n${report}`);
      }

      // 5. AI_USAGE_LOG=off records nothing.
      process.env.AI_USAGE_LOG = 'off';
      await claudeCode.runClaudeCode({ prompt: 'again', purpose: 'script' });
      if (aiUsage.read({ file: log }).length !== 3) throw new Error('AI_USAGE_LOG=off still recorded a call');
    } finally {
      for (const [key, name] of [['log', 'AI_USAGE_LOG'], ['bin', 'CLAUDE_CODE_BIN'], ['provider', 'TEXT_PROVIDER']]) {
        if (saved[key] === undefined) delete process.env[name];
        else process.env[name] = saved[key];
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async testJevClient() {
    const fs = require('fs').promises;
    const os = require('os');
    const aiUsage = require('./utils/ai-usage');
    const jev = require('./utils/jev');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-jev-'));
    const saved = { log: process.env.AI_USAGE_LOG, key: process.env.TYPESAFE_API_KEY, jev: process.env.JEV };
    process.env.AI_USAGE_LOG = path.join(directory, 'usage.jsonl');
    process.env.TYPESAFE_API_KEY = 'test-key';
    delete process.env.JEV;
    try {
      // 1. A rate-limited request is tried again; the answer comes back by question and its cost is recorded.
      const requests = [];
      const overloaded = Object.assign(new Error('rate limited'), { response: { status: 429 } });
      const answers = await jev.ask({
        purpose: 'expert_triage', delayMs: 0, state: { narration: 'Texte' },
        questions: { specialised: { type: 'noul', instructions: 'Spécialisé ?', criteria: { true: 'oui', false: 'non' } } },
        http: {
          post: async (url, body, options) => {
            requests.push({ url, body, options });
            if (requests.length === 1) throw overloaded;
            return { data: { model: 'jev-1.13.0', answers: { specialised: { type: 'noul', noul: 0.07 } }, usage: { input_tokens: 1000000, output_tokens: 20 } } };
          }
        }
      });
      const [entry] = aiUsage.read();
      if (answers.specialised.noul !== 0.07 || requests.length !== 2 || requests[1].url !== 'https://api.typesafe.ai/v1/systemone' ||
        requests[1].options.headers.Authorization !== 'Bearer test-key' || requests[1].body.model !== 'jev-latest' || requests[1].body.state.narration !== 'Texte' ||
        entry?.provider !== 'jev' || entry.purpose !== 'expert_triage' || entry.model !== 'jev-1.13.0' || Math.abs(entry.costUsd - 0.042) > 1e-9 || entry.ok !== true) {
        throw new Error('A Jev request was not retried, answered or recorded as expected');
      }

      // 2. A refused key is final: no retry, an error, and the failure recorded.
      let calls = 0;
      try {
        await jev.ask({ purpose: 'expert_triage', delayMs: 0, state: 'x', questions: {}, http: { post: async () => { calls++; throw Object.assign(new Error('unauthorized'), { response: { status: 401 } }); } } });
        throw new Error('refused key accepted');
      } catch (error) {
        if (calls !== 1 || !error.message.includes('HTTP 401') || aiUsage.read()[1]?.ok !== false) throw new Error('A refused Jev key was retried or not reported');
      }

      // 3. Jev runs with a key, unless JEV=off.
      if (!jev.enabled()) throw new Error('Jev is off despite a key');
      process.env.JEV = 'off';
      if (jev.enabled()) throw new Error('JEV=off did not turn Jev off');
      delete process.env.JEV;
      delete process.env.TYPESAFE_API_KEY;
      if (jev.enabled()) throw new Error('Jev is on without a key');
    } finally {
      for (const [key, name] of [['log', 'AI_USAGE_LOG'], ['key', 'TYPESAFE_API_KEY'], ['jev', 'JEV']]) {
        if (saved[key] === undefined) delete process.env[name];
        else process.env[name] = saved[key];
      }
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  // Without CONTENT_MODE=react, the agent runs an explainer channel: none of the react profile's rules, no two-part
  // videos, no verdict, no lessons, gaps, watched channels or persuasion, a neutral look, and a site without the react
  // pages.
  async testStandardMode() {
    const fs = require('fs').promises;
    const os = require('os');
    const saved = { mode: process.env.CONTENT_MODE, repo: process.env.SITE_REPO, palette: process.env.VISUAL_PALETTE, style: process.env.IMAGE_STYLE_PROMPT };
    process.env.CONTENT_MODE = 'standard';
    process.env.SITE_REPO = '';
    delete process.env.VISUAL_PALETTE;
    delete process.env.IMAGE_STYLE_PROMPT;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-standard-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'standard.db');
    await db.initialize();
    try {
      const { contentMode } = require('./utils/content-mode');
      const { ScriptWriterAgent } = require('./agents/script-writer-agent');
      const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
      const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
      const { ReactiveWatch } = require('./utils/reactive-watch');
      const { paletteFor } = require('./utils/visualizer');
      const { styleSuffix, STANDARD_STYLE } = require('./utils/image-generator');
      const { buildSite } = require('./utils/claims-site');
      const { YouTubeAutomationAgent } = require('./index');
      if (contentMode() !== 'standard') throw new Error('The default mode is not standard');

      // The script: an explainer, whatever the model sends back about registers or a verdict.
      const writer = Object.create(ScriptWriterAgent.prototype);
      writer.logger = { info() {}, warn() {}, error() {} };
      let prompt = '';
      writer.aiTextService = {
        isAvailable: () => true,
        providerName: 'test',
        generateText: async text => {
          prompt = text;
          return JSON.stringify({
            title: 'Comment fonctionne une éclipse ?', hook: 'La Lune cache le Soleil.',
            sections: [{ title: 'Alignement', register: 'opening', content: ['Un paragraphe.'] }, { title: 'Ombre', content: ['Un autre.'] }],
            cta: 'Abonne-toi pour la suite.', claims: [], examinedClaim: { statement: 'x', verdict: 'wrong' }
          });
        }
      };
      const script = await writer.generateScriptWithAI({ topic: 'Les éclipses', contentType: 'Explainer', technique: 'counting' }, { tone: 'x', pacing: 'y' });
      if (/register|examinedClaim|\bturn\b|Speak to the viewer/i.test(prompt) || !prompt.includes('Body sections') || !prompt.includes('says clearly what the video answers') ||
        script.mainContent.sections.some(section => section.register !== 'main') || script.examinedClaim !== null) {
        throw new Error('A standard script still follows the react format');
      }
      await writer.generateScriptWithAI({ topic: 'Les éclipses', contentType: 'Lesson', technique: 'counting' }, { tone: 'x', pacing: 'y' });
      if (/Technique taught/i.test(prompt)) throw new Error('The lesson format is used outside react mode');

      // SEO: the generic title and description rules.
      const seo = Object.create(SEOOptimizerAgent.prototype);
      seo.logger = { info() {}, warn() {}, error() {} };
      let seoPrompt = '';
      seo.aiTextService = { isAvailable: () => true, generateText: async text => { seoPrompt = text; return '{}'; } };
      await seo.generateSEOWithAI({ title: 'T', sections: [] }, { topic: 'Les éclipses', contentType: 'Explainer' }).catch(() => null);
      if (!seoPrompt || !seoPrompt.includes('says clearly what the video answers') || !seoPrompt.includes('what the viewer will get from the video')) {
        throw new Error('The standard SEO prompt does not use the generic rules');
      }

      // The planner: no lessons, no gaps; the lesson format is refused.
      const strategy = new ContentStrategyAgent(db, {});
      if (await strategy.lessonDue() !== null || (await strategy.openGaps()).length) throw new Error('Lessons or gaps run outside react mode');
      const plan = strategy.normalizeAutonomousPlan([{ topic: 'Les éclipses', pillar: 'Astronomie', format: 'lesson', length: 'medium' }], { contentPillars: ['Astronomie'] }, 1, {});
      if (plan.some(item => item.format === 'lesson')) throw new Error('The planner kept a lesson outside react mode');
      const app = Object.create(YouTubeAutomationAgent.prototype);
      if (app.validateGenerateRequestBody({ topic: 'Les éclipses', style: 'lesson' }).valid) throw new Error('The lesson format was accepted outside react mode');

      // No watched channels; a neutral look.
      if (new ReactiveWatch(db).enabled()) throw new Error('The watch runs outside react mode');
      if (paletteFor('main') !== 'abyss' || styleSuffix('main') !== STANDARD_STYLE) throw new Error('The standard look is the react one');

      // The site: facts, sources and corrections; no technique or examined-channel pages, no error link without a
      // repository.
      await db.executeQuery('INSERT INTO productions (id, status) VALUES (?, ?)', ['prod_std', 'published']);
      await db.saveProductionSnapshot({ id: 'prod_std', strategy: { topic: 'Les éclipses' }, script: { title: 'Comment fonctionne une éclipse ?' } });
      await db.executeQuery(
        'INSERT INTO publish_schedule (id, production_id, title, publish_time, status, metadata, youtube_id, youtube_url, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ['schedule_std', 'prod_std', 'T', '2026-10-01T10:00:00Z', 'published', JSON.stringify({ privacyStatus: 'public', contentType: 'long_form' }), 'yt_std', 'https://www.youtube.com/watch?v=yt_std', '2026-10-01T10:00:00Z']
      );
      const { files } = await buildSite(db);
      const all = Object.keys(files).join(' ');
      if (/techniques\/|chaines\//.test(all) || /Chaînes examinées|Réponses rapides|issues\/new/.test(Object.values(files).join(' ')) || !files['index.html'].includes('Comment fonctionne une éclipse ?')) {
        throw new Error('The standard site shows react pages or a link to a repository that is not set');
      }
    } finally {
      for (const [key, name] of [['mode', 'CONTENT_MODE'], ['repo', 'SITE_REPO'], ['palette', 'VISUAL_PALETTE'], ['style', 'IMAGE_STYLE_PROMPT']]) {
        if (saved[key] === undefined) delete process.env[name];
        else process.env[name] = saved[key];
      }
      await new Promise(resolve => db.db.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async testReactiveShortSeries() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ReactiveWatch, partPassages } = require('./utils/reactive-watch');
    const { renderShort, compileSeries, parseSrt } = require('./utils/vertical-short');
    const { ScriptWriterAgent } = require('./agents/script-writer-agent');
    const { OperatorService } = require('./utils/operator-service');
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const { YouTubeAutomationAgent } = require('./index');
    const { buildSite } = require('./utils/claims-site');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-series-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'series.db');
    await db.initialize();
    const savedSite = process.env.SITE_BASE_URL;
    process.env.SITE_BASE_URL = 'https://example.github.io/verifications';
    try {
      // 1. Most answers are one Short; Jev asks for a series only when it is sure many arguments need it, two passages a
      // part. A single Short quotes the three strongest passages, a series splits them all, in the video's order.
      const passages = [
        { text: 'P1', timestamp: '0:10', probability: 0.7 }, { text: 'P2', timestamp: '0:40', probability: 0.95 },
        { text: 'P3', timestamp: '1:20', probability: 0.9 }, { text: 'P4', timestamp: '2:00', probability: 0.65 },
        { text: 'P5', timestamp: '3:00', probability: 0.8 }
      ];
      const texts = list => list.map(item => item.text).join();
      if (texts(partPassages(passages)) !== 'P2,P3,P5' || texts(partPassages(passages, 1, 3)) !== 'P1,P2' ||
        texts(partPassages(passages, 3, 3)) !== 'P5' || texts(partPassages(passages.slice().reverse(), 2, 3)) !== 'P3,P4') {
        throw new Error('The passages of a Short or of the parts of a series are wrong');
      }
      const judgeWith = (choice, confidence) => new ReactiveWatch(db, { jev: {
        enabled: () => true,
        ask: async () => ({ technique: { choice: 'authority', confidence: 0.5 }, stakes: { score: 0.4 }, length: { choice, confidence } })
      } });
      const context = { title: 'T', channel: 'C' };
      if ((await judgeWith('series', 0.9).judge(context, passages)).parts !== 3 || (await judgeWith('series', 0.9).judge(context, passages.slice(0, 4))).parts !== 2 ||
        (await judgeWith('series', 0.6).judge(context, passages)).parts !== 1 || (await judgeWith('one', 0.95).judge(context, passages)).parts !== 1 ||
        (await judgeWith('series', 0.95).judge(context, passages.slice(0, 2))).parts !== 1 || (await new ReactiveWatch(db, { jev: { enabled: () => false } }).judge(context, passages)).parts !== 1) {
        throw new Error('The length of the answer is not decided as it should');
      }

      // 2. The script of a Short: its own word budget and structure; a part of a series answers its own passages, is
      // numbered in its title, and announces the next part.
      const writer = Object.create(ScriptWriterAgent.prototype);
      writer.logger = { info() {}, warn() {}, error() {} };
      let prompt = '';
      writer.aiTextService = {
        isAvailable: () => true,
        providerName: 'test',
        generateText: async text => {
          prompt = text;
          return JSON.stringify({ title: 'Le moteur à eau fonctionne-t-il ? (partie 1/3)', hook: 'Partie 2 : le réservoir.', sections: [{ title: 'Le réservoir', register: 'main', content: ['Un paragraphe.'] }], cta: 'Abonne-toi.', claims: [] });
        }
      };
      const strategy = {
        topic: 'Le moteur à eau', origin: 'reactive', format: 'short', part: 2, parts: 3, contentType: 'Explainer',
        examinedVideo: { title: 'Le moteur à eau', channel: 'Chaîne X', url: 'https://www.youtube.com/watch?v=x', passages: [{ text: 'P3' }, { text: 'P4' }] }
      };
      const script = await writer.generateScriptWithAI(strategy, { tone: 'x', pacing: 'y' });
      if (script.title !== 'Le moteur à eau fonctionne-t-il ? (partie 2/3)' || !prompt.includes('part 2 of 3') || !prompt.includes('across 2-4 short sections') ||
        !prompt.includes('« Partie 2 : »') || !prompt.includes('part 3 answers the next point') || !prompt.includes('« P3 »') ||
        prompt.includes('across 6-9 sections') || !prompt.includes('under 70 characters')) {
        throw new Error('The script of a part of a series is not written as a Short');
      }
      await writer.generateScriptWithAI({ ...strategy, part: 3 }, { tone: 'x', pacing: 'y' });
      if (prompt.includes('answers the next argument') || !prompt.includes('as a whole')) throw new Error('The last part does not close the series');

      // 3. The vertical Short: the montage over the whole narration, the subscribe card over the spoken call to action,
      // the next part announced; the 16:9 parts of a series joined over a blurred copy of each, captions moved along.
      const montage = [];
      const shorts = {
        width: 1080, height: 1920,
        hasIllustrations: async () => true,
        renderMontage: async (bundle, clip) => { montage.push(clip); return { total: 92.6, cues: [], words: [], expectedText: null, credits: [] }; },
        verifyRender: async () => null
      };
      const scenes = [{ id: 'a', position: 0, duration: 20 }, { id: 'b', position: 1, duration: 60 }, { id: 'c', position: 2, duration: 12 }];
      const vertical = await renderShort({ id: 'prod_p1', strategy: { format: 'short', part: 1, parts: 3 }, script: { title: 'T' }, assets: { audio: { path: 'a.wav' } } }, scenes, { shorts, directory });
      if (vertical.aspectRatio !== '9:16' || vertical.duration !== 92.6 || montage[0].segments[0].end !== 92 || montage[0].closingAt !== 80 ||
        montage[0].endLine !== 'SUITE : PARTIE 2' || montage[0].cta !== null) {
        throw new Error(`The vertical Short is not laid out over the whole narration: ${JSON.stringify(montage[0])}`);
      }
      await renderShort({ id: 'prod_p3', strategy: { format: 'short', part: 3, parts: 3 }, script: { title: 'T' }, assets: { audio: { path: 'a.wav' } } }, scenes, { shorts, directory });
      if (montage[1].endLine !== null) throw new Error('The last part announces a next part');
      const srt = (start, end, text) => `1\n00:00:${String(start).padStart(2, '0')},000 --> 00:00:${String(end).padStart(2, '0')},000\n${text}\n`;
      await fs.writeFile(path.join(directory, 'p1.srt'), srt(1, 3, 'un'));
      await fs.writeFile(path.join(directory, 'p2.srt'), srt(2, 4, 'deux'));
      const ffmpeg = [];
      const compiled = await compileSeries([
        { path: path.join(directory, 'p1.mp4'), duration: 90, captionsPath: path.join(directory, 'p1.srt') },
        { path: path.join(directory, 'p2.mp4'), duration: 80, captionsPath: path.join(directory, 'p2.srt') }
      ], path.join(directory, 'series.mp4'), { runFFmpeg: async args => ffmpeg.push(args), getMediaDuration: async file => (file.endsWith('p1.mp4') ? 90.5 : 80) });
      const filter = ffmpeg[0][ffmpeg[0].indexOf('-filter_complex') + 1];
      const cues = parseSrt(await fs.readFile(compiled.captionsPath, 'utf8'));
      if (compiled.aspectRatio !== '16:9' || compiled.duration !== 170.5 || !filter.includes('boxblur') || !filter.includes('overlay=(W-w)/2:0') ||
        !filter.includes('concat=n=2:v=1:a=1') || cues.length !== 2 || cues[1].start !== 92.5 || cues[1].text !== 'deux') {
        throw new Error('The parts of a series are not joined into one 16:9 video');
      }

      // 4. Checks and publishing: a Short has no chapters but must last three minutes or less; it is published as a
      // Short, without a thumbnail.
      const operator = Object.create(OperatorService.prototype);
      operator.db = { getRow: async () => null, getAllRows: async () => [] };
      const production = duration => ({
        script: { title: 'Titre', fullScript: 'x'.repeat(300), cta: 'Abonne-toi à la chaîne.' },
        seo: { title: 'Titre', description: `${'Une description assez longue pour passer le contrôle. '.repeat(2)}\n\n🔔 Abonne-toi à la chaîne`, tags: ['a', 'b', 'c'] },
        assets: { finalVideo: { path: 'v.mp4', aspectRatio: '9:16', duration } },
        scenes: [{ label: 'Call to action', scriptText: 'Abonne-toi à la chaîne.', duration }]
      });
      const ok = await operator.runQualityChecks(production(95), {});
      const tooLong = await operator.runQualityChecks(production(200), {});
      const named = (result, id) => result.checks.find(check => check.id === id || check.name === id);
      if (!named(ok, 'short_duration')?.passed || named(ok, 'chapters_valid') || !named(ok, 'thumbnail')?.passed || named(tooLong, 'short_duration')?.passed ||
        !tooLong.blockingFailures.includes('short_duration')) {
        throw new Error('The quality checks of a Short are wrong');
      }
      const videoFile = path.join(directory, 'short.mp4');
      const audioFile = path.join(directory, 'narration.wav');
      await fs.writeFile(videoFile, 'mp4');
      await fs.writeFile(audioFile, 'wav');
      const publishing = Object.create(PublishingSchedulingAgent.prototype);
      Object.assign(publishing, { db, logger: { info() {}, warn() {}, error() {} }, publishQueue: [] });
      const entry = await publishing.scheduleContent({
        id: 'prod_short_x', script: { title: 'T' }, seo: { title: 'T' }, scheduledPublishTime: new Date().toISOString(), priority: 'high',
        assets: { finalVideo: { path: videoFile, aspectRatio: '9:16' }, audio: { path: audioFile }, thumbnail: { path: 'thumb.png' } }
      });
      if (entry.metadata.contentType !== 'short' || entry.metadata.thumbnail !== null || entry.metadata.shortClipId) {
        throw new Error('A standalone Short is not published as a Short');
      }

      // 5. The series: one part at a time, the next once the previous one is approved; the answer is published once all
      // parts are, and the parts are then joined; each Short also goes to the other platforms.
      const item = await db.createReactiveItem({ videoId: 'vid_series', channelId: `UC${'s'.repeat(22)}`, video: { title: 'Le moteur à eau', channel: 'Chaîne X', url: 'https://www.youtube.com/watch?v=vid_series' }, claim: 'Le moteur à eau', topic: 'Le moteur à eau fonctionne-t-il ?', passages, parts: 2 });
      const app = Object.create(YouTubeAutomationAgent.prototype);
      Object.assign(app, {
        db, logger: { info() {}, warn() {}, error() {} }, agents: { strategy: {} }, activeJobs: new Map(), reactive: { enabled: () => true, expire: async () => [] },
        operator: { notify: async () => null }, autonomous: { activeRuns: new Map() }
      });
      const started = [];
      app.startGenerationJob = async input => { started.push(input); return { id: `job_${started.length}` }; };
      const shared = [];
      app.shareShort = async published => shared.push(published.productionId);
      const compiledSeries = [];
      app.compileReactiveSeries = async id => compiledSeries.push(id);
      await app.runReactive();
      if (started[0]?.strategyContext.format !== 'short' || started[0].strategyContext.part !== 1 || started[0].strategyContext.parts !== 2) {
        throw new Error('The first part of a series did not start as a Short');
      }
      await app.trackSubject(started[0].strategyContext, 'covered', 'prod_part1');
      if ((await db.getReactiveItem(item.id)).status !== 'next_part' || (await db.findReactiveItem({ productionId: 'prod_part1' }))?.id !== item.id) {
        throw new Error('A finished part does not wait for the next one');
      }
      await app.runReactive();
      if (started.length !== 1) throw new Error('The next part started before the previous one was approved');
      const schedule = async (productionId, status) => db.saveScheduleEntry({
        productionId, title: productionId, publishTime: new Date().toISOString(), status, priority: 'high',
        metadata: { contentType: 'short', privacyStatus: 'public', video: { path: videoFile } }, createdAt: new Date().toISOString()
      });
      await schedule('prod_part1', 'scheduled');
      await app.runReactive();
      if (started[1]?.strategyContext.part !== 2 || (await db.getReactiveItem(item.id)).episodes.length !== 2) {
        throw new Error('The next part did not start once the previous one was approved');
      }
      await app.trackSubject(started[1].strategyContext, 'covered', 'prod_part2');
      const publish = async productionId => {
        const latest = await db.getLatestScheduleEntry(productionId) || await schedule(productionId, 'scheduled');
        await db.updateScheduleEntry({ ...latest, status: 'published', youtubeId: `yt_${productionId}`, youtubeUrl: `https://www.youtube.com/watch?v=yt_${productionId}`, publishedAt: new Date().toISOString() });
        await app.handlePublished(await db.getLatestScheduleEntry(productionId));
      };
      app.requestSiteUpdate = () => null;
      await publish('prod_part1');
      if ((await db.getReactiveItem(item.id)).status === 'published' || compiledSeries.length) throw new Error('The answer was published with a part missing');
      await publish('prod_part2');
      if ((await db.getReactiveItem(item.id)).status !== 'published' || compiledSeries.join() !== item.id || shared.join() !== 'prod_part1,prod_part2') {
        throw new Error('The series was not published, joined and shared once all its parts were out');
      }
      // A Short cut out of a video changes nothing.
      await app.handlePublished({ productionId: 'prod_part1', metadata: { contentType: 'short', shortClipId: 'clip_x' } });
      if (shared.length !== 2) throw new Error('A Short cut out of a video was shared as an answer');

      // 6. The public site: a standalone Short has its page; a Short cut out of a video and a joined series do not.
      const publishRow = async (id, metadata, strategyExtra = {}) => {
        await db.executeQuery('INSERT INTO productions (id, status) VALUES (?, ?)', [id, 'published']);
        await db.saveProductionSnapshot({ id, strategy: { topic: `Sujet ${id}`, ...strategyExtra }, script: { title: `Titre ${id}`, examinedClaim: { statement: 'x', verdict: 'wrong' } } });
        await db.executeQuery(
          'INSERT INTO publish_schedule (id, production_id, title, publish_time, status, metadata, youtube_id, youtube_url, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [`schedule_site_${id}`, id, id, '2026-10-01T10:00:00Z', 'published', JSON.stringify({ privacyStatus: 'public', ...metadata }), `yt_site_${id}`, `https://www.youtube.com/watch?v=yt_site_${id}`, '2026-10-01T10:00:00Z']
        );
      };
      await publishRow('prod_standalone', { contentType: 'short' });
      await publishRow('prod_clip_parent', { contentType: 'short', shortClipId: 'clip_1' });
      await publishRow('prod_series_x', { contentType: 'long_form' }, { seriesOf: ['prod_part1', 'prod_part2'] });
      const titles = (await buildSite(db)).videos.map(video => video.title);
      if (!titles.includes('Titre prod_standalone') || titles.includes('Titre prod_clip_parent') || titles.includes('Titre prod_series_x')) {
        throw new Error(`The public site does not list standalone Shorts only: ${titles.join(' | ')}`);
      }
    } finally {
      process.env.SITE_BASE_URL = savedSite;
      await new Promise(resolve => db.db.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async testAnalyticsWithoutImpressions() {
    const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    // The YouTube Analytics API rejects a whole query that asks for impressions or click-through rate (they only come in
    // the Reporting API): views are asked alone, and impressions and CTR are unknown, never zero.
    const agent = Object.create(AnalyticsOptimizationAgent.prototype);
    const queries = [];
    agent.youtubeAnalytics = { reports: { query: async params => {
      queries.push(params);
      if (/impressions/i.test(params.metrics)) throw new Error('Unknown identifier (impressions) given in field parameters.metrics.');
      return { data: { rows: [['2026-10-01', 30], ['2026-10-02', 19]] } };
    } } };
    const views = await agent.getViewsAnalytics('vid', '2026-09-20', '2026-10-02');
    const thumbnail = await agent.analyzeThumbnailPerformance('vid');
    if (queries[0].metrics !== 'views' || views.totalViews !== 49 || views.totalImpressions !== null || views.averageCTR !== null ||
      thumbnail.clickThroughRate !== null || queries.length !== 1) {
      throw new Error('Analytics still ask for metrics the API does not have, or report them as zero');
    }
    const score = agent.calculatePerformanceScore({
      views: { totalViews: 49, averageCTR: null }, watchTime: { averageViewPercentage: 40 }, engagement: { engagementRate: 2 }
    });
    if (!Number.isFinite(score.score) || score.breakdown.ctr !== 0) throw new Error('The performance score does not leave an unknown CTR out');

    // The learning loop: confidence from the views when impressions are unknown; a retention recommendation still comes
    // from videos seen enough, no CTR verdict without CTR.
    const learning = new ChannelLearningEngine({});
    const metrics = learning.normalizeMetrics({ analytics: { views: { totalViews: 400, totalImpressions: null, averageCTR: null }, watchTime: { averageViewPercentage: 20 } } });
    if (metrics.impressions !== null || metrics.ctr !== null || learning.confidenceFor(metrics) !== 'high' ||
      learning.confidenceFor({ views: 40, impressions: null }) !== 'medium' || learning.confidenceFor({ views: 5, impressions: null }) !== 'low') {
      throw new Error('Unknown impressions are not handled by the learning loop');
    }
    const recommendations = learning.buildChannelRecommendations([
      { metrics: { views: 120, impressions: null, ctr: null, retention: 20 } },
      { metrics: { views: 80, impressions: null, ctr: null, retention: 25 } }
    ]);
    if (!recommendations.some(item => item.category === 'retention') || recommendations.some(item => item.category === 'packaging')) {
      throw new Error('Channel recommendations without impressions are wrong');
    }
  }

  async testPersuasionMeasurement() {
    const fs = require('fs').promises;
    const os = require('os');
    const { AudienceEngagementService, persuasionOf } = require('./utils/audience-engagement-service');
    const { SceneRetentionEngine } = require('./utils/scene-retention-engine');
    const { ChannelLearningEngine } = require('./utils/channel-learning-engine');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-persuasion-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'persuasion.db');
    await db.initialize();
    try {
      // 1. Jev gives each comment its stance on the claim (replies with what they answer, the channel's own left out),
      // once; the video's persuasion summary follows.
      await db.executeQuery("INSERT INTO productions (id, status) VALUES ('prod_p', 'published')");
      await db.saveProductionSnapshot({ id: 'prod_p', strategy: { topic: 'Le moteur à eau' }, script: { examinedClaim: { statement: 'L\'eau suffit à faire rouler une voiture', verdict: 'wrong' } } });
      await db.saveEngagementInsight({ videoId: 'vid', productionId: 'prod_p', title: 'Le moteur à eau fonctionne-t-il ?' });
      const comments = [
        ['c1', 'Je n\'avais jamais vu ça comme ça, j\'ai changé d\'avis', 5], ['c2', 'Ce moteur ne ment pas, c\'est prouvé', 9],
        ['c3', 'Excellente vidéo, je le savais déjà', 2], ['c4', 'Quelle source pour la date ?', 1], ['c5', 'Bande d\'ignorants', 0],
        ['c6', 'Ça me fait réfléchir', 1, 'c2'], ['c7', 'Merci à tous', 0, null, true]
      ];
      for (const [commentId, text, likeCount, parentCommentId = null, owner = false] of comments) {
        await db.upsertAudienceComment({ commentId, videoId: 'vid', parentCommentId, authorName: 'x', isChannelOwner: owner, text, likeCount, publishedAt: '2026-10-01T10:00:00Z' });
      }
      const calls = [];
      const stanceOf = text => (/changé d'avis|réfléchir/.test(text) ? 'moved' : /ment pas/.test(text) ? 'holds' : /savais déjà/.test(text) ? 'agrees' : /source/.test(text) ? 'question' : 'hostile');
      const jev = { enabled: () => true, ask: async ({ purpose, state, questions }) => { calls.push({ purpose, state, questions }); return { stance: { type: 'choice', choice: stanceOf(state.comment), confidence: 0.8 } }; } };
      const service = new AudienceEngagementService(db, null, null, { jev });
      const persuasion = await service.classifyStances('vid', 'Le moteur à eau fonctionne-t-il ?');
      const reply = calls.find(call => call.state.comment === 'Ça me fait réfléchir');
      if (calls.length !== 6 || calls[0].purpose !== 'comment_stance' || calls[0].questions.stance.type !== 'choice' || calls[0].state.claimExamined !== 'L\'eau suffit à faire rouler une voiture' ||
        reply?.state.replyingTo !== 'Ce moteur ne ment pas, c\'est prouvé' || calls.some(call => call.state.comment === 'Merci à tous') ||
        persuasion.counts.moved !== 2 || persuasion.counts.holds !== 1 || persuasion.counts.agrees !== 1 || persuasion.goalRate !== 40 ||
        persuasion.reachRate !== 50 || persuasion.examples[0].commentId !== 'c1' || !persuasion.examples[0].permalink.endsWith('&lc=c1') || persuasion.goalLabel !== 'changed their mind' ||
        (await db.getEngagementInsight('vid')).persuasion.goalRate !== 40) {
        throw new Error(`Comment stances or the persuasion summary are wrong: ${JSON.stringify(persuasion)}`);
      }
      await service.classifyStances('vid');
      if (calls.length !== 6) throw new Error('Comments were classified twice');
      if (persuasionOf([], 'v').goalRate !== null) throw new Error('An empty persuasion summary must not claim a rate');

      // 2. The turn to the critique: where it starts on the measured timeline and how much of the audience stays.
      const script = {
        hook: { text: 'Accroche.' },
        mainContent: { sections: [
          { title: 'Le récit', register: 'opening', content: ['a'] }, { title: 'Les témoins', register: 'opening', content: ['b'] },
          { title: 'Sauf que', register: 'main', content: ['c'] }, { title: 'Le ciel', register: 'main', content: ['d'] }
        ] },
        callToAction: { subscribe: 'Abonne-toi.' }
      };
      const labels = ['Hook', 'Le récit', 'Les témoins', 'Sauf que', 'Le ciel', 'Call to action'];
      const timeline = labels.map((name, position) => ({ id: `s${position}`, position, label: name, startSeconds: position * 60, endSeconds: (position + 1) * 60 }));
      const points = Array.from({ length: 36 }, (_, index) => ({ elapsedRatio: (index + 1) / 36, audienceWatchRatio: index < 18 ? 0.6 : 0.45 }));
      const engine = new SceneRetentionEngine(db);
      const turn = engine.turnOf(points, timeline, script, 360);
      if (turn?.seconds !== 180 || turn.sceneLabel !== 'Sauf que' || turn.before !== 0.6 || turn.after !== 0.45 || turn.kept !== 75) {
        throw new Error(`The turn was not measured: ${JSON.stringify(turn)}`);
      }
      const reordered = timeline.map((scene, position) => ({ ...scene, label: labels[(position + 1) % labels.length] }));
      const allCritical = { ...script, mainContent: { sections: script.mainContent.sections.map(section => ({ ...section, register: 'main' })) } };
      if (engine.turnOf(points, reordered, script, 360) !== null || engine.turnOf(points, timeline, allCritical, 360) !== null) {
        throw new Error('A turn was claimed for reordered scenes or a video without an opening part');
      }

      // 3. The learning loop: the goal stance rate and the audience kept after the turn join the metrics, origin and technique the
      // attributes; persuasion can be the channel's goal and gets its own recommendations.
      const learning = new ChannelLearningEngine(db);
      const metrics = learning.normalizeMetrics({ analytics: {} }, { persuasion: { goalRate: 12.5, turnKept: 80 } });
      const attributes = learning.extractAttributes({}, { strategy: { origin: 'gap', technique: 'counting' } });
      if (metrics.goalRate !== 12.5 || metrics.turnKept !== 80 || learning.normalizeMetrics({ analytics: {} }, {}).goalRate !== null ||
        attributes.origin !== 'gap' || attributes.technique !== 'counting' || learning.outcomeGoal({ primary_kpi: 'persuasion' }).metric !== 'goalRate') {
        throw new Error('Persuasion does not reach the learning loop');
      }
      const snapshot = (format, origin, goalRate) => ({ contentAttributes: { format, origin }, metrics: { goalRate, performanceScore: 50, retention: 40, ctr: 4 } });
      const recommendations = learning.buildDimensionRecommendations([
        snapshot('lesson', 'lesson', 20), snapshot('lesson', 'lesson', 16), snapshot('explainer', 'planned', 4), snapshot('explainer', 'planned', 6)
      ]);
      const persuasive = recommendations.find(item => item.category === 'persuasion' && item.evidence.dimension === 'format');
      if (!persuasive || persuasive.proposedChange.prefer !== 'lesson' || !/comments in the goal stance/.test(persuasive.rationale)) {
        throw new Error('No persuasion recommendation was derived from the goal stance rates');
      }
    } finally {
      await new Promise(resolve => db.db.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async testReactions() {
    const fs = require('fs').promises;
    const os = require('os');
    const { WatchList } = require('./utils/watch-list');
    const { ChannelDiscovery } = require('./utils/channel-discovery');
    const { OperatorService } = require('./utils/operator-service');
    const { buildSite } = require('./utils/claims-site');
    const { ScriptWriterAgent } = require('./agents/script-writer-agent');
    const { YouTubeAutomationAgent } = require('./index');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-hot-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'hot.db');
    await db.initialize();
    const saved = { max: process.env.WATCH_MAX_CHANNELS, site: process.env.SITE_BASE_URL };
    process.env.WATCH_MAX_CHANNELS = '3';
    try {
      // 1. The watch list: at most WATCH_MAX_CHANNELS; when full, a newcomer replaces the automatic channel the audience
      // reacted to least (lowest goal stance rate in the comments of the answers to it), never one in its grace period, never
      // one added by hand; a channel added by hand may also replace one in its grace period.
      const list = new WatchList(db);
      const add = async (channelId, origin = 'discovery') => {
        await db.upsertWatchedChannel({ channelId, title: channelId, origin });
        return list.admit(channelId, { manual: origin === 'manual' });
      };
      await add('UCmanual', 'manual');
      await add('UCstrong');
      await add('UCweak');
      await db.executeQuery("UPDATE watched_channels SET activated_at = datetime('now', '-30 days') WHERE channel_id IN ('UCstrong', 'UCweak')");
      const answer = async (id, channelId, youtubeId, goalRate) => {
        await db.createReactiveItem({ videoId: `src_${id}`, channelId, video: {}, claim: 'c', topic: 't' });
        const [item] = await db.getAllRows('SELECT id FROM reactive_items WHERE video_id = ?', [`src_${id}`]);
        await db.updateReactiveItem(item.id, { status: 'published', productionId: `prod_${id}` });
        await db.executeQuery("INSERT INTO publish_schedule (id, production_id, title, publish_time, status, youtube_id) VALUES (?, ?, 't', '2026-10-01', 'published', ?)", [`sch_${id}`, `prod_${id}`, youtubeId]);
        await db.saveEngagementInsight({ videoId: youtubeId, persuasion: { goalRate } });
      };
      await answer('a', 'UCstrong', 'yt_a', 30);
      await answer('b', 'UCstrong', 'yt_b', 20);
      await answer('c', 'UCweak', 'yt_c', 5);
      await list.refreshScores();
      const strong = await db.getWatchedChannel('UCstrong');
      if (strong.score !== 25 || strong.responses !== 2 || (await db.getWatchedChannel('UCweak')).score !== 5) throw new Error('Watch list scores are wrong');
      const replaced = await add('UCnew');
      if (!replaced.admitted || replaced.evicted?.channelId !== 'UCweak' || (await db.getWatchedChannel('UCweak')).active ||
        !(await db.getWatchedChannel('UCweak')).deactivatedReason.includes('UCnew') || (await db.listWatchedChannels()).length !== 3) {
        throw new Error('A newcomer did not replace the lowest-scored channel');
      }
      const next = await add('UCother');
      if (next.evicted?.channelId !== 'UCstrong') throw new Error('A newcomer did not replace the only channel past its grace period');
      const refused = await add('UCthird');
      if (refused.admitted || (await db.getWatchedChannel('UCthird')).active) throw new Error('A newcomer replaced a channel in its grace period or one added by hand');
      const byHand = await add('UChand', 'manual');
      if (!byHand.admitted || !['UCnew', 'UCother'].includes(byHand.evicted?.channelId) || !(await db.getWatchedChannel('UCmanual')).active) {
        throw new Error('A channel added by hand could not take a place, or pushed out another one added by hand');
      }

      // 2. Discovery: Claude searches the web (its own tools), each channel is resolved without spending a search, Jev
      // confirms from its latest titles, and the watch list decides; categories and reasons stay internal.
      process.env.WATCH_MAX_CHANNELS = '10';
      const prompts = [];
      const discovery = new ChannelDiscovery(db, {
        watchList: list,
        claudeEnabled: () => true,
        runClaudeCode: async ({ prompt, tools, purpose }) => {
          prompts.push({ prompt, tools, purpose });
          return JSON.stringify([
            { name: 'Astuces du jardin', url: 'https://www.youtube.com/@astuces', category: 'test-category', reason: 'Article de presse sur ses astuces' },
            { name: 'Chaîne directe', url: `https://www.youtube.com/channel/UC${'d'.repeat(22)}`, category: 'test-category', reason: 'Fact-check' },
            { name: 'Cuisine', url: `https://www.youtube.com/channel/UC${'k'.repeat(22)}`, category: 'test-category', reason: 'x' },
            { name: 'Introuvable', url: 'https://example.org/page', category: 'test-category', reason: 'x' },
            { name: 'Hors catégorie', url: 'https://www.youtube.com/@autre', category: 'politique', reason: 'x' }
          ]);
        },
        youtube: { channels: { list: async ({ forHandle, id }) => ({ data: { items: forHandle === '@astuces'
          ? [{ id: `UC${'r'.repeat(22)}`, snippet: { title: 'Astuces du jardin', description: 'Des astuces pour le jardin' } }]
          : id ? [{ id: id[0], snippet: { title: id[0], description: '' } }] : [] } }) } },
        // A neutral title, a telling description: Jev reads both, and the channel's own description.
        http: { get: async url => ({ data: `<feed><entry><yt:videoId>v1</yt:videoId><title>${url.includes('k'.repeat(22)) ? 'Recette du gâteau' : 'Mon expérience'}</title><media:group><media:description>${url.includes('k'.repeat(22)) ? 'Un gâteau au chocolat' : 'Ce remède guérit tout, la preuve'}</media:description></media:group><published>2026-10-19T10:00:00Z</published></entry></feed>` }) },
        jev: { enabled: () => true, ask: async ({ state }) => ({ promotes: { type: 'noul', noul: /guérit/.test(state.latestVideos.map(video => `${video.title} ${video.description}`).join(' ')) && 'channelDescription' in state ? 0.9 : 0.2 } }) }
      });
      const found = await discovery.run();
      const remedies = await db.getWatchedChannel(`UC${'r'.repeat(22)}`);
      if (prompts[0].purpose !== 'channel_discovery' || prompts[0].tools.join() !== 'WebSearch,WebFetch' || !/never for the religion, origin or community/.test(prompts[0].prompt) ||
        found.admitted.length !== 2 || !remedies?.active || remedies.category !== 'test-category' || remedies.origin !== 'discovery' ||
        !found.skipped.some(item => item.name === 'Cuisine' && /Jev/.test(item.why)) || !found.skipped.some(item => item.name === 'Introuvable')) {
        throw new Error(`Channel discovery did not resolve, confirm and admit as expected: ${JSON.stringify(found)}`);
      }

      // 3. The tone guard: an answer naming a video must not attack its author or a community; Jev reads every spoken
      // sentence and a single attack blocks approval.
      const script = {
        hook: { text: 'Dans la vidéo « Le moteur à eau », on entend que l\'eau suffit à faire rouler une voiture.' },
        mainContent: { sections: [{ title: 'Sauf que', register: 'main', content: ['Le moteur tourne à l\'eau, selon la vidéo. Ce menteur trompe ses abonnés.'] }] },
        callToAction: { subscribe: 'Abonne-toi pour la suite.' }
      };
      const toneCalls = [];
      const operator = new OperatorService(db, { jev: { enabled: () => true, ask: async ({ purpose, state }) => { toneCalls.push(purpose); return { attack: { type: 'noul', noul: /menteur/.test(state.sentence) ? 0.95 : 0.05 } }; } } });
      const blocked = await operator.runQualityChecks({ strategy: { origin: 'reactive' }, script });
      const tone = blocked.checks.find(check => check.id === 'respectful_tone');
      const regular = await operator.runQualityChecks({ strategy: { origin: 'planned' }, script });
      if (!tone || tone.passed || !tone.blocking || !tone.message.includes('Ce menteur trompe ses abonnés.') || tone.message.includes('bétail') ||
        !blocked.blockingFailures.includes('respectful_tone') || toneCalls[0] !== 'tone_guard' || regular.checks.some(check => check.id === 'respectful_tone')) {
        throw new Error('The tone guard did not block an attack on a person');
      }

      // Jev approves a reaction in place of the operator when every quoted passage is represented faithfully;
      // one doubtful quotation, no passage, or REACTIVE_APPROVAL=human leaves it to the operator.
      const examinedForApproval = { passages: [{ text: 'L\'eau suffit à faire rouler une voiture' }, { text: 'Un laboratoire l\'a confirmé' }] };
      const approvalCalls = [];
      const approver = new OperatorService(db, { jev: { enabled: () => true, ask: async ({ purpose, state }) => {
        approvalCalls.push({ purpose, state });
        return { faithful: { type: 'noul', noul: /laboratoire/.test(state.quotedPassage) ? fidelityOfLab : 0.93 } };
      } } });
      let fidelityOfLab = 0.9;
      const approvedByJev = await approver.reactiveApproval({ strategy: { examinedVideo: examinedForApproval }, script });
      fidelityOfLab = 0.4;
      const doubtful = await approver.reactiveApproval({ strategy: { examinedVideo: examinedForApproval }, script });
      const noPassage = await approver.reactiveApproval({ strategy: { examinedVideo: { passages: [] } }, script });
      process.env.REACTIVE_APPROVAL = 'human';
      const human = await approver.reactiveApproval({ strategy: { examinedVideo: examinedForApproval }, script });
      delete process.env.REACTIVE_APPROVAL;
      if (!approvedByJev.approved || approvedByJev.fidelity.length !== 2 || approvalCalls[0].purpose !== 'jev_approval' || !approvalCalls[0].state.answer.includes('Le moteur tourne') ||
        doubtful.approved || !doubtful.reasons[0].includes('Un laboratoire') || noPassage.approved || human !== null) {
        throw new Error('Jev approval of reactions is wrong');
      }

      // 4. The examined video is named and quoted in the script, linked in the description and shown on the site.
      const sourceChannel = `UC${'x'.repeat(22)}`;
      const examinedVideo = { title: 'Le moteur à eau', channel: 'Chaîne X', channelId: sourceChannel, url: 'https://www.youtube.com/watch?v=src', passages: [{ text: 'L\'eau suffit à faire rouler une voiture', timestamp: '1:04' }] };
      const block = Object.create(ScriptWriterAgent.prototype).examinedVideoBlock({ origin: 'reactive', examinedVideo });
      if (!block.includes('« Le moteur à eau » from the channel « Chaîne X »') || !block.includes('1. [1:04] « L\'eau suffit à faire rouler une voiture »') ||
        !/never its author/.test(block) || !/do not list them in claims/.test(block)) {
        throw new Error('The script is not told to name and quote the examined video, and to spare its author');
      }
      await db.executeQuery("INSERT INTO productions (id, status) VALUES ('prod_hot', 'published')");
      await db.saveProductionSnapshot({ id: 'prod_hot', strategy: { topic: 'Le moteur à eau', origin: 'reactive', examinedVideo }, script: { title: 'Le moteur à eau fonctionne-t-il ?', examinedClaim: { statement: 'L\'eau suffit à faire rouler une voiture', verdict: 'wrong', techniques: [] } } });
      await db.upsertWatchedChannel({ channelId: sourceChannel, title: 'Chaîne X', origin: 'discovery', category: 'test-category', reason: 'RAISON INTERNE', subscribers: 689000 });
      await db.setWatchedChannelScore(sourceChannel, 12.5, 1);
      const app = new YouTubeAutomationAgent();
      app.db = db;
      app.youtubeChannelId = async () => 'UC1';
      app.buildDescriptionExtras = async () => '';
      const description = await app.composeDescription('prod_hot', 'Résumé.', [], {});
      if (!description.endsWith('📌 Vidéo examinée : « Le moteur à eau » (Chaîne X) : https://www.youtube.com/watch?v=src') ||
        await app.composeDescription('prod_hot', description, [], {}) !== description) {
        throw new Error(`The description does not link the examined video once: ${description}`);
      }
      await db.executeQuery(
        "INSERT INTO publish_schedule (id, production_id, title, publish_time, status, metadata, youtube_id, youtube_url, published_at) VALUES ('sch_hot', 'prod_hot', 't', '2026-10-01', 'published', ?, 'yt_hot', 'https://www.youtube.com/watch?v=yt_hot', '2026-10-01')",
        [JSON.stringify({ contentType: 'long_form', privacyStatus: 'public', seo: { title: 'Le moteur à eau fonctionne-t-il ?' } })]
      );
      process.env.SITE_BASE_URL = 'https://example.github.io/verifications';
      const { files } = await buildSite(db);
      const page = Object.entries(files).find(([name]) => name.startsWith('v/le-moteur'))?.[1] || '';
      if (!page.includes('Vidéo examinée') || !page.includes('href="https://www.youtube.com/watch?v=src&amp;t=64s"') || !page.includes('« L&#39;eau suffit à faire rouler une voiture »') ||
        page.includes('test-category') || page.includes('Article de presse')) {
        throw new Error('The site page does not show the examined video, or shows the internal watch list');
      }
      // The channels answered, each with its answers and verdicts and its public subscriber count; nothing of the
      // internal watch list, and no channel never answered.
      const channelIndex = files['chaines/index.html'] || '';
      const channelPage = Object.entries(files).find(([name]) => /^chaines\/chaine-x-[0-9a-f]{4}\/index\.html$/.test(name))?.[1] || '';
      const publicFiles = Object.values(files).join('\n');
      if (!channelIndex.includes('Chaîne X') || !channelIndex.includes('1 vidéo examinée') || !channelIndex.includes('1 faux') ||
        !channelIndex.includes((689000).toLocaleString('fr-FR')) || !channelPage.includes(`https://www.youtube.com/channel/${sourceChannel}`) ||
        !channelPage.includes('Le moteur à eau fonctionne-t-il ?') || !channelPage.includes('<span class="badge">Faux</span>') ||
        !page.includes('../../chaines/chaine-x-') || /RAISON INTERNE|test-category|12\.5|UCmanual|Astuces du jardin/.test(publicFiles) ||
        JSON.parse(files['data/claims.json']).channels[0].subscribers !== 689000) {
        throw new Error('The examined channels pages are wrong, or show the internal watch list');
      }
    } finally {
      for (const [key, name] of [['max', 'WATCH_MAX_CHANNELS'], ['site', 'SITE_BASE_URL']]) {
        if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
      }
      await new Promise(resolve => db.db.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async testReactiveWatch() {
    const fs = require('fs').promises;
    const os = require('os');
    const axios = require('axios');
    const { ReactiveWatch, parseFeed } = require('./utils/reactive-watch');
    const { YouTubeAutomationAgent } = require('./index');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-reactive-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'reactive.db');
    await db.initialize();
    const { WatchList } = require('./utils/watch-list');
    const saved = { max: process.env.REACTIVE_DAILY_MAX, weekly: process.env.REACTIVE_PER_CHANNEL_WEEKLY, mention: process.env.EXPERT_REVIEW_MENTION, hook: process.env.EXPERT_REVIEW_WEBHOOK_URL, post: axios.post };
    process.env.REACTIVE_DAILY_MAX = '1';
    delete process.env.REACTIVE_PER_CHANNEL_WEEKLY;
    try {
      // 1. A channel's public feed gives its videos, entities decoded.
      const now = Date.parse('2026-10-01T12:00:00Z');
      const entry = (id, title, hoursAgo) => `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>UCpro</yt:channelId><title>${title}</title><published>${new Date(now - hoursAgo * 3600000).toISOString()}</published></entry>`;
      const feed = `<feed>${entry('fast', 'Le moteur à eau &amp; la science : prouvé enfin', 10)}${entry('second', 'Un autre moteur prouvé par la science', 5)}${entry('chat', 'Discussion du soir avec la communauté', 10)}${entry('old', 'Ancienne vidéo sur le moteur prouvé', 100)}${entry('english', 'Water engine in English proven by science', 10)}</feed>`;
      const parsed = parseFeed(feed);
      if (parsed.length !== 5 || parsed[0].title !== 'Le moteur à eau & la science : prouvé enfin' || parsed[0].channelId !== 'UCpro') throw new Error('A channel feed was not parsed');

      // 2. The watch: every new video of a watched channel is looked at, whatever its audience; Jev decides whether
      // it defends a claim, which sentences are the verifiable claims to quote, the technique and the stakes; within the
      // daily maximum, the others are set aside once and never looked at again.
      await db.upsertWatchedChannel({ channelId: 'UCcandidate', title: 'Candidate' });
      await db.upsertWatchedChannel({ channelId: 'UCpro', title: 'Inventeur', origin: 'manual' });
      await new WatchList(db).admit('UCpro', { manual: true });
      const fetched = [];
      const views = { fast: 20, second: 4, chat: 50000, english: 90000 };
      const descriptions = { fast: 'Un laboratoire a prouvé ce moteur en 1969 avec ses essais. Abonnez-vous !' };
      const youtube = { videos: { list: async ({ id }) => ({ data: { items: id.map(videoId => ({
        id: videoId, statistics: { viewCount: String(views[videoId] || 0) },
        snippet: { description: descriptions[videoId] || 'Description courte', ...(videoId === 'english' ? { defaultAudioLanguage: 'en' } : {}) }
      })) } }) } };
      const jevCalls = [];
      const jev = {
        enabled: () => true,
        ask: async ({ purpose, state, questions }) => {
          jevCalls.push({ purpose, state, questions });
          if (purpose === 'reactive_stance') return { defends: { type: 'noul', noul: /Discussion/.test(state.video.title) ? 0.2 : 0.95 } };
          if (purpose === 'hot_passage') return { claim: { type: 'noul', noul: /prouvé|laboratoire/.test(state.sentence) ? 0.9 : 0.1 } };
          return { technique: { type: 'choice', choice: 'borrowed-authority', confidence: 0.8 }, stakes: { type: 'score', score: 2, confidence: 0.7 } };
        }
      };
      const ai = {
        isAvailable: () => true, lightModel: () => 'sonnet',
        generateText: async (prompt, options) => {
          if (options.purpose !== 'reactive_claim' || !prompt.includes('Un laboratoire a prouvé ce moteur')) throw new Error('unexpected call');
          return JSON.stringify({ defends: true, claim: 'Le moteur à eau est prouvé par la science', topic: 'Ce moteur à eau est-il vraiment prouvé ?', covered: false });
        }
      };
      const watch = new ReactiveWatch(db, { youtube, aiText: ai, jev, now: () => now, http: { get: async url => { fetched.push(url); return { data: feed }; } } });
      const { created } = await watch.poll({ contentPillars: ['Énergie'] });
      const all = await db.listReactiveItems();
      if (fetched.length !== 1 || !fetched[0].endsWith('channel_id=UCpro') || created.length !== 1 || created[0].videoId !== 'fast' ||
        created[0].claim !== 'Le moteur à eau est prouvé par la science' || created[0].status !== 'queued' ||
        JSON.stringify(created[0].passages.map(passage => passage.text)) !== JSON.stringify(['Le moteur à eau & la science : prouvé enfin', 'Un laboratoire a prouvé ce moteur en 1969 avec ses essais.']) ||
        created[0].technique !== 'borrowed-authority' || created[0].priority !== 2 ||
        all.find(item => item.videoId === 'chat')?.status !== 'dismissed' || all.some(item => ['old', 'english', 'second'].includes(item.videoId)) ||
        !['reactive_stance', 'hot_passage', 'hot_judge'].every(purpose => jevCalls.some(call => call.purpose === purpose)) ||
        jevCalls.find(call => call.purpose === 'hot_judge').questions.technique.type !== 'choice') {
        throw new Error(`A new video was not queued as expected: ${JSON.stringify(all.map(item => [item.videoId, item.status, item.passages]))}`);
      }

      // At most REACTIVE_PER_CHANNEL_WEEKLY answers to one channel a week, even with room left today.
      process.env.REACTIVE_DAILY_MAX = '5';
      process.env.REACTIVE_PER_CHANNEL_WEEKLY = '1';
      jevCalls.length = 0;
      const again = await watch.poll({ contentPillars: ['Énergie'] });
      const capped = (await db.listReactiveItems()).find(item => item.videoId === 'second');
      if (again.created.length !== 0 || capped?.status !== 'dismissed' || !/cette semaine/.test(capped.error) ||
        jevCalls.some(call => /Discussion|enfin/.test(call.state.video?.title || ''))) {
        throw new Error('The per-channel weekly cap was exceeded, or a video already looked at was looked at again');
      }

      // A transcript pasted before production gives the passages to quote, with their timestamps.
      const withTranscript = await watch.setTranscript(created[0].id, '0:00\nBonjour à tous\n0:04\nUn laboratoire a prouvé ce moteur\n0:09\net voilà\n0:15\nabonnez-vous bien');
      if (withTranscript.passages.length !== 1 || withTranscript.passages[0].timestamp !== '0:00' || !withTranscript.passages[0].text.includes('Un laboratoire a prouvé ce moteur')) {
        throw new Error(`A pasted transcript did not give timestamped passages: ${JSON.stringify(withTranscript.passages)}`);
      }
      await db.updateReactiveItem(created[0].id, { status: 'generating' });
      try {
        await watch.setTranscript(created[0].id, '0:00\nUn laboratoire a prouvé ce moteur');
        throw new Error('late transcript accepted');
      } catch (error) {
        if (!/before production/.test(error.message)) throw new Error('A transcript was accepted after production started');
      }
      await db.updateReactiveItem(created[0].id, { status: 'queued' });
      process.env.REACTIVE_DAILY_MAX = '1';

      // A failing public feed (YouTube answers many with 404) is replaced by the channel's uploads playlist through the
      // Data API, at most once every 15 minutes per channel; a channel added by hand needs less of Jev's certainty.
      const { minStanceFor } = require('./utils/reactive-watch');
      const apiReads = [];
      let clock = now;
      const blindFeed = new ReactiveWatch(db, {
        now: () => clock,
        http: { get: async () => { throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404 } }); } },
        youtube: { playlistItems: { list: async params => {
          apiReads.push(params.playlistId);
          return { data: { items: [{ contentDetails: { videoId: 'viaApi', videoPublishedAt: new Date(now - 3600000).toISOString() }, snippet: { title: 'Vidéo lue par l\'API', description: 'Desc' } }] } };
        } } }
      });
      const viaApi = await blindFeed.freshVideos();
      clock = now + 5 * 60000;
      const throttled = await blindFeed.freshVideos();
      clock = now + 16 * 60000;
      await blindFeed.freshVideos();
      if (viaApi.length !== 1 || viaApi[0].videoId !== 'viaApi' || viaApi[0].watchedOrigin !== 'manual' || apiReads[0] !== 'UUpro' ||
        throttled.length !== 0 || apiReads.length !== 2 || minStanceFor('manual') !== 0.5 || minStanceFor('discovery') !== 0.7) {
        throw new Error(`The Data API did not stand in for a failing feed as expected: ${JSON.stringify({ viaApi, apiReads })}`);
      }

      // 3. A reactive item still waiting 72 hours later expires.
      const later = new ReactiveWatch(db, { now: () => Date.now() + 4 * 86400000 });
      if ((await later.expire()).length !== 1 || (await db.getReactiveItem(created[0].id)).status !== 'expired') throw new Error('A stale reactive item did not expire');
      await db.updateReactiveItem(created[0].id, { status: 'queued' });

      // 4. The generation slot: taken before the first await, given to the reactive item before the operator, which
      // yields while one waits.
      const app = Object.create(YouTubeAutomationAgent.prototype);
      app.db = db;
      app.logger = { info() {}, warn() {}, error() {} };
      app.agents = { strategy: {} };
      app.activeJobs = new Map();
      app.reactive = watch;
      app.operator = { notify: async () => null };
      app.autonomous = { activeRuns: new Map(), start: async () => ({ id: 'run' }) };
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const createJob = db.createGenerationJob.bind(db);
      db.createGenerationJob = async input => { await gate; return createJob(input); };
      app.runGenerationJob = async () => null;
      const first = app.startGenerationJob({ topic: 'A', source: 'manual' });
      let raced = null;
      try { await app.startGenerationJob({ topic: 'B', source: 'manual' }); } catch (error) { raced = error; }
      release();
      await first;
      db.createGenerationJob = createJob;
      if (raced?.status !== 429) throw new Error('Two generation jobs could start in the same slot');
      if (await app.startAutonomousRun() !== null) throw new Error('The operator started while a reactive video was waiting');
      app.activeJobs.clear();
      const started = [];
      app.startGenerationJob = async input => { started.push(input); return { id: 'job_reactive' }; };
      await app.runReactive();
      const generating = await db.getReactiveItem(created[0].id);
      if (started.length !== 1 || started[0].source !== 'reactive' || started[0].length !== 'short' || started[0].strategyContext.origin !== 'reactive' ||
        started[0].strategyContext.reactiveId !== created[0].id || started[0].strategyContext.claim !== created[0].claim ||
        generating.status !== 'generating' || generating.jobId !== 'job_reactive') {
        throw new Error('The queued reactive item did not get the next generation slot');
      }
      // A video already started is never lost: an interrupted job is resumed, one at a time when the slot is free, except
      // a reactive one (runReactive's) or one already resumed three times.
      const interrupted = async (source, resumeCount = 0) => {
        const job = await db.createGenerationJob({ topic: `Interrompu ${source} ${resumeCount}`, source });
        await db.updateGenerationJob(job.id, { status: 'interrupted', details: { resumeCount } });
        return job.id;
      };
      const tooMany = await interrupted('autonomous_operator', 3);
      await interrupted('reactive');
      const toResume = await interrupted('autonomous_operator');
      const resumed = [];
      app.resumeGenerationJob = async id => { resumed.push(id); return { id }; };
      app.activeJobs.set('busy', Promise.resolve());
      const whileBusy = await app.resumeInterruptedJobs();
      app.activeJobs.clear();
      await app.resumeInterruptedJobs();
      if (whileBusy !== null || resumed.length !== 1 || resumed[0] !== toResume || resumed.includes(tooMany)) {
        throw new Error(`Interrupted jobs were not resumed as expected: ${JSON.stringify(resumed)}`);
      }
      await app.trackSubject({ reactiveId: created[0].id }, 'covered', 'prod_reactive');
      if ((await db.getReactiveItem(created[0].id)).status !== 'review') throw new Error('A finished reactive video does not wait for review');

      // 5. A reactive video always waits for the operator, who gets the claim and the commands; nothing is scheduled.
      process.env.EXPERT_REVIEW_WEBHOOK_URL = 'https://hooks.example.test/reactive';
      process.env.EXPERT_REVIEW_MENTION = '<@352176756922253321>';
      const posts = [];
      axios.post = async (url, body) => { posts.push({ url, body }); return { status: 204 }; };
      const strategy = { origin: 'reactive', reactiveId: created[0].id, examinedClaimHint: created[0].claim };
      await app.alertReactive(strategy, { title: 'Ce moteur à eau est-il vraiment prouvé ?' }, 'prod_reactive', { passed: true, blockingFailures: [] });
      const alert = posts[0]?.body?.content || '';
      if (posts.length !== 1 || !alert.startsWith('## ⚡ Réponse prête à valider') || !alert.includes('<@352176756922253321>') ||
        !alert.includes('Le moteur à eau est prouvé par la science') || !alert.includes('npm run reactive -- approve prod_reactive') ||
        !alert.includes('20') || posts[0].body.allowed_mentions.users[0] !== '352176756922253321') {
        throw new Error(`The reactive alert is incomplete: ${alert}`);
      }
      // Approved by Jev, it is published without the operator, who is told so, with the errata command instead.
      await app.alertReactive(strategy, { title: 'Ce moteur à eau est-il vraiment prouvé ?' }, 'prod_reactive', { passed: true, blockingFailures: [] },
        { approved: true, fidelity: [{ passage: 'a', probability: 0.91 }, { passage: 'b', probability: 0.86 }], reasons: [] });
      const published = posts[1]?.body || {};
      if (!published.content?.startsWith('## ⚡ Réponse publiée automatiquement') || !published.content.includes('min 0.86') ||
        published.content.includes('reactive -- approve') || !published.content.includes('npm run errata') || published.event !== 'reactive_auto_approved') {
        throw new Error(`The alert of a reaction approved by Jev is wrong: ${published.content}`);
      }
    } finally {
      for (const [key, name] of [['max', 'REACTIVE_DAILY_MAX'], ['weekly', 'REACTIVE_PER_CHANNEL_WEEKLY'], ['mention', 'EXPERT_REVIEW_MENTION'], ['hook', 'EXPERT_REVIEW_WEBHOOK_URL']]) {
        if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
      }
      axios.post = saved.post;
      await new Promise(resolve => db.db.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async testTopicGapFinder() {
    const fs = require('fs').promises;
    const os = require('os');
    const { TopicGapFinder, gapScore } = require('./utils/topic-gap-finder');
    const { YouTubeSearchBudget } = require('./utils/youtube-search-budget');
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const { YouTubeAutomationAgent } = require('./index');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-gaps-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'gaps.db');
    await db.initialize();
    const saved = { daily: process.env.YOUTUBE_SEARCH_DAILY, watch: process.env.GAP_WATCH_MIN_VIEWS };
    process.env.YOUTUBE_SEARCH_DAILY = '2';
    process.env.GAP_WATCH_MIN_VIEWS = '100000';
    try {
      // 1. The daily search budget counts every call and stops at the limit, or for the day on quotaExceeded.
      const searches = [];
      const youtube = {
        search: { list: async params => { searches.push(params); return { data: { items: [{ id: { videoId: 'pro1' } }, { id: { videoId: 'pro2' } }, { id: { videoId: 'contra' } }, { id: { videoId: 'hors' } }] } }; } },
        videos: { list: async () => ({ data: { items: [
          { id: 'pro1', snippet: { title: 'Le moteur prouvé', channelId: 'UCpro', channelTitle: 'Inventeur', description: 'Preuve' }, statistics: { viewCount: '900000' } },
          { id: 'pro2', snippet: { title: 'Le moteur encore', channelId: 'UCpro', channelTitle: 'Inventeur', description: '' }, statistics: { viewCount: '100000' } },
          { id: 'contra', snippet: { title: 'Le moteur réfuté', channelId: 'UCskeptic', channelTitle: 'Sceptique', description: '' }, statistics: { viewCount: '20000' } },
          { id: 'hors', snippet: { title: 'Recette de cuisine', channelId: 'UCx', channelTitle: 'Cuisine', description: '' }, statistics: { viewCount: '5000000' } },
          { id: 'english', snippet: { title: 'The engine proven', channelId: 'UCen', channelTitle: 'English inventor', description: '', defaultAudioLanguage: 'en-US' }, statistics: { viewCount: '9000000' } }
        ] } }) }
      };
      const budget = new YouTubeSearchBudget(db);
      await budget.search(youtube, { q: 'a' });
      await budget.search(youtube, { q: 'b' });
      try {
        await budget.search(youtube, { q: 'c' });
        throw new Error('budget exceeded');
      } catch (error) {
        if (error.code !== 'SEARCH_BUDGET' || searches.length !== 2) throw new Error('The YouTube search budget was not enforced');
      }
      const tomorrow = new YouTubeSearchBudget(db, { now: () => new Date(Date.now() + 86400000) });
      const quota = Object.assign(new Error('quota'), { errors: [{ reason: 'quotaExceeded' }] });
      try {
        await tomorrow.search({ search: { list: async () => { throw quota; } } }, { q: 'd' });
      } catch (error) {
        if (error.code !== 'SEARCH_BUDGET' || await tomorrow.remaining() !== 0) throw new Error('quotaExceeded did not stop searching for the day');
      }

      // 2. A gap: Claude proposes claims (minus what the channel covered), the comments add theirs, Jev reads each video;
      // demand counts the views defending the claim, supply those refuting it; big defending channels get watched.
      process.env.YOUTUBE_SEARCH_DAILY = '10';
      await db.executeQuery("INSERT INTO content_strategies (id, topic, angle, target_audience, content_type, keywords) VALUES ('s1', 'Déjà traité', '', '', 'Explainer', '[]')");
      const jevCalls = [];
      const jev = {
        enabled: () => true,
        ask: async ({ purpose, state, questions }) => {
          jevCalls.push({ purpose, state, questions });
          const title = state.video.title;
          return { stance: { type: 'choice', choice: /réfuté/.test(title) ? 'answers' : /Recette/.test(title) ? 'unrelated' : 'defends', confidence: 0.9 } };
        }
      };
      const ai = {
        isAvailable: () => true,
        lightModel: () => 'sonnet',
        generateText: async (prompt, options) => {
          if (options.purpose === 'gap_candidates') return JSON.stringify([
            { claim: 'Déjà traité', query: 'deja', pillar: '' },
            { claim: 'La Lune fait pousser les cheveux', query: 'lune pousse cheveux', pillar: 'Astronomie' }
          ]);
          return JSON.stringify(['defends', 'defends', 'answers', 'unrelated']);
        }
      };
      const finder = new TopicGapFinder(db, { youtube, aiText: ai, jev, budget: new YouTubeSearchBudget(db, { now: () => new Date(Date.now() + 2 * 86400000) }) });
      const { gaps } = await finder.refresh({ contentPillars: ['Astronomie'], objective: 'Examiner' }, { limit: 5 });
      const [gap] = gaps;
      if (gaps.length !== 1 || gap.claim !== 'La Lune fait pousser les cheveux' || gap.demandViews !== 1000000 || gap.supplyViews !== 20000 ||
        gap.defendCount !== 2 || gap.answerCount !== 1 || gap.score !== gapScore(1000000, 20000) || gap.topVideos[0].id !== 'pro1' || gap.pillar !== 'Astronomie' ||
        jevCalls.length !== 4 || jevCalls[0].purpose !== 'gap_stance' || jevCalls[0].questions.stance.type !== 'choice' || searches.at(-1).relevanceLanguage !== 'fr') {
        throw new Error(`A topic gap was not measured as expected: ${JSON.stringify(gap)}`);
      }
      // One claim makes a channel a candidate; a second claim it defends makes it watched; one added by hand is watched.
      const candidates = await db.listWatchedChannels({ active: null });
      if ((await db.listWatchedChannels()).length !== 0 || candidates.length !== 1 || candidates[0].channelId !== 'UCpro' || candidates[0].defendViews !== 1000000) {
        throw new Error('A channel defending one claim to a large audience was not kept as a candidate');
      }
      const { WatchList } = require('./utils/watch-list');
      const secondClaim = new TopicGapFinder(db, {
        youtube, jev, watchList: () => new WatchList(db),
        aiText: { ...ai, generateText: async () => JSON.stringify([{ claim: 'Les cristaux soignent la fatigue', query: 'cristaux fatigue', pillar: 'Astronomie' }]) },
        budget: new YouTubeSearchBudget(db, { now: () => new Date(Date.now() + 5 * 86400000) })
      });
      const { gaps: [secondGap] } = await secondClaim.refresh({ contentPillars: ['Astronomie'] }, { limit: 1 });
      await db.upsertWatchedChannel({ channelId: 'UCmanual', title: 'Ajoutée', origin: 'manual' });
      await new WatchList(db).admit('UCmanual', { manual: true });
      const watched = await db.listWatchedChannels();
      const pro = watched.find(channel => channel.channelId === 'UCpro');
      if (watched.length !== 2 || pro?.defendViews !== 1000000 || pro.sightings !== 2 || !watched.some(channel => channel.origin === 'manual')) {
        throw new Error('A channel defending a second claim, or added by hand, is not watched');
      }
      await db.updateTopicGap(secondGap.id, { status: 'dismissed' });

      // 3. Without Jev, one Claude call classifies the videos.
      const fallback = new TopicGapFinder(db, { youtube, aiText: ai, jev: { enabled: () => false }, budget: new YouTubeSearchBudget(db, { now: () => new Date(Date.now() + 3 * 86400000) }) });
      const measured = await fallback.measure({ claim: 'Autre', query: 'autre' });
      if (measured.demandViews !== 1000000 || measured.supplyViews !== 20000) throw new Error('The Claude fallback did not classify the videos');

      // 4. The planner covers gaps first: an item keeps its gapId and the claim as measured; unknown ids are dropped.
      const strategyAgent = new ContentStrategyAgent(db, {});
      const openGaps = await strategyAgent.openGaps();
      const research = { gaps: openGaps.map(item => ({ gapId: item.id, claim: item.claim })) };
      const channel = { contentPillars: ['Astronomie'], default_format: 'explainer', default_length: 'medium' };
      const plan = strategyAgent.normalizeAutonomousPlan([
        { topic: 'La Lune fait-elle vraiment pousser les cheveux ?', format: 'explainer', gapId: gap.id },
        { topic: 'Autre sujet', format: 'explainer', gapId: 'gap_inconnu' }
      ], channel, 2, research);
      if (openGaps.length !== 1 || plan[0].gapId !== gap.id || plan[0].claim !== gap.claim || plan[0].origin !== 'gap' || plan[1].gapId || plan[1].origin) {
        throw new Error('The planner does not carry measured gaps to the job');
      }

      // 5. The gap follows its video: planned, covered with the production, open again after a failure.
      const app = Object.create(YouTubeAutomationAgent.prototype);
      app.db = db;
      app.logger = { warn() {} };
      await app.trackSubject({ gapId: gap.id }, 'planned');
      if ((await strategyAgent.openGaps()).length !== 0) throw new Error('A planned gap was offered again');
      await app.trackSubject({ gapId: gap.id }, 'open');
      await app.trackSubject({ gapId: gap.id }, 'covered', 'prod_1');
      const covered = await db.getTopicGap(gap.id);
      if (covered.status !== 'covered' || covered.productionId !== 'prod_1') throw new Error('A covered gap was not recorded');
    } finally {
      for (const [key, name] of [['daily', 'YOUTUBE_SEARCH_DAILY'], ['watch', 'GAP_WATCH_MIN_VIEWS']]) {
        if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
      }
      await new Promise(resolve => db.db.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async testVerificationSite() {
    const fs = require('fs').promises;
    const os = require('os');
    const { buildSite, deploySite, siteLink, siteSlug } = require('./utils/claims-site');
    const { YouTubeAutomationAgent } = require('./index');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-site-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'site.db');
    await db.initialize();
    const saved = process.env.SITE_BASE_URL;
    const savedFeeds = process.env.SITE_FEEDS;
    process.env.SITE_BASE_URL = 'https://example.github.io/verifications/';
    delete process.env.SITE_FEEDS;
    try {
      // A published long video with its examined claim, facts and sources, an automatic expert approval, an erratum;
      // a Short cut out of a video, a private video and an unpublished one stay off the site.
      const publish = async (id, { contentType = 'long_form', privacyStatus = 'public', status = 'published', script = {}, strategy = {}, seo = {} } = {}) => {
        await db.executeQuery('INSERT INTO productions (id, status) VALUES (?, ?)', [id, 'published']);
        await db.saveProductionSnapshot({ id, strategy: { topic: `Sujet ${id} : détail`, ...strategy }, script: { title: `Titre ${id}`, ...script }, seo });
        await db.executeQuery(
          'INSERT INTO publish_schedule (id, production_id, title, publish_time, status, metadata, youtube_id, youtube_url, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [`schedule_${id}`, id, 'Titre interne', '2026-09-01T10:00:00Z', status, JSON.stringify({ contentType, ...(contentType === 'short' ? { shortClipId: `clip_${id}` } : {}), privacyStatus, seo: { title: `Titre publié ${id}` } }), `yt_${id}`, `https://www.youtube.com/watch?v=yt_${id}`, '2026-09-01T10:00:00Z']
        );
      };
      await publish('prod_lune', {
        strategy: { contentPillar: 'Astronomie', planRationale: 'NOTE INTERNE DU PLANIFICATEUR' },
        seo: { siteSlug: 'la-lune-fixe' },
        script: {
          examinedClaim: { statement: 'La Lune fait pousser les cheveux', verdict: 'wrong', summary: 'Aucune étude.', techniques: ['hearsay', 'inconnue'] },
          expertReview: { required: true, status: 'approved', domain: 'astrophysique', reviewer: 'validation automatique (Jev)', notes: 'NOTE DU RELECTEUR', approximations: [{ excerpt: 'une énergie colossale', note: 'ordre de grandeur' }] },
          metadata: { strategy: { constraints: 'CONTRAINTE INTERNE' } },
          assets: { path: '/Users/secret/video.mp4' }
        }
      });
      await db.saveContentProvenance('prod_lune', {
        sources: [
          { id: 's1', url: 'https://www.nasa.gov/moon', title: 'NASA', publisher: 'NASA', status: 'verified', sourceType: 'official' },
          { id: 's2', url: 'https://example.org/trailer', title: 'Bande-annonce', status: 'verified', sourceType: 'video' },
          { id: 's3', url: 'javascript:alert(1)', title: 'Piège', status: 'verified', sourceType: 'other' }
        ],
        claims: [
          { id: 'c1', text: 'Aucune fissure globale <observée>', riskLevel: 'high', sourceIds: ['s1', 's3'], status: 'supported' },
          { id: 'c2', text: 'Une date approximative', riskLevel: 'standard', sourceIds: [], status: 'waived', notes: 'Imprécision mineure : 621 plutôt que 622.' },
          { id: 'c3', text: 'Affirmation en attente', riskLevel: 'standard', sourceIds: ['s2'], status: 'pending' }
        ],
        status: 'verified'
      });
      await db.addCorrection({ productionId: 'prod_lune', text: 'Rima Ariadaeus mesure environ 220 km.' });
      await publish('prod_inoc', { strategy: { technique: 'counting' }, script: { examinedClaim: null } });
      await publish('prod_short', { contentType: 'short' });
      await publish('prod_prive', { privacyStatus: 'private' });
      await publish('prod_attente', { status: 'scheduled' });

      const { files, videos } = await buildSite(db);
      const page = files['v/la-lune-fixe/index.html'];
      const everything = Object.values(files).join('\n');
      if (videos.length !== 2 || !page || !files['index.html'] || !files['data/claims.json'] || !files['errata/index.html'] ||
        !files['methode/index.html'] || !files['techniques/counting/index.html'] || files['.nojekyll'] !== '') {
        throw new Error('The verification site misses pages or lists unpublished, private or Short videos');
      }
      if (!page.includes('Titre publié prod_lune') || !page.includes('<span class="badge">Faux</span>') ||
        !page.includes('Aucune fissure globale &lt;observée&gt;') || !page.includes('href="https://www.nasa.gov/moon"') ||
        page.includes('javascript:') || page.includes('Bande-annonce') || page.includes('Affirmation en attente') ||
        !page.includes('621 plutôt que 622') || !page.includes('Rima Ariadaeus mesure environ 220 km.') ||
        !page.includes('validé automatiquement, sans relecture humaine') || page.includes('relu et validé par un humain') ||
        !page.includes('une énergie colossale') || !page.includes('href="../../techniques/hearsay/index.html"')) {
        throw new Error('A video page does not show its claim, verdict, sourced facts, review and corrections as expected');
      }
      if (/NOTE INTERNE|NOTE DU RELECTEUR|CONTRAINTE INTERNE|\/Users\/|validation automatique \(Jev\)|productionId/.test(everything)) {
        throw new Error('The verification site published a private field');
      }
      const open = JSON.parse(files['data/claims.json']);
      if (open.license !== 'CC BY 4.0' || open.videos[0].examinedClaim.techniques.join() !== 'hearsay' ||
        !files['techniques/counting/index.html'].includes('Titre publié prod_inoc') || !files['errata/index.html'].includes('220 km')) {
        throw new Error('The open data, technique pages or errata are wrong');
      }

      // RSS feeds and the static JSON API: off by default; on, they carry the same whitelisted fields as the pages, and
      // the feeds (absolute links) need the site's address.
      if (Object.keys(files).some(name => /^api\/|\.xml$/.test(name)) || files['index.html'].includes('application/rss+xml')) {
        throw new Error('RSS feeds or the JSON API were published while SITE_FEEDS is off');
      }
      process.env.SITE_FEEDS = 'on';
      const fed = (await buildSite(db)).files;
      const json = name => JSON.parse(fed[`api/v1/${name}`]);
      const feed = fed['feed.xml'] || '';
      const fedEverything = Object.values(fed).join('\n');
      if (json('index.json').version !== 1 || json('index.json').counts.videos !== 2 || json('videos.json').total !== 2 ||
        json('videos.json').items[0].href !== `api/v1/videos/${json('videos.json').items[0].slug}.json` ||
        json('videos/page-1.json').next !== null || json('videos/la-lune-fixe.json').examinedClaim.verdict !== 'wrong' ||
        json('videos/la-lune-fixe.json').corrections[0].text !== 'Rima Ariadaeus mesure environ 220 km.' ||
        json('techniques/counting.json').taughtBy[0].title !== 'Titre publié prod_inoc' ||
        json('techniques/hearsay.json').examples[0].slug !== 'la-lune-fixe' ||
        json('corrections.json').items[0].video !== 'la-lune-fixe' || !Array.isArray(json('channels.json').items) ||
        !fed['api/index.html'].includes('api/v1/videos/{slug}.json') || !fed['index.html'].includes('href="api/index.html">Données')) {
        throw new Error('The static JSON API is wrong');
      }
      if ((feed.match(/<item>/g) || []).length !== 2 || !feed.includes('<link>https://example.github.io/verifications/v/la-lune-fixe/</link>') ||
        !feed.includes('Faux : « La Lune fait pousser les cheveux »') || !feed.startsWith('<?xml') ||
        !(fed['corrections.xml'] || '').includes('220 km') || !fed['v/la-lune-fixe/index.html'].includes('type="application/rss+xml"') ||
        /NOTE INTERNE|NOTE DU RELECTEUR|CONTRAINTE INTERNE|\/Users\/|validation automatique \(Jev\)|productionId/.test(fedEverything)) {
        throw new Error('The RSS feeds are wrong or carry a private field');
      }
      process.env.SITE_BASE_URL = '';
      const relative = (await buildSite(db)).files;
      if (relative['feed.xml'] || !relative['api/v1/index.json'] || relative['index.html'].includes('application/rss+xml')) {
        throw new Error('RSS feeds were published without the site\'s address');
      }
      process.env.SITE_BASE_URL = 'https://example.github.io/verifications/';
      delete process.env.SITE_FEEDS;

      // A human approval is said to be one; the page address stays the one recorded at description time.
      const slug = siteSlug('La Lune fait-elle pousser les cheveux ? Le mythe', 'prod_x');
      if (!/^la-lune-fait-elle-pousser-les-cheveux-[0-9a-f]{4}$/.test(slug) || siteSlug('La Lune fait-elle pousser les cheveux ?', 'prod_x') !== slug ||
        siteLink({ id: 'prod_x', strategy: { topic: 'Autre' }, seo: { siteSlug: 'fixe' } }).url !== 'https://example.github.io/verifications/v/fixe/') {
        throw new Error('Site addresses are not stable');
      }
      await db.saveProductionSnapshot({ ...(await db.getProductionBundle('prod_lune')), script: { examinedClaim: { statement: 'x', verdict: 'wrong' }, expertReview: { required: true, status: 'approved', reviewer: null } } });
      if (!(await buildSite(db)).files['v/la-lune-fixe/index.html'].includes('relu et validé par un humain')) {
        throw new Error('A human approval was not presented as one');
      }

      // The description carries the page right after the subscribe line, once, and an edited one gets it back.
      const agent = new YouTubeAutomationAgent();
      agent.db = db;
      agent.youtubeChannelId = async () => 'UC1';
      agent.buildDescriptionExtras = async () => '';
      const composed = await agent.composeDescription('prod_lune', 'Résumé.', [], {});
      const recomposed = await agent.composeDescription('prod_lune', composed, [], {});
      const finalized = await agent.finalizeDescription('Résumé édité.\n\n🔔 Abonne-toi : x', [], {}, siteLink({ id: 'prod_lune', seo: { siteSlug: 'la-lune-fixe' } }).line);
      if (composed !== 'Résumé.\n\n' + composed.split('\n\n')[1] + '\n\n🔎 Vérifications, sources et corrections : https://example.github.io/verifications/v/la-lune-fixe/' ||
        recomposed !== composed || !finalized.endsWith('🔔 Abonne-toi : x\n\n🔎 Vérifications, sources et corrections : https://example.github.io/verifications/v/la-lune-fixe/')) {
        throw new Error(`The description does not carry the verification page once: ${JSON.stringify([composed, finalized])}`);
      }

      // Deploying: clone once, commit and push only when something changed, one deployment at a time.
      const calls = [];
      let changed = ' M index.html';
      const runGit = async (cwd, args) => {
        calls.push(args[0]);
        if (args[0] === 'clone') await fs.mkdir(path.join(args[2], '.git'), { recursive: true });
        return args[0] === 'status' ? changed : '';
      };
      const siteDir = path.join(directory, 'site');
      const [first, same] = await Promise.all([deploySite(db, { directory: siteDir, runGit }), deploySite(db, { directory: siteDir, runGit })]);
      changed = '';
      const second = await deploySite(db, { directory: siteDir, runGit });
      if (!first.deployed || same !== first || calls.join() !== 'clone,add,status,commit,push,add,status' || second.reason !== 'no change' ||
        !(await fs.readFile(path.join(siteDir, 'v', 'la-lune-fixe', 'index.html'), 'utf8')).includes('Faux')) {
        throw new Error(`The site was not deployed once and only on change: ${calls.join()}`);
      }
    } finally {
      process.env.SITE_BASE_URL = saved;
      if (savedFeeds === undefined) delete process.env.SITE_FEEDS;
      else process.env.SITE_FEEDS = savedFeeds;
      await new Promise(resolve => db.db.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async testLessonFormat() {
    const fs = require('fs').promises;
    const os = require('os');
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const { ScriptWriterAgent, normalizeExaminedClaim } = require('./agents/script-writer-agent');
    const { YouTubeAutomationAgent, strategyContextOf } = require('./index');
    const { draftOf } = require('./utils/expert-review-service');
    const { techniques, getTechnique } = require('./utils/techniques');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-lesson-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'lesson.db');
    await db.initialize();
    try {
      // 1. The react profile's catalog: every technique has a definition, signs and the question that titles its lesson.
      if (techniques().length < 5 || techniques().some(t => !t.id || !t.name || !t.definition || !t.signs.length || !t.question) ||
        new Set(techniques().map(t => t.id)).size !== techniques().length) {
        throw new Error('The technique catalog is incomplete');
      }

      // 2. One video in four (lesson.every): due after three completed videos, on the technique the examined claims rely on most
      // among those never taught; not due again until three more.
      const agent = new ContentStrategyAgent(db, {});
      let finished = 0;
      const complete = async style => {
        const job = await db.createGenerationJob({ topic: `Sujet ${style}`, style, length: 'medium', source: 'test' });
        finished += 1;
        await db.updateGenerationJob(job.id, { status: 'completed', completedAt: new Date(Date.UTC(2026, 0, 1, 0, finished)).toISOString() });
      };
      await complete('explainer');
      await complete('explainer');
      if (await agent.lessonDue()) throw new Error('A lesson was due after two videos');
      await complete('explainer');
      await db.saveProductionSnapshot({ id: 'prod_claims', strategy: {}, script: { examinedClaim: { statement: 'x', verdict: 'wrong', techniques: ['counting'] } } });
      const due = await agent.lessonDue();
      if (due?.technique !== 'counting' || !due.question) throw new Error(`The lesson cadence picked the wrong technique (${due?.technique})`);

      // 3. The plan leads with it, whether the model proposed it or not, and only when due; normalizing twice keeps one.
      const channel = { contentPillars: ['Astronomie'], default_format: 'explainer', default_length: 'medium' };
      const modelPlan = [{ topic: 'Les phases de la Lune', format: 'explainer' }, { topic: 'Pourquoi les nombres semblent-ils cacher des messages', format: 'lesson' }];
      const once = agent.normalizeAutonomousPlan(modelPlan, channel, 1, { lessonDue: due });
      const twice = agent.normalizeAutonomousPlan([...once, ...modelPlan], channel, 1, { lessonDue: due });
      if (once[0].format !== 'lesson' || once[0].technique !== 'counting' || once[0].origin !== 'lesson' ||
        once[0].topic !== 'Pourquoi les nombres semblent-ils cacher des messages' || twice.length !== 1 || twice[0].topic !== once[0].topic) {
        throw new Error('A due lesson does not lead the plan');
      }
      const built = agent.normalizeAutonomousPlan([{ topic: 'Les phases de la Lune', format: 'explainer' }], channel, 2, { lessonDue: due });
      if (built[0].topic !== getTechnique('counting').question || built[1].topic !== 'Les phases de la Lune') {
        throw new Error('A due lesson was not built when the model left it out');
      }
      const notDue = agent.normalizeAutonomousPlan(modelPlan, channel, 2, {});
      if (notDue.some(item => item.format === 'lesson')) throw new Error('A lesson was planned when none was due');
      await complete('lesson');
      if (await agent.lessonDue()) throw new Error('A lesson was due right after one');
      await db.saveProductionSnapshot({ id: 'prod_taught', strategy: { technique: 'counting' }, script: {} });
      if ((await agent.nextTechnique()).id === 'counting') throw new Error('A technique just taught was picked again');

      // 4. The script states the claim it examines, its verdict and known techniques only; a lesson teaches its
      // technique instead.
      if (JSON.stringify(normalizeExaminedClaim({ statement: ' La Lune  fait pousser les cheveux ', verdict: 'WRONG', summary: 'Non.', techniques: ['counting', 'inconnue'] })) !==
        JSON.stringify({ statement: 'La Lune fait pousser les cheveux', verdict: 'wrong', summary: 'Non.', techniques: ['counting'] }) ||
        normalizeExaminedClaim({ statement: 'x', verdict: 'peut-être' }).verdict !== 'unproven' || normalizeExaminedClaim({}) !== null) {
        throw new Error('Examined claims are not normalized');
      }
      const prompts = [];
      const writer = new ScriptWriterAgent(db, {});
      writer.aiTextService = {
        isAvailable: () => true,
        providerName: 'test',
        generateText: async prompt => {
          prompts.push(prompt);
          return JSON.stringify({
            title: 'Titre', hook: 'Accroche.', cta: 'Abonne-toi pour la suite.',
            sections: [{ title: 'A', register: 'opening', content: ['Paragraphe.'] }, { title: 'B', register: 'main', content: ['Sauf que.'] }],
            claims: [], examinedClaim: { statement: 'La Lune fait pousser les cheveux', verdict: 'wrong', summary: 'Aucune étude.', techniques: ['hearsay'] }
          });
        }
      };
      const template = writer.templates.explainer;
      const regular = await writer.generateScriptWithAI({ topic: 'La Lune', contentType: 'Explainer', examinedClaimHint: 'La Lune fait pousser les cheveux' }, template);
      const taught = await writer.generateScriptWithAI({ topic: 'Les nombres', contentType: 'Lesson', technique: 'counting' }, writer.templates.lesson);
      if (regular.examinedClaim?.techniques[0] !== 'hearsay' || regular.technique !== null ||
        !prompts[0].includes('Claim to examine, as it circulates: La Lune fait pousser les cheveux') || !prompts[0].includes('counting: Les coïncidences comptées') ||
        !prompts[0].includes('"register": "opening|main"') || !prompts[0].includes('"verdict": "wrong|misleading|unproven|untestable|right"') ||
        taught.examinedClaim !== null || taught.technique !== 'counting' || !prompts[1].includes('Technique taught by this video: Les coïncidences comptées') ||
        !prompts[1].includes('several real examples from different fields') || prompts[1].includes('the question the video answers or what it shows')) {
        throw new Error('The script writer does not examine a claim or teach the technique');
      }
      if (draftOf(regular).examinedClaim?.verdict !== 'wrong') throw new Error('An expert revision would lose the examined claim');

      // 5. The generation context carries origin, technique, gap and claim, rejects unknown ones, and survives a retry.
      const app = Object.create(YouTubeAutomationAgent.prototype);
      const accepted = app.validateGenerateRequestBody({ style: 'Lesson', strategyContext: { technique: 'anecdote', origin: 'reactive', gapId: 'gap_1', claim: 'La Lune fait pousser les cheveux' } });
      if (!accepted.valid || accepted.value.style !== 'lesson' || accepted.value.strategyContext.technique !== 'anecdote' ||
        accepted.value.strategyContext.origin !== 'reactive' || accepted.value.strategyContext.claim !== 'La Lune fait pousser les cheveux') {
        throw new Error('The generation context did not keep origin, technique and claim');
      }
      for (const context of [{ technique: 'inconnue' }, { origin: 'ailleurs' }, { claim: 'x'.repeat(501) }]) {
        if (app.validateGenerateRequestBody({ strategyContext: context }).valid) throw new Error(`An invalid generation context was accepted: ${JSON.stringify(context)}`);
      }
      const rebuilt = strategyContextOf({ origin: 'reactive', reactiveId: 'reactive_1', technique: 'anecdote', examinedClaimHint: 'La Lune fait pousser les cheveux', angle: 'Angle', contentPillar: 'Astronomie', planRationale: null });
      if (JSON.stringify(rebuilt) !== JSON.stringify({ angle: 'Angle', pillar: 'Astronomie', technique: 'anecdote', origin: 'reactive', reactiveId: 'reactive_1', claim: 'La Lune fait pousser les cheveux' }) ||
        !app.validateGenerateRequestBody({ strategyContext: rebuilt }).valid) {
        throw new Error('A retried video would lose its generation context');
      }
    } finally {
      await new Promise(resolve => db.db.close(resolve));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async testExpertReview() {
    const fs = require('fs').promises;
    const os = require('os');
    const { YouTubeAutomationAgent } = require('./index');
    const { GenerationRecoveryService } = require('./utils/generation-recovery-service');
    const { ExpertReviewService } = require('./utils/expert-review-service');
    const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
    const { OperatorService } = require('./utils/operator-service');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-expert-'));
    const db = new Database();
    db.dbPath = path.join(directory, 'expert.db');
    await db.initialize();
    const savedEnv = {
      mode: process.env.EXPERT_REVIEW, url: process.env.EXPERT_REVIEW_WEBHOOK_URL,
      general: process.env.NOTIFICATION_WEBHOOK_URL, factCheck: process.env.AUTO_FACT_CHECK, mention: process.env.EXPERT_REVIEW_MENTION
    };
    // Written the way it gets pasted by hand: the stray colon must not stop the ping.
    process.env.EXPERT_REVIEW_MENTION = '<@:352176756922253321>';
    process.env.EXPERT_REVIEW = 'auto';
    process.env.AUTO_FACT_CHECK = 'false';
    process.env.EXPERT_REVIEW_WEBHOOK_URL = 'https://hooks.example.test/expert';
    delete process.env.NOTIFICATION_WEBHOOK_URL;

    const thumbnailPath = path.join(directory, 'thumbnail.jpg');
    const videoPath = path.join(directory, 'video.mp4');
    await fs.writeFile(thumbnailPath, Buffer.from('thumbnail'));
    await fs.writeFile(videoPath, Buffer.from('video'));
    const scriptFor = (title, sentence) => ({
      title,
      hook: { text: 'Et si le temps passait plus vite en haut d\'une montagne ?' },
      mainContent: { sections: [{ title: 'Le chat de Schrödinger', register: 'main', content: [sentence, 'Le paragraphe suivant reste inchangé.'] }] },
      callToAction: { subscribe: 'Abonne-toi pour la suite.' },
      claims: [{ text: sentence, riskLevel: 'high', sourceUrls: [] }],
      fullScript: `${title}\n${sentence}`
    });
    const firstDraft = scriptFor('La conscience crée-t-elle la réalité ?', "L'observateur conscient fait s'effondrer la fonction d'onde.");
    const corrected = scriptFor('La conscience crée-t-elle la réalité ?', "La mesure est une interaction physique : aucun observateur conscient n'est requis.");
    // Two passages the model is sure of (validated without an expert), then eight it doubts, the least sure being Passage 3.
    const longPassages = [
      { excerpt: 'Évident 0 : la mesure est une interaction.', confidence: 9.5, concern: 'Définition de manuel.' },
      { excerpt: 'Évident 1 : la fonction d\'onde décrit des probabilités.', confidence: 9, concern: 'Définition de manuel.' },
      ...Array.from({ length: 8 }, (_, index) => ({ excerpt: `Passage ${index} ${'x'.repeat(400)}`, confidence: index === 3 ? 2 : 6, concern: 'y'.repeat(300) }))
    ];
    let assessments = 0;
    let aiAnswer = { specialised: true, domain: 'physique quantique', expertProfile: 'physicien·ne en mécanique quantique', reason: 'Le script explique la mesure quantique.', passages: longPassages,
      approximations: [{ excerpt: 'Le paragraphe suivant reste inchangé.', note: "Ordre de grandeur, sans enjeu de santé." }] };
    const ai = {
      isAvailable: () => true,
      generateText: async () => {
        assessments++;
        if (aiAnswer instanceof Error) throw aiAnswer;
        return JSON.stringify(aiAnswer);
      }
    };
    const posts = [];
    let webhookDown = false;
    const http = { post: async (url, payload) => { if (webhookDown) throw new Error('connect ECONNREFUSED'); posts.push({ url, payload }); return { status: 204 }; } };
    const scriptCalls = [];
    let productionCalls = 0;
    let lastProduction = null;

    try {
      const agent = new YouTubeAutomationAgent();
      agent.db = db;
      agent.recovery = new GenerationRecoveryService(db, { logger: agent.logger, baseDelayMs: 0, updateJobStage: (...args) => agent.updateJobStage(...args) });
      agent.readiness = { assertReady: async () => true };
      agent.operator = {
        runQualityChecks: async production => { lastProduction = production; return { passed: true, score: 100, checks: [{ passed: true }], blockingFailures: [] }; },
        notify: async () => null
      };
      agent.expertReview = new ExpertReviewService(db, {
        // Never the real Jev API from the tests; the first sort gets its own fake below.
        aiTextService: ai, http, directory, retryDelayMs: 0, jev: { enabled: () => false },
        resumeJob: (jobId, options) => agent.resumeGenerationJob(jobId, options)
      });
      agent.agents = {
        strategy: { generateContentStrategy: async () => ({ topic: 'Le temps et la relativité', contentType: 'Explainer' }) },
        scriptWriter: { generateScript: async strategy => { scriptCalls.push(strategy); return strategy.expertRevision ? corrected : firstDraft; } },
        thumbnailDesigner: { generateThumbnail: async () => ({ path: thumbnailPath, concept: {} }) },
        seoOptimizer: { optimize: async script => ({ title: script.title, description: 'Une description complète de la vidéo.', tags: ['quantique'] }) },
        production: {
          processContent: async input => {
            productionCalls++;
            return {
              id: `expert-production-${Date.now()}`, status: 'ready', ...input,
              assets: { finalVideo: { path: videoPath, simulated: false }, thumbnail: { path: thumbnailPath } },
              timeline: {}, scheduledPublishTime: new Date(Date.now() + 86400000).toISOString(), priority: 50, estimatedDuration: '2:00'
            };
          }
        },
        publishing: { scheduleContent: async () => null }
      };
      const input = { topic: 'Le temps et la relativité', style: 'explainer', length: 'short', strategyContext: {} };

      // 1. A quantum physics script stops before narration and alerts the webhook once, within Discord's limit.
      const job = await db.createGenerationJob({ ...input, source: 'autonomous_operator' });
      await agent.runGenerationJob(job.id, input);
      let held = await db.getGenerationJob(job.id);
      let [review] = await db.listExpertReviews({ jobId: job.id });
      if (held.status !== 'waiting_expert' || held.stage !== 'expert_review' || productionCalls !== 0 || !review || review.status !== 'pending') {
        throw new Error('A specialised script was not held for an expert before production');
      }
      if ((await db.getGenerationCheckpoint(job.id, 'expert_review')).status !== 'waiting') {
        throw new Error('The held stage did not record a waiting checkpoint');
      }
      const alert = posts[0]?.payload;
      if (posts.length !== 1 || posts[0].url !== 'https://hooks.example.test/expert' || alert.event !== 'expert_review_required' ||
        alert.content.length > 2000 || !alert.content.includes(`approve ${review.id}`) || !alert.content.includes('physique quantique') ||
        !alert.script.markdown.includes("L'observateur conscient") || alert.review.passages.length !== 8 || !review.notifiedAt) {
        throw new Error('The expert review webhook payload is incomplete or too long for Discord');
      }
      // Above 6.6/10 of confidence a passage is validated without an expert: the expert is only asked about the others.
      if (review.assessment.validated.length !== 2 || review.assessment.passages.some(passage => passage.confidence > 6.6) ||
        alert.script.markdown.includes('Évident') || !alert.content.includes('**Validés automatiquement** : 2 passages au-dessus de 6,6/10') ||
        !alert.embeds[0].title.endsWith('confiance 2/10')) {
        throw new Error('Passages the model is confident in were sent to the expert');
      }
      if (!alert.content.split('\n')[1].startsWith('<@352176756922253321> **« ') || !alert.text.startsWith('<@352176756922253321> ') ||
        alert.allowed_mentions.users[0] !== '352176756922253321' || alert.allowed_mentions.parse.length !== 0) {
        throw new Error('The expert review alert does not ping only the configured Discord user');
      }
      // Discord gets markdown (headings, commands in code) and every passage whole in an embed; Slack keeps plain text.
      const embedsLength = alert.embeds.reduce((sum, embed) => sum + embed.title.length + embed.description.length, 0);
      if (!alert.content.startsWith('## 🔬 Relecture experte requise') || !alert.content.includes(`\`npm run expert -- approve ${review.id}\``) ||
        alert.text.includes('**') || !alert.embeds[0].description.startsWith('> « Passage 3 x') || !alert.embeds[0].description.endsWith('y'.repeat(300)) ||
        alert.embeds.length > 10 || embedsLength > 6000 || (alert.embeds.length < 8 && !alert.content.includes('dans le fichier joint'))) {
        throw new Error('The Discord alert does not carry every passage whole within Discord\'s limits, or the Slack text is markdown');
      }
      // Forwardable to the expert as it is: the brief says what is asked of them, without the commands or a local path.
      if (alert.script.filename !== 'relecture-la-conscience-cree-t-elle-la-realite.md' || !alert.script.markdown.includes('## Votre retour') ||
        alert.script.markdown.includes('npm run') || alert.script.markdown.includes(directory) || !alert.text.includes('## Votre retour')) {
        throw new Error('The brief sent with the alert cannot be forwarded to an expert as it is');
      }
      // Discord receives the brief as an attached file, which a forwarded message keeps.
      process.env.EXPERT_REVIEW_WEBHOOK_URL = 'https://discord.com/api/webhooks/1/token';
      await agent.expertReview.deliver(review);
      process.env.EXPERT_REVIEW_WEBHOOK_URL = 'https://hooks.example.test/expert';
      const form = posts.pop().payload;
      const discordJson = JSON.parse(form.get('payload_json'));
      const attached = form.get('files[0]');
      if (!discordJson.content.startsWith('## 🔬') || discordJson.embeds.length !== alert.embeds.length || discordJson.event ||
        discordJson.attachments[0].filename !== alert.script.filename || attached.name !== alert.script.filename ||
        !(await attached.text()).includes("L'observateur conscient")) {
        throw new Error('The Discord alert does not attach the brief');
      }
      const scriptFile = await fs.readFile(review.scriptPath, 'utf8');
      if (!scriptFile.includes('## Passages à vérifier en priorité') || !scriptFile.includes('1. « Passage 3') ||
        !scriptFile.includes('## Validés automatiquement (confiance au-dessus de 6,6/10)\n\n- « Évident 0 : la mesure est une interaction. » (9,5/10)')) {
        throw new Error('The script file for the expert was not written');
      }
      // The expert sees the assumed approximations apart, so as not to spend time on them.
      if (!scriptFile.includes('## Approximations assumées') || !scriptFile.includes('« Le paragraphe suivant reste inchangé. » → Ordre de grandeur') ||
        alert.review.approximations.length !== 1) {
        throw new Error('The assumed approximations were not set apart for the expert');
      }
      if (!(await db.listNotifications(5)).some(item => item.type === 'expert_review_required')) {
        throw new Error('The expert review was not recorded in the dashboard notifications');
      }
      if (agent.recovery.resumePoint(await db.listGenerationCheckpoints(job.id)) !== 'expert_review') {
        throw new Error('The held job does not resume at the expert review');
      }

      // 2. Resuming before a decision waits again without a second alert.
      await agent.resumeGenerationJob(job.id);
      await agent.waitForGenerationJob(job.id);
      if ((await db.getGenerationJob(job.id)).status !== 'waiting_expert' || posts.length !== 1 || productionCalls !== 0) {
        throw new Error('A pending expert review was bypassed or re-alerted on resume');
      }

      // 3. Corrections rewrite the script with the expert's notes, then the new draft goes back to the expert.
      try {
        await agent.expertReview.decide(review.id, { decision: 'revise', notes: 'à revoir' });
        throw new Error('short notes accepted');
      } catch (error) {
        if (error.status !== 400) throw new Error('A revision without usable corrections was accepted');
      }
      aiAnswer = { specialised: false, domain: '', expertProfile: '', reason: '', passages: [],
        approximations: [{ excerpt: 'Le paragraphe suivant reste inchangé.', note: 'Estimation arrondie.' }] };
      const revised = await agent.expertReview.decide(review.id, {
        decision: 'revise', reviewer: 'Dr Test', notes: "La décohérence n'implique aucune conscience : corriger le passage sur l'observateur."
      });
      await agent.waitForGenerationJob(job.id);
      const reviews = await db.listExpertReviews({ jobId: job.id });
      const revision = scriptCalls[scriptCalls.length - 1].expertRevision;
      if (!revised.resumed || !revision?.notes.includes('décohérence') || !revision.previousDraft?.sections?.[0]?.content?.[0].includes("L'observateur") ||
        reviews.length !== 2 || reviews[0].revision !== 2 || reviews[0].status !== 'pending' || reviews[1].status !== 'revision_requested' ||
        posts.length !== 2 || !posts[1].payload.content.includes('révision 2') || !posts[1].payload.content.includes('Corrections demandées') ||
        (await db.getGenerationJob(job.id)).status !== 'waiting_expert' || productionCalls !== 0) {
        throw new Error('Expert corrections did not rewrite the script and send it back for review');
      }
      try {
        await agent.expertReview.decide(reviews[1].id, { decision: 'approve' });
        throw new Error('stale review decided');
      } catch (error) {
        if (error.status !== 409) throw new Error('A superseded expert review could be decided again');
      }

      // 4. Approval resumes production with the approved script, recorded on the production.
      review = reviews[0];
      const approved = await agent.expertReview.decide(review.id, { decision: 'approve', reviewer: 'Dr Test', notes: 'Correct.' });
      await agent.waitForGenerationJob(job.id);
      const done = await db.getGenerationJob(job.id);
      if (!approved.resumed || done.status !== 'completed' || productionCalls !== 1 ||
        lastProduction?.script?.expertReview?.status !== 'approved' || lastProduction.script.expertReview.reviewer !== 'Dr Test' ||
        !lastProduction.script.mainContent.sections[0].content[0].includes('interaction physique') ||
        lastProduction.script.expertReview.approximations[0]?.note !== 'Estimation arrondie.') {
        throw new Error('An approved expert review did not resume production with the approved script');
      }

      // 5. The quality gate blocks a specialised script that no expert approved.
      const quality = await new OperatorService(db).runQualityChecks({ script: { expertReview: { required: true, status: 'pending', domain: 'physique quantique' } } });
      const expertCheck = quality.checks.find(check => check.id === 'expert_review');
      if (!expertCheck || expertCheck.passed || !expertCheck.blocking || !quality.blockingFailures.includes('expert_review')) {
        throw new Error('The quality gate does not block an unreviewed specialised script');
      }

      // 6. A subject that needs no expert goes straight through, its assumed approximations annotated, not held for.
      aiAnswer = {
        specialised: false, domain: '', expertProfile: '', reason: '', passages: [],
        approximations: [{ excerpt: 'Le paragraphe suivant reste inchangé.', note: "Énergie donnée en ordre de grandeur ; l'argument n'en dépend pas." }]
      };
      const plain = await db.createGenerationJob({ ...input, source: 'manual' });
      await agent.runGenerationJob(plain.id, input);
      const plainCheckpoint = await db.getGenerationCheckpoint(plain.id, 'expert_review');
      if ((await db.getGenerationJob(plain.id)).status !== 'completed' || plainCheckpoint.artifact.expertReview.status !== 'not_required' ||
        (await db.listExpertReviews({ jobId: plain.id })).length !== 0 || posts.length !== 2) {
        throw new Error('A script without a specialised subject was held');
      }
      const annotated = await new OperatorService(db).runQualityChecks({ script: { expertReview: plainCheckpoint.artifact.expertReview } });
      const approximationCheck = annotated.checks.find(check => check.id === 'assumed_approximations');
      if (!approximationCheck?.passed || approximationCheck.blocking || !approximationCheck.message.includes('« Le paragraphe suivant reste inchangé. »') ||
        annotated.checks.some(check => check.id === 'expert_review')) {
        throw new Error('Assumed approximations were not annotated for the approver, or they blocked the video');
      }

      // 6b. A specialised script whose every passage scores above 6.6/10 goes through, its passages annotated.
      aiAnswer = {
        specialised: true, domain: 'physique quantique', expertProfile: 'physicien·ne', reason: 'Le script explique la mesure.',
        passages: [{ excerpt: 'Le paragraphe suivant reste inchangé.', confidence: 9, concern: 'Définition de manuel.' }]
      };
      const confident = await db.createGenerationJob({ ...input, source: 'manual' });
      await agent.runGenerationJob(confident.id, input);
      const confidentReview = (await db.getGenerationCheckpoint(confident.id, 'expert_review')).artifact.expertReview;
      const confidenceChecks = await new OperatorService(db).runQualityChecks({ script: { expertReview: confidentReview } });
      const confidenceCheck = confidenceChecks.checks.find(check => check.id === 'expert_confidence');
      if ((await db.getGenerationJob(confident.id)).status !== 'completed' || confidentReview.status !== 'auto_validated' ||
        confidentReview.required || confidentReview.autoValidated.length !== 1 || (await db.listExpertReviews({ jobId: confident.id })).length !== 0 ||
        posts.length !== 2 || !confidenceCheck?.passed || confidenceCheck.blocking || !confidenceCheck.message.includes('9/10')) {
        throw new Error('A specialised script the model is confident in was held, or its passages were not annotated');
      }

      // 6c. Jev sorts first: a script it finds clearly outside the specialised fields skips the Claude assessment; in
      // doubt, or when Jev fails, Claude assesses it as before.
      const jevCalls = [];
      let jevAnswer = 0.05;
      agent.expertReview.jev = {
        enabled: () => true,
        ask: async ({ purpose, state, questions }) => {
          jevCalls.push({ purpose, state, questions });
          if (jevAnswer instanceof Error) throw jevAnswer;
          return { specialised: { type: 'noul', noul: jevAnswer } };
        }
      };
      const sortedOut = await db.createGenerationJob({ ...input, source: 'manual' });
      let assessmentsBefore = assessments;
      await agent.runGenerationJob(sortedOut.id, input);
      const sortedReview = (await db.getGenerationCheckpoint(sortedOut.id, 'expert_review')).artifact.expertReview;
      if ((await db.getGenerationJob(sortedOut.id)).status !== 'completed' || assessments !== assessmentsBefore ||
        sortedReview.status !== 'not_required' || sortedReview.triage?.probability !== 0.05 || !sortedReview.reason.includes('Jev') ||
        jevCalls[0].purpose !== 'expert_triage' || !jevCalls[0].state.narration.includes("L'observateur conscient") ||
        jevCalls[0].questions.specialised.type !== 'noul') {
        throw new Error('A script Jev found outside the specialised fields still went through the Claude assessment');
      }
      for (const answer of [0.6, new Error('Jev request failed: HTTP 529')]) {
        jevAnswer = answer;
        const doubtful = await db.createGenerationJob({ ...input, source: 'manual' });
        assessmentsBefore = assessments;
        await agent.runGenerationJob(doubtful.id, input);
        const doubtfulReview = (await db.getGenerationCheckpoint(doubtful.id, 'expert_review')).artifact.expertReview;
        if (assessments !== assessmentsBefore + 1 || doubtfulReview.status !== 'auto_validated' || doubtfulReview.triage ||
          doubtfulReview.jevProbability !== (answer instanceof Error ? null : 0.6)) {
          throw new Error(`A script Jev ${answer instanceof Error ? 'could not sort' : 'was unsure of'} skipped the Claude assessment`);
        }
      }
      agent.expertReview.jev.enabled = () => false;

      // 7. A failed assessment holds the script; a webhook outage is retried by the scheduler tick; rejection closes the job.
      aiAnswer = new Error('model unavailable');
      webhookDown = true;
      const unsure = await db.createGenerationJob({ ...input, source: 'manual' });
      await agent.runGenerationJob(unsure.id, input);
      let [unsureReview] = await db.listExpertReviews({ jobId: unsure.id });
      if ((await db.getGenerationJob(unsure.id)).status !== 'waiting_expert' || !unsureReview?.assessment?.failed ||
        unsureReview.notifiedAt || !unsureReview.notifyError) {
        throw new Error('A failed assessment or webhook outage was not handled safely');
      }
      webhookDown = false;
      await agent.expertReview.tick();
      [unsureReview] = await db.listExpertReviews({ jobId: unsure.id });
      if (!unsureReview.notifiedAt || posts.length !== 3) {
        throw new Error('The scheduler tick did not resend an alert that never reached the webhook');
      }
      // Reassessed under the current rules: an assessment that still fails leaves the review as it was; 6.6 is not above
      // the threshold, so that passage alone goes back to the expert.
      try {
        await agent.expertReview.reassess(unsureReview.id);
        throw new Error('failed reassessment accepted');
      } catch (error) {
        if (error.status !== 503 || (await db.getExpertReview(unsureReview.id)).status !== 'pending') {
          throw new Error('A failed reassessment changed the review');
        }
      }
      aiAnswer = {
        specialised: true, domain: 'physique quantique', expertProfile: 'physicien·ne', reason: 'Le script explique la mesure.',
        passages: [{ excerpt: 'Limite 6,6.', confidence: 6.6, concern: 'Nuance discutée.' }, { excerpt: 'Sûr.', confidence: 10, concern: 'Manuel.' }]
      };
      const partly = await agent.expertReview.reassess(unsureReview.id);
      unsureReview = partly.review;
      if (partly.autoValidated || unsureReview.status !== 'pending' || unsureReview.assessment.failed || unsureReview.assessment.passages.length !== 1 ||
        unsureReview.assessment.passages[0].excerpt !== 'Limite 6,6.' || unsureReview.assessment.validated.length !== 1 || unsureReview.domain !== 'physique quantique' ||
        posts.length !== 4 || posts[3].payload.embeds.length !== 1 || !posts[3].payload.embeds[0].title.endsWith('confiance 6,6/10')) {
        throw new Error('A reassessment did not send back only the passages at or below the threshold');
      }
      await agent.expertReview.decide(unsureReview.id, { decision: 'reject', notes: 'Sujet trop spéculatif.' });
      const rejected = await db.getGenerationJob(unsure.id);
      if (rejected.status !== 'rejected' || !rejected.error.includes('Sujet trop spéculatif')) {
        throw new Error('A rejected expert review did not close its job');
      }

      // 7b. A held review reassessed with every passage above the threshold is approved automatically and production resumes.
      aiAnswer = new Error('model unavailable');
      const later = await db.createGenerationJob({ ...input, source: 'manual' });
      await agent.runGenerationJob(later.id, input);
      const [laterReview] = await db.listExpertReviews({ jobId: later.id });
      aiAnswer = {
        specialised: true, domain: 'physique quantique', expertProfile: 'physicien·ne', reason: 'Le script explique la mesure.',
        passages: [{ excerpt: 'Le paragraphe suivant reste inchangé.', confidence: 9.5, concern: 'Manuel.' }]
      };
      const productionsBefore = productionCalls;
      // Claude already found it specialised: Jev's first sort (0.01 here) does not overrule that on a reassessment.
      agent.expertReview.jev.enabled = () => true;
      jevAnswer = 0.01;
      const jevCallsBefore = jevCalls.length;
      const auto = await agent.expertReview.reassess(laterReview.id);
      if (jevCalls.length !== jevCallsBefore) throw new Error('A reassessment let Jev overrule Claude');
      await agent.waitForGenerationJob(later.id);
      if (!auto.autoValidated || !auto.resumed || auto.review.status !== 'approved' || auto.review.decidedBy !== 'validation automatique' ||
        !auto.review.decisionNotes.includes('9,5/10') || (await db.getGenerationJob(later.id)).status !== 'completed' ||
        productionCalls !== productionsBefore + 1 || lastProduction.script.expertReview.autoValidated.length !== 1) {
        throw new Error('A reassessment with every passage above the threshold did not approve the review and resume production');
      }

      // 7c. Asked to (reassess --jev), Jev's first sort decides again: a subject it finds outside the specialised fields
      // is approved without the Claude assessment.
      agent.expertReview.jev.enabled = () => false;
      aiAnswer = new Error('model unavailable');
      const sortable = await db.createGenerationJob({ ...input, source: 'manual' });
      await agent.runGenerationJob(sortable.id, input);
      const [sortableReview] = await db.listExpertReviews({ jobId: sortable.id });
      agent.expertReview.jev.enabled = () => true;
      jevAnswer = 0.04;
      assessmentsBefore = assessments;
      const sortedAgain = await agent.expertReview.reassess(sortableReview.id, { triage: true });
      await agent.waitForGenerationJob(sortable.id);
      if (!sortedAgain.autoValidated || sortedAgain.review.status !== 'approved' || sortedAgain.review.decidedBy !== 'validation automatique (Jev)' ||
        !sortedAgain.review.decisionNotes.includes('Jev') || sortedAgain.review.assessment.triage?.probability !== 0.04 ||
        assessments !== assessmentsBefore || (await db.getGenerationJob(sortable.id)).status !== 'completed') {
        throw new Error('reassess --jev did not let Jev approve a subject outside the specialised fields');
      }
      agent.expertReview.jev.enabled = () => false;

      // 8. The autonomous operator counts a held video as waiting, not failed.
      const strategy = await db.saveChannelStrategy({
        objective: 'Expliquer', audience: 'Curieux', contentPillars: ['Science'], cadencePerWeek: 1, videosPerRun: 1,
        defaultFormat: 'explainer', defaultLength: 'short', status: 'active'
      });
      const operator = new AutonomousChannelOperator(db, {
        researchAndPlan: async () => ({ research: {}, plan: [{ topic: 'Intrication quantique', angle: 'a', format: 'explainer', length: 'short' }] }),
        startGenerationJob: async () => ({ id: 'held-job', status: 'queued' }),
        waitForGenerationJob: async jobId => ({ id: jobId, status: 'waiting_expert', details: {} }),
        resumeGenerationJob: async () => { throw new Error('unexpected resume'); }
      });
      const run = await operator.start(strategy);
      await operator.activeRuns.get(run.id);
      const finished = await db.getOperatorRun(run.id);
      if (finished.status !== 'waiting_review' || finished.summary.waitingExpert !== 1 || finished.summary.failed !== 0) {
        throw new Error('The autonomous operator treated a script waiting for an expert as a failure');
      }
    } finally {
      for (const [key, name] of [['mode', 'EXPERT_REVIEW'], ['url', 'EXPERT_REVIEW_WEBHOOK_URL'], ['general', 'NOTIFICATION_WEBHOOK_URL'], ['factCheck', 'AUTO_FACT_CHECK'], ['mention', 'EXPERT_REVIEW_MENTION']]) {
        if (savedEnv[key] === undefined) delete process.env[name]; else process.env[name] = savedEnv[key];
      }
      await db.close();
      await fs.rm(directory, { recursive: true, force: true });
    }

    this.logger.info('Expert review test completed successfully');
  }

  async testAPIValidationAndSecurity() {
    const { YouTubeAutomationAgent } = require('./index');
    const agent = new YouTubeAutomationAgent();

    if (typeof agent.validateGenerateRequestBody !== 'function') {
      throw new Error('validateGenerateRequestBody is not implemented');
    }
    if (typeof agent.requireAPIKey !== 'function') {
      throw new Error('requireAPIKey is not implemented');
    }

    const valid = agent.validateGenerateRequestBody({
      topic: 'Node automation',
      style: 'tutorial'
    });
    if (!valid.valid || valid.value.topic !== 'Node automation') {
      throw new Error('Valid generate request was rejected');
    }

    const invalidTopic = agent.validateGenerateRequestBody({ topic: 123 });
    if (invalidTopic.valid || invalidTopic.status !== 400) {
      throw new Error('Non-string topic was not rejected');
    }

    // The dashboard's "Generate Content Now" button sends an explicit null topic
    // to mean "pick a trending topic for me". null must be accepted, not rejected.
    const dashboardPayload = agent.validateGenerateRequestBody({ topic: null, style: 'story' });
    if (!dashboardPayload.valid) {
      throw new Error(`Dashboard generate payload was rejected: ${dashboardPayload.error}`);
    }
    if (dashboardPayload.value.topic !== null || dashboardPayload.value.style !== 'story') {
      throw new Error('Null topic was not normalised to an auto-selected topic');
    }

    const nullStyle = agent.validateGenerateRequestBody({ topic: 'Node automation', style: null });
    if (!nullStyle.valid || nullStyle.value.style !== null) {
      throw new Error('Null style was not accepted as "no style preference"');
    }

    const nullLength = agent.validateGenerateRequestBody({ topic: null, style: null, length: null });
    if (!nullLength.valid || nullLength.value.length !== 'medium') {
      throw new Error('Null length did not fall back to the default length');
    }

    const blankTopic = agent.validateGenerateRequestBody({ topic: '   ' });
    if (!blankTopic.valid || blankTopic.value.topic !== null) {
      throw new Error('Whitespace-only topic was not normalised to null');
    }

    const invalidStyle = agent.validateGenerateRequestBody({ style: 'x'.repeat(51) });
    if (invalidStyle.valid || invalidStyle.status !== 400) {
      throw new Error('Overlong style was not rejected');
    }

    const previousKey = process.env.API_KEY;
    process.env.API_KEY = 'test-secret';
    const middleware = agent.requireAPIKey();

    let rejectedNextCalled = false;
    const rejectedResponse = this.createMockResponse();
    middleware({ get: () => 'wrong-secret' }, rejectedResponse, () => {
      rejectedNextCalled = true;
    });

    if (rejectedNextCalled || rejectedResponse.statusCode !== 401) {
      throw new Error('Invalid API key was not rejected');
    }

    let acceptedNextCalled = false;
    const acceptedResponse = this.createMockResponse();
    middleware({ get: () => 'test-secret' }, acceptedResponse, () => {
      acceptedNextCalled = true;
    });

    if (!acceptedNextCalled || acceptedResponse.statusCode) {
      throw new Error('Valid API key was not accepted');
    }

    if (previousKey === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = previousKey;
    }

    this.logger.info('API validation and security test completed successfully');
  }

  createMockResponse() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      }
    };
  }

  async testPublishingSafety() {
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const intentionalAudio = {
      intentionalSilence: true,
      silenceReason: 'This test fixture is intentionally silent.',
      silenceConfirmedAt: new Date().toISOString()
    };
    const agent = new PublishingSchedulingAgent({
      updateScheduleEntry: async () => {}
    }, {});

    agent.publishQueue = [
      { productionId: 'prod-a', title: 'A', status: 'scheduled', metadata: { audio: intentionalAudio } },
      { productionId: 'prod-b', title: 'B', status: 'scheduled', metadata: { audio: intentionalAudio } }
    ];
    agent.uploadToYouTube = async () => ({ id: 'youtube-1' });

    await agent.publishContent('prod-a');

    if (agent.publishQueue.length !== 1 || agent.publishQueue[0].productionId !== 'prod-b') {
      throw new Error('publishContent removed the wrong publish queue entries');
    }

    const missingNarration = new PublishingSchedulingAgent({ updateScheduleEntry: async () => {} }, {});
    missingNarration.publishQueue = [{ productionId: 'prod-no-audio', status: 'scheduled', metadata: {} }];
    missingNarration.uploadToYouTube = async () => { throw new Error('Upload must not start without narration'); };
    let narrationPublishBlocked = false;
    try {
      await missingNarration.publishContent('prod-no-audio');
    } catch (error) {
      narrationPublishBlocked = error.code === 'NARRATION_REQUIRED';
    }
    if (!narrationPublishBlocked) throw new Error('Publishing accepted a production without narration evidence');

    let missingFileRejected = false;
    try {
      await agent.getVideoStream(path.join(__dirname, 'data', 'missing-placeholder.mp4'));
    } catch (error) {
      missingFileRejected = /video file not found/.test(error.message);
    }

    if (!missingFileRejected) {
      throw new Error('getVideoStream did not reject a missing video file');
    }

    let uncertainUpdates = [];
    const uncertain = new PublishingSchedulingAgent({
      updateScheduleEntry: async entry => uncertainUpdates.push({ ...entry })
    }, {});
    uncertain.publishQueue = [
      { id: 'schedule-uncertain', productionId: 'prod-uncertain', title: 'Uncertain', status: 'scheduled', metadata: { audio: intentionalAudio } }
    ];
    let uploadAttempts = 0;
    uncertain.uploadToYouTube = async entry => {
      uploadAttempts++;
      entry.uploadAttempted = true;
      const error = new Error('socket closed during upload');
      error.code = 'ECONNRESET';
      throw error;
    };
    let uncertainBlocked = false;
    try {
      await uncertain.publishContent('prod-uncertain');
    } catch (error) {
      uncertainBlocked = error.code === 'UPLOAD_OUTCOME_UNKNOWN';
    }
    try {
      await uncertain.publishContent('prod-uncertain');
    } catch (error) {
      uncertainBlocked = uncertainBlocked && error.code === 'UPLOAD_OUTCOME_UNKNOWN';
    }
    if (!uncertainBlocked || uploadAttempts !== 1 || uncertainUpdates.at(-1)?.status !== 'reconciliation_required') {
      throw new Error('An uncertain upload outcome was retried or failed to require reconciliation');
    }

    let reconciliationCalls = 0;
    const recorded = {
      id: 'schedule-recorded', productionId: 'prod-recorded', title: 'Recorded', status: 'uploaded',
      youtubeId: 'youtube-existing', metadata: { audio: intentionalAudio }
    };
    const reconcile = new PublishingSchedulingAgent({
      getLatestScheduleEntry: async () => recorded,
      updateScheduleEntry: async () => {}
    }, {});
    reconcile.youtube = {
      videos: {
        list: async () => {
          reconciliationCalls++;
          return { data: { items: [{ id: 'youtube-existing' }] } };
        }
      }
    };
    reconcile.uploadToYouTube = async () => {
      throw new Error('A recorded upload must never be uploaded again');
    };
    const reconciled = await reconcile.publishContent('prod-recorded');
    if (reconciled.status !== 'published' || reconciliationCalls !== 1) {
      throw new Error('A recorded YouTube upload was not reconciled idempotently');
    }

    let deletedScheduleId = null;
    const scheduleActions = new PublishingSchedulingAgent({
      updateScheduleEntry: async () => {},
      deleteScheduleEntry: async id => { deletedScheduleId = id; }
    }, {});
    scheduleActions.publishQueue = [{
      id: 'schedule-actions', productionId: 'prod-actions', title: 'Actions', status: 'scheduled',
      publishTime: new Date(Date.now() + 3600000).toISOString(), metadata: { audio: intentionalAudio }
    }];
    const future = new Date(Date.now() + 7200000).toISOString();
    const rescheduled = await scheduleActions.rescheduleContent('prod-actions', future);
    if (rescheduled.publishTime !== future || rescheduled.status !== 'scheduled') {
      throw new Error('Scheduled content could not be rescheduled');
    }
    await scheduleActions.deleteScheduledContent('prod-actions');
    if (deletedScheduleId !== 'schedule-actions' || scheduleActions.publishQueue.length) {
      throw new Error('Deleting a schedule did not preserve content while removing the queue entry');
    }

    let uploadMetadata = null;
    const immediate = new PublishingSchedulingAgent({ updateScheduleEntry: async () => {} }, {});
    immediate.youtube = {
      videos: { insert: async request => { uploadMetadata = request.requestBody; return { data: { id: 'youtube-now' } }; } },
      thumbnails: { set: async () => {} }, captions: { insert: async () => {} }
    };
    immediate.getVideoStream = async () => ({ fixture: true });
    await immediate.uploadToYouTube({
      id: 'schedule-now', publishTime: new Date().toISOString(),
      metadata: { seo: { title: 'Publish now', description: 'Immediate upload.', tags: ['test'] }, video: { path: 'fixture.mp4' }, privacyStatus: 'public' }
    }, { publishNow: true });
    if (uploadMetadata?.status?.privacyStatus !== 'public' || uploadMetadata?.status?.publishAt !== undefined) {
      throw new Error('Publish now still sent a stale scheduled publishAt value');
    }

    this.logger.info('Publishing safety test completed successfully');
  }

  async testCredentialValidation() {
    const { PROVIDERS } = require('./utils/ai-text-service');
    const manager = new CredentialManager();

    // Isolate the test from any API keys set in the environment
    const envKeys = [...Object.values(PROVIDERS).map(p => p.envKey), 'GEMINI_API_KEY'];
    const savedEnv = {};
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      manager.credentials = { youtube: { client_id: 'x' }, gemini: { apiKey: 'gm-test' } };
      if (manager.getMissingCredentials().length !== 0) {
        throw new Error('Gemini-only configuration was incorrectly reported as missing credentials');
      }

      manager.credentials = { youtube: { client_id: 'x' }, aiProvider: { provider: 'openrouter', apiKey: 'sk-or-test' } };
      if (manager.getMissingCredentials().length !== 0) {
        throw new Error('OpenRouter configuration was incorrectly reported as missing credentials');
      }

      manager.credentials = { youtube: { client_id: 'x' } };
      const missingProvider = manager.getMissingCredentials();
      if (missingProvider.length !== 1 || !/AI provider/.test(missingProvider[0])) {
        throw new Error('Missing AI provider was not detected');
      }

      manager.credentials = { openai: { apiKey: 'sk-test' } };
      const missingYouTube = manager.getMissingCredentials();
      if (missingYouTube.length !== 1 || missingYouTube[0] !== 'youtube') {
        throw new Error('Missing YouTube credentials were not detected');
      }
    } finally {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
    }

    this.logger.info('Credential validation test completed successfully');
  }

  async testAITextServiceTokenParams() {
    const { AITextService } = require('./utils/ai-text-service');

    const savedEnv = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const service = new AITextService({
        aiProvider: { provider: 'openai', apiKey: 'test-key', model: 'gpt-5.6' }
      });

      // Newer OpenAI models (gpt-5.x) reject max_tokens — the request must use
      // max_completion_tokens, never the legacy spelling.
      const calls = [];
      service.client.chat.completions.create = async (params) => {
        calls.push(params);
        return { choices: [{ message: { content: '{"ok":true}' } }] };
      };

      const result = await service.generateText('test prompt', { maxTokens: 512 });
      if (result !== '{"ok":true}') throw new Error('generateText did not return the model content');
      if (calls[0].max_completion_tokens !== 512) {
        throw new Error('Modern models must receive max_completion_tokens, not max_tokens');
      }
      if (calls[0].max_tokens !== undefined) {
        throw new Error('Legacy max_tokens must not be sent to modern models');
      }

      // Legacy models reject max_completion_tokens with a 400 — the service must
      // retry the identical request using max_tokens.
      let attempt = 0;
      service.client.chat.completions.create = async (_params) => {
        attempt++;
        if (attempt === 1) {
          const err = new Error("Unsupported parameter: 'max_completion_tokens' is not supported with this model.");
          err.status = 400;
          throw err;
        }
        return { choices: [{ message: { content: 'legacy-ok' } }] };
      };
      const legacyResult = await service.generateText('legacy prompt');
      if (legacyResult !== 'legacy-ok') throw new Error('Legacy fallback did not return content');
      if (attempt !== 2) throw new Error('Expected exactly one retry with max_tokens');

      // An empty model body must surface as a descriptive error, not the cryptic
      // "Unexpected end of JSON input" the agents used to log.
      service.client.chat.completions.create = async () => ({ choices: [{ message: { content: '' } }] });
      let emptyRejected = false;
      try {
        await service.generateText('empty prompt');
      } catch (error) {
        emptyRejected = /empty response/i.test(error.message);
      }
      if (!emptyRejected) {
        throw new Error('Empty response was not rejected with a descriptive error');
      }

      // Gemini 3.5+ rejects/deprecates sampling parameters. Keep the latest
      // Gemini default on the parameter-safe request path.
      const geminiCalls = [];
      const geminiService = Object.create(AITextService.prototype);
      geminiService.gemini = {
        models: {
          generateContent: async (params) => {
            geminiCalls.push(params);
            return { text: 'gemini-ok' };
          }
        }
      };
      geminiService.client = null;
      geminiService.model = 'gemini-3.7-flash';
      geminiService.providerName = 'Google Gemini';

      const geminiResult = await geminiService.generateText('gemini prompt', { temperature: 0.2 });
      if (geminiResult !== 'gemini-ok') throw new Error('Gemini generation did not return content');
      if (geminiCalls[0].config.temperature !== undefined) {
        throw new Error('Gemini 3.7 must not receive the deprecated temperature parameter');
      }
    } finally {
      if (savedEnv === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedEnv;
    }

    this.logger.info('AI text service token parameter test completed successfully');
  }

  async testPlaceholderSchedulingGuard() {
    const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
    const agent = new PublishingSchedulingAgent({
      saveScheduleEntry: async () => {}
    }, {});

    const simulated = await agent.scheduleContent({
      id: 'prod-simulated',
      script: { title: 'Simulated' },
      assets: { finalVideo: { path: 'video.mp4.assembly.json', simulated: true } }
    });
    if (simulated !== null) {
      throw new Error('Simulated production was scheduled for publishing');
    }

    const missingVideo = await agent.scheduleContent({
      id: 'prod-missing',
      script: { title: 'Missing' },
      assets: {}
    });
    if (missingVideo !== null) {
      throw new Error('Production without a final video was scheduled for publishing');
    }

    const missingNarration = await agent.scheduleContent({
      id: 'prod-no-narration', script: { title: 'No narration' }, priority: 50,
      scheduledPublishTime: new Date().toISOString(),
      assets: { finalVideo: { path: 'video.mp4' } }, seo: {}
    });
    if (missingNarration !== null) throw new Error('Production without narration was scheduled for publishing');

    const real = await agent.scheduleContent({
      id: 'prod-real',
      script: { title: 'Real' },
      priority: 50,
      scheduledPublishTime: new Date().toISOString(),
      assets: {
        finalVideo: { path: 'video.mp4' }, thumbnail: {}, captions: {},
        audio: {
          intentionalSilence: true,
          silenceReason: 'This fixture intentionally uses a silent timeline.',
          silenceConfirmedAt: new Date().toISOString()
        }
      },
      seo: {}
    });
    if (!real || agent.publishQueue.length !== 1) {
      throw new Error('Real production was not scheduled for publishing');
    }

    this.logger.info('Placeholder scheduling guard test completed successfully');
  }

  async testFFmpegResolution() {
    const fs = require('fs').promises;
    const os = require('os');
    const { getFFmpegPath, getMediaDuration, checkFFmpeg, runFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');

    const ffmpegPath = getFFmpegPath();
    if (typeof ffmpegPath !== 'string' || ffmpegPath.length === 0) {
      throw new Error('getFFmpegPath did not return a usable path');
    }

    const available = await checkFFmpeg();
    if (typeof available !== 'boolean') {
      throw new Error('checkFFmpeg did not return a boolean');
    }

    if (!/FFmpeg/i.test(ffmpegInstallHint())) {
      throw new Error('ffmpegInstallHint did not return install guidance');
    }

    if (available) {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-duration-'));
      try {
        const audioPath = path.join(directory, 'duration.m4a');
        await runFFmpeg(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audioPath]);
        const duration = await getMediaDuration(audioPath);
        if (duration < 0.9 || duration > 1.2) throw new Error(`Media duration probe returned ${duration}`);
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }

    this.logger.info(`FFmpeg resolution test completed (binary: ${ffmpegPath}, available: ${available})`);
  }

  async testGeminiMediaProvider() {
    const { AIVideoGenerator } = require('./utils/ai-video-generator');
    const fs = require('fs').promises;
    const os = require('os');
    const sharp = require('sharp');

    const envKeys = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'REPLICATE_API_KEY', 'ELEVENLABS_API_KEY'];
    const savedEnv = {};
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-gemini-image-'));
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }

    try {
      const geminiOnly = new AIVideoGenerator({ gemini: { apiKey: 'test-key' } });
      if (!geminiOnly.gemini) {
        throw new Error('Gemini media service was not initialized from gemini credentials');
      }
      if (geminiOnly.openai) {
        throw new Error('OpenAI client initialized without a key');
      }

      const thoughtImage = await sharp({
        create: { width: 64, height: 64, channels: 3, background: '#ff0000' }
      }).jpeg().toBuffer();
      const finalImage = await sharp({
        create: { width: 320, height: 180, channels: 3, background: '#0066ff' }
      }).webp().toBuffer();
      let imageRequest = null;
      geminiOnly.gemini.models.generateContent = async request => {
        imageRequest = request;
        return {
          candidates: [{
            content: {
              parts: [
                { thought: true, inlineData: { mimeType: 'image/jpeg', data: thoughtImage.toString('base64') } },
                { text: 'Rendering the final image.' },
                { inlineData: { mimeType: 'image/webp', data: finalImage.toString('base64') } }
              ]
            }
          }]
        };
      };

      const outputPath = path.join(directory, 'gemini-output.png');
      await geminiOnly.generateGeminiImage('Create a blue widescreen test image', outputPath);
      const metadata = await sharp(outputPath).metadata();
      if (metadata.format !== 'png' || metadata.width !== 320 || metadata.height !== 180) {
        throw new Error('Gemini final image was not selected and normalized to the requested file format');
      }
      if (
        imageRequest?.config?.responseModalities?.[0] !== 'IMAGE' ||
        imageRequest?.config?.imageConfig?.aspectRatio !== '16:9'
      ) {
        throw new Error('Gemini image request did not require a widescreen image response');
      }

      const none = new AIVideoGenerator({});
      if (none.gemini || none.openai) {
        throw new Error('Media services initialized without any credentials');
      }
    } finally {
      for (const key of envKeys) {
        if (savedEnv[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = savedEnv[key];
        }
      }
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }

    this.logger.info('Gemini media provider selection test completed successfully');
  }

  async testSlideshowRenderer() {
    const { AIVideoGenerator } = require('./utils/ai-video-generator');
    const { checkFFmpeg } = require('./utils/ffmpeg');
    const fs = require('fs').promises;
    const os = require('os');

    if (!(await checkFFmpeg())) {
      this.logger.warn('FFmpeg unavailable — skipping slideshow renderer test');
      return;
    }

    const sharp = require('sharp');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-slides-'));

    try {
      const stills = [];
      for (let i = 0; i < 3; i++) {
        const stillPath = path.join(dir, `slide_${i}.png`);
        await sharp({
          create: { width: 320, height: 180, channels: 3, background: { r: 60 * i, g: 80, b: 160 } }
        }).png().toFile(stillPath);
        stills.push(stillPath);
      }

      const generator = new AIVideoGenerator({});
      if (generator.parseDurationSeconds('2:05') !== 125 || generator.parseDurationSeconds('1:02:03') !== 3723) {
        throw new Error('Human-readable production durations are not converted to timeline seconds');
      }

      const embeddedAssets = await generator.filterImageAssets(stills);
      if (embeddedAssets.length !== stills.length || embeddedAssets.some(asset => !asset.startsWith('data:image/png;base64,'))) {
        throw new Error('Slideshow image assets were not embedded as browser-safe image data');
      }
      const { chromium } = require('playwright');
      let browser = null;
      try {
        browser = await chromium.launch();
      } catch (error) {
        if (!/Executable doesn't exist|playwright install/i.test(error.message)) throw error;
        this.logger.warn('Chromium is not installed — verified browser-safe image embedding without the live browser assertion');
      }
      if (browser) {
        try {
          const page = await browser.newPage();
          await page.setContent(generator.createSlideshowHTML({ title: 'Image loading test' }, embeddedAssets));
          const imageState = await page.$$eval('.background-image', images => images.map(image => ({
            complete: image.complete,
            width: image.naturalWidth,
            height: image.naturalHeight
          })));
          if (!imageState.length || imageState.some(image => !image.complete || !image.width || !image.height)) {
            throw new Error('Embedded slideshow images did not load in Chromium');
          }
        } finally {
          await browser.close();
        }
      }

      const videoPath = path.join(dir, 'out.mp4');
      await generator.renderSlidesToVideo(stills, 6, videoPath);

      const stats = await fs.stat(videoPath);
      if (!stats.size) {
        throw new Error('Rendered slideshow video is empty');
      }

      // Missing narration must fail closed unless the operator explicitly confirmed silence.
      const finalPath = path.join(dir, 'final.mp4');
      let missingNarrationBlocked = false;
      try {
        await generator.addAudioToVideo(videoPath, path.join(dir, 'missing.mp3'), finalPath);
      } catch (error) {
        missingNarrationBlocked = error.code === 'NARRATION_REQUIRED';
      }
      if (!missingNarrationBlocked) throw new Error('Missing narration silently produced a final video');
      await generator.addAudioToVideo(videoPath, path.join(dir, 'missing.mp3'), finalPath, { allowSilent: true });
      const finalStats = await fs.stat(finalPath);
      if (!finalStats.size) {
        throw new Error('Explicit intentional-silence assembly did not produce a video');
      }

      const hybridPath = path.join(dir, 'hybrid.mp4');
      await generator.renderMediaTimeline([
        { type: 'video', path: videoPath, duration: 1 },
        { type: 'image', path: stills[0], duration: 1 }
      ], hybridPath);
      const hybridStats = await fs.stat(hybridPath);
      if (!hybridStats.size) throw new Error('Hybrid provider/still timeline did not produce a video');
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    this.logger.info('Slideshow renderer test completed successfully');
  }

  async testEvergreenTopics() {
    const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
    const agent = new ContentStrategyAgent(null, {});
    agent.historicalPerformance = [];

    // Single scraped keywords must never become video topics
    agent.trendingTopics = [{ topic: 'crown', score: 5 }, { topic: 'official', score: 3 }];
    const fallback = agent.selectOptimalTopic();
    if (!fallback.topic.includes(' ') || fallback.topic.length < 8) {
      throw new Error(`Template mode produced a junk topic: "${fallback.topic}"`);
    }

    // A readable multi-word trend should be used when available
    agent.trendingTopics = [{ topic: 'artificial intelligence explained', score: 5 }];
    const readable = agent.selectOptimalTopic();
    if (readable.topic !== 'artificial intelligence explained') {
      throw new Error(`Readable trending topic was not selected: "${readable.topic}"`);
    }

    this.logger.info('Evergreen template topics test completed successfully');
  }

  async testBackgroundMusic() {
    const fs = require('fs').promises;
    const os = require('os');
    const { runFFmpeg, getMediaDuration } = require('./utils/ffmpeg');
    const music = require('./utils/background-music');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yaa-music-'));
    const saved = process.env.BACKGROUND_MUSIC_DIR;
    process.env.BACKGROUND_MUSIC_DIR = path.join(directory, 'music');
    try {
      const tone = (file, hz, seconds) => runFFmpeg(['-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=44100:duration=${seconds}`, '-ac', '2', file]);
      if (await music.mixSoundtrack({ narrationPath: 'x.mp3', segments: [{ register: 'main', duration: 5 }], outputPath: path.join(directory, 'none.flac'), key: 'p' }) !== null) {
        throw new Error('An empty music library must leave the narration alone');
      }
      await fs.mkdir(path.join(directory, 'music', 'main'), { recursive: true });
      await tone(path.join(directory, 'music', 'main', 'dark.mp3'), 110, 3);
      await fs.writeFile(path.join(directory, 'music', 'main', 'dark.txt'), 'Dark by Someone is licensed under CC BY 4.0.\n');
      // No opening folder yet: the opening falls back to the main part's tracks.
      if (!(await music.tracksFor('opening', 'opening'))[0]?.endsWith('dark.mp3')) throw new Error('A phase without tracks must fall back to the other default folder');
      await fs.mkdir(path.join(directory, 'music', 'opening'));
      await tone(path.join(directory, 'music', 'opening', 'warm.mp3'), 220, 4);

      // Any folder of data/music is an ambiance named after it.
      await fs.mkdir(path.join(directory, 'music', 'calme'));
      await tone(path.join(directory, 'music', 'calme', 'soft.mp3'), 330, 2);
      if ((await music.ambiances()).join() !== 'calme,main,opening') throw new Error(`Unexpected ambiances: ${await music.ambiances()}`);

      const runs = (segments, minimum, available = ['calme', 'main', 'opening']) => JSON.stringify(music.musicRuns(segments, { minSeconds: minimum, available }).map(run => [run.ambiance, run.start, run.end]));
      const segments = [
        { position: 0, register: 'opening', duration: 5 },
        { position: 1, register: 'main', duration: 4, ambiance: 'calme' },
        { position: 2, register: 'main', duration: 3 }
      ];
      if (runs(segments, 2) !== JSON.stringify([['opening', 0, 5], ['calme', 5, 9], ['main', 9, 12]])) throw new Error(`Unexpected runs: ${runs(segments, 2)}`);
      // Runs too short to settle join their neighbour in the same phase (the shortest first).
      if (runs(segments, 60) !== JSON.stringify([['opening', 0, 5], ['calme', 5, 12]])) throw new Error(`Short runs must join their neighbour: ${runs(segments, 60)}`);
      // The main part never opens on the opening's ambiance: the turn always changes the music.
      const same = [{ position: 0, register: 'opening', duration: 5, ambiance: 'calme' }, { position: 1, register: 'main', duration: 7, ambiance: 'calme' }];
      if (runs(same, 2) !== JSON.stringify([['calme', 0, 5], ['main', 5, 12]])) throw new Error(`The turn must change the music: ${runs(same, 2)}`);

      // Without opening/ or main/ folders: a scene without a choice takes its neighbour's ambiance, the turn
      // still changes the music, and a short ambiance joins its neighbour.
      const noDefaults = ['calme', 'optimiste', 'triste'];
      const inherit = [{ position: 0, register: 'opening', duration: 5 }, { position: 1, register: 'opening', duration: 70, ambiance: 'calme' }, { position: 2, register: 'main', duration: 80, ambiance: 'triste' }];
      if (runs(inherit, 60, noDefaults) !== JSON.stringify([['calme', 0, 75], ['triste', 75, 155]])) throw new Error(`Unexpected inheritance: ${runs(inherit, 60, noDefaults)}`);
      const turn = [{ position: 0, register: 'opening', duration: 70, ambiance: 'calme' }, { position: 1, register: 'main', duration: 80, ambiance: 'calme' }, { position: 2, register: 'main', duration: 70, ambiance: 'triste' }];
      if (runs(turn, 60, noDefaults) !== JSON.stringify([['calme', 0, 70], ['triste', 70, 220]])) throw new Error(`The turn must change the music: ${runs(turn, 60, noDefaults)}`);
      const absorb = [{ position: 0, register: 'opening', duration: 70, ambiance: 'calme' }, { position: 1, register: 'main', duration: 80, ambiance: 'triste' }, { position: 2, register: 'main', duration: 20, ambiance: 'optimiste' }, { position: 3, register: 'main', duration: 70, ambiance: 'triste' }];
      if (runs(absorb, 60, noDefaults) !== JSON.stringify([['calme', 0, 70], ['triste', 70, 240]])) throw new Error(`A short ambiance must join its neighbour: ${runs(absorb, 60, noDefaults)}`);
      // macOS stores accented folder names decomposed; the model writes them composed.
      const decomposed = 'cole\u0301rique';
      if (runs([{ position: 0, register: 'main', duration: 70, ambiance: 'colérique' }], 60, [decomposed]) !== JSON.stringify([[decomposed, 0, 70]])) throw new Error('A composed ambiance name must match its decomposed folder');

      // Only known ambiances are taken from the model's answer, matched whatever their Unicode form.
      const aiText = { lightModel: () => 'light', generateText: async () => '[{"scene":1,"ambiance":"calme"},{"scene":2,"ambiance":"inconnue"},{"scene":3,"ambiance":"colérique"}]' };
      const choices = await music.chooseAmbiances({ aiText, segments, names: ['calme', 'main', 'opening', decomposed] });
      if (JSON.stringify([...choices]) !== JSON.stringify([[0, 'calme'], [2, decomposed]])) throw new Error(`Unexpected ambiance choices: ${JSON.stringify([...choices])}`);

      const narration = path.join(directory, 'voice.mp3');
      await runFFmpeg(['-y', '-f', 'lavfi', '-i', "aevalsrc='0.5*sin(2*PI*180*t)*gt(sin(2*PI*0.4*t)\\,0.2)':s=48000:d=12", '-ac', '1', narration]);
      const result = await music.mixSoundtrack({ narrationPath: narration, segments, outputPath: path.join(directory, 'mix.flac'), key: 'prod_1', minSeconds: 2 });
      if (JSON.stringify(result.tracks.map(track => [track.file, track.ambiance])) !== JSON.stringify([['warm.mp3', 'opening'], ['soft.mp3', 'calme'], ['dark.mp3', 'main']])) {
        throw new Error(`Unexpected music tracks: ${JSON.stringify(result.tracks)}`);
      }
      if (result.credits.join() !== 'Dark by Someone is licensed under CC BY 4.0.') throw new Error('Track attribution was not read');
      // Looped tracks shorter than their runs, crossfaded: the soundtrack keeps the narration length exactly.
      const [before, after] = [await getMediaDuration(narration), await getMediaDuration(result.path)];
      if (Math.abs(before - after) > 0.05) throw new Error(`Soundtrack length ${after} s does not match the narration (${before} s)`);
    } finally {
      if (saved === undefined) delete process.env.BACKGROUND_MUSIC_DIR;
      else process.env.BACKGROUND_MUSIC_DIR = saved;
      await fs.rm(directory, { recursive: true, force: true });
    }
    this.logger.info('Background music test completed successfully');
  }

  async testVisualInserts() {
    const { findAnchor, anchorSeconds, cardWindow, selectCards, holdSeconds, MIN_GAP_SECONDS } = require('./agents/visual-insert-agent');
    const { sanitizeMathML } = require('./utils/insert-cards');
    const { verseNumbers, bookKey, BOOK_NUMBERS, sameSubject } = require('./utils/insert-sources');
    const assert = (condition, message) => { if (!condition) throw new Error(message); };

    // Anchors are matched on the spoken tokens, ignoring case, accents, apostrophes and lone punctuation.
    const tokens = "Ouvre le traité à la page vingt-trois , lignes douze à quatorze . En traduction littérale : Nous avons réparé l'horloge".split(' ');
    assert(findAnchor(tokens, 'la page vingt-trois, lignes douze') === 4, 'Anchor with punctuation was not found');
    assert(findAnchor(tokens, "nous avons repare l'horloge") === 17, 'Accent-insensitive anchor was not found');
    assert(findAnchor(tokens, 'la page vingt-trois lignes onze') === 4, 'An anchor with one altered word should fall back to its unique opening');
    assert(findAnchor(tokens, 'le poisson rouge') === -1, 'An anchor absent from the narration must not match');
    const words = tokens.map((text, index) => ({ text, start: index * 0.5, end: index * 0.5 + 0.4 }));
    assert(anchorSeconds('', 20, words, 'Nous avons réparé') === 8.5, 'Word timings must give the anchor time');
    const estimated = anchorSeconds('un deux trois quatre', 8, null, 'trois quatre');
    assert(estimated > 2.5 && estimated < 3.5, `Estimated anchor time is off: ${estimated}`);

    // Windows avoid the opening chapter card, and cards too far from their anchor or too short are dropped.
    const shifted = cardWindow({ anchorAt: 3, hold: 6, sceneDuration: 60, openingCard: 4 });
    assert(shifted && Math.abs(shifted.start - 4.3) < 1e-9 && Math.abs(shifted.end - 10.3) < 1e-9, 'Card must start after the chapter card');
    assert(cardWindow({ anchorAt: 0.5, hold: 6, sceneDuration: 60, openingCard: 4 })?.start === 4.3, 'A subject introduced under the chapter card must wait for it');
    assert(cardWindow({ anchorAt: 0, hold: 6, sceneDuration: 60, openingCard: 5 }) === null, 'A card delayed far past its anchor must be dropped');
    assert(cardWindow({ anchorAt: 58, hold: 6, sceneDuration: 60, openingCard: 0 }) === null, 'A card cut short by the scene end must be dropped');

    // Selection: what must be shown wins a conflict, cards keep a background gap, and the total is capped.
    const kept = selectCards([
      { kind: 'figure', at: 10, until: 15 },
      { kind: 'verse', at: 14, until: 22 },
      { kind: 'person', at: 22 + MIN_GAP_SECONDS + 1, until: 36 }
    ], 200);
    assert(kept.map(card => card.kind).join(',') === 'verse,person', `Unexpected selection: ${kept.map(card => card.kind)}`);
    const capped = selectCards(Array.from({ length: 10 }, (_, i) => ({ kind: 'image', at: i * 20, until: i * 20 + 6 })), 200);
    assert(capped.reduce((sum, card) => sum + card.until - card.at, 0) <= 60, 'Cards exceed the share of the running time');
    assert(holdSeconds({ kind: 'verse', verses: [{ text: 'mot '.repeat(200) }] }) === 12, 'Long verses must be capped');

    // Only MathML presentation markup is rendered.
    const math = sanitizeMathML('<math onclick="x()"><mi mathvariant="normal">E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math>');
    assert(math && !math.includes('onclick') && math.startsWith('<math display="block">'), 'MathML was not cleaned');
    assert(sanitizeMathML('<math><mi>x</mi><script>alert(1)</script></math>') === null, 'Script inside MathML must be rejected');
    assert(sanitizeMathML('<div>E = mc2</div>') === null, 'Non-MathML markup must be rejected');

    // Scripture references and Wikipedia search hits.
    assert(verseNumbers('12-14').join() === '12,13,14' && verseNumbers('3, 16').join() === '3,16', 'Verse ranges were misread');
    assert(BOOK_NUMBERS.get(bookKey('Ésaïe')) === 23 && BOOK_NUMBERS.get(bookKey('I Corinthiens')) === 46 && BOOK_NUMBERS.get(bookKey('1Corinthiens')) === 46 && BOOK_NUMBERS.get(bookKey('Apocalypse')) === 66, 'Bible book lookup failed');
    assert(sameSubject('Lorenzo Valla', 'Laurent Valla') && !sameSubject('Keith L. Moore', 'Paroi abdominale'), 'Search hit check failed');

    this.logger.info('Visual inserts test completed successfully');
  }

  async testWalkthroughModule() {
    const { SetupWalkthrough, AI_PROVIDER_GUIDE, VIDEO_PROVIDER_GUIDE } = require('./walkthrough');
    const { PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL } = require('./utils/ai-text-service');

    const walkthrough = new SetupWalkthrough();
    if (typeof walkthrough.run !== 'function') {
      throw new Error('SetupWalkthrough.run is not implemented');
    }

    // Every guided provider must be complete and coherent
    for (const [id, guide] of Object.entries(AI_PROVIDER_GUIDE)) {
      for (const field of ['label', 'keyUrl', 'instructions', 'models', 'defaultModel', 'save', 'validationCreds']) {
        if (!guide[field]) {
          throw new Error(`Provider guide "${id}" is missing "${field}"`);
        }
      }
      if (!guide.models.includes(guide.defaultModel)) {
        throw new Error(`Provider guide "${id}" default model is not in its model list`);
      }

      // save() must produce credentials that pass validation
      const credentials = {};
      guide.save(credentials, 'test-key', guide.defaultModel);
      const manager = new CredentialManager();
      manager.credentials = { youtube: { client_id: 'x' }, ...credentials };

      const envKeys = [...Object.values(PROVIDERS).map(p => p.envKey), 'GEMINI_API_KEY'];
      const savedEnv = {};
      for (const key of envKeys) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
      }
      try {
        if (manager.getMissingCredentials().length !== 0) {
          throw new Error(`Provider guide "${id}" save() output fails credential validation`);
        }
      } finally {
        for (const key of envKeys) {
          if (savedEnv[key] === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = savedEnv[key];
          }
        }
      }
    }

    if (
      JSON.stringify(AI_PROVIDER_GUIDE.gemini.models) !== JSON.stringify(GEMINI_MODELS) ||
      AI_PROVIDER_GUIDE.gemini.defaultModel !== GEMINI_DEFAULT_MODEL
    ) {
      throw new Error('Walkthrough Gemini models drifted from the runtime catalog');
    }

    for (const id of Object.keys(PROVIDERS)) {
      if (JSON.stringify(AI_PROVIDER_GUIDE[id].models) !== JSON.stringify(PROVIDERS[id].models)) {
        throw new Error(`Walkthrough provider "${id}" models drifted from the runtime catalog`);
      }
    }

    for (const id of ['slideshow', 'seedance', 'minimax_h3', 'google_omni', 'kling', 'wan']) {
      const guide = VIDEO_PROVIDER_GUIDE[id];
      if (!guide?.label) throw new Error(`Walkthrough is missing video provider "${id}"`);
      if (id !== 'slideshow') {
        const credentials = {};
        guide.save(credentials, 'test-key', 'test-secret');
        if (!Object.keys(credentials).length || !guide.keyUrl || !guide.credentialName) {
          throw new Error(`Video provider guide "${id}" cannot save its credentials`);
        }
      }
    }

    const currentOpenRouterModels = [
      'openai/gpt-5.6-sol',
      'anthropic/claude-fable-5',
      'google/gemini-3.7-flash',
      'moonshotai/kimi-k3',
      'z-ai/glm-5.3'
    ];
    if (JSON.stringify(PROVIDERS.openrouter.models) !== JSON.stringify(currentOpenRouterModels)) {
      throw new Error('OpenRouter curated models are not the verified current catalog');
    }

    this.logger.info('Walkthrough module test completed successfully');
  }

  async testLogger() {
    const testLogger = new Logger('TestLogger');
    
    testLogger.info('Test info message');
    testLogger.warn('Test warning message');
    testLogger.success('Test success message');
    
    // Test timer
    const timer = testLogger.startTimer('Test Operation');
    await new Promise(resolve => setTimeout(resolve, 100));
    timer.end();
    
    this.logger.info('Logger test completed successfully');
  }

  async testDirectories() {
    const fs = require('fs').promises;
    
    const requiredDirs = [
      'config',
      'logs', 
      'data',
      'agents',
      'database',
      'utils',
      'schedules'
    ];

    for (const dir of requiredDirs) {
      const dirPath = path.join(__dirname, dir);
      await fs.access(dirPath);
    }

    this.logger.info('Directory structure test completed successfully');
  }

  async testAgentLoading() {
    // Test that agent files can be loaded
    const agentFiles = [
      './agents/content-strategy-agent',
      './agents/script-writer-agent',
      './agents/thumbnail-designer-agent',
      './agents/seo-optimizer-agent',
      './agents/production-management-agent',
      './agents/publishing-scheduling-agent',
      './agents/analytics-optimization-agent',
      './utils/discoverability-service',
      './utils/discoverability-adapters/darkzseo'
    ];

    for (const agentFile of agentFiles) {
      try {
        require(agentFile);
      } catch (error) {
        throw new Error(`Failed to load ${agentFile}: ${error.message}`);
      }
    }

    this.logger.info('Agent loading test completed successfully');
  }

  async testYouTubeScopeDetection() {
    const manager = new CredentialManager();
    const forceSsl = 'https://www.googleapis.com/auth/youtube.force-ssl';
    manager.tokens = { youtube: { scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube' } };
    if (manager.hasYouTubeScope(forceSsl)) throw new Error('force-ssl must not be reported before consent');
    if (!manager.hasYouTubeScope('https://www.googleapis.com/auth/youtube')) throw new Error('Granted scopes must be detected');
    manager.tokens.youtube.scope += ` ${forceSsl}`;
    if (!manager.hasYouTubeScope(forceSsl)) throw new Error('force-ssl must be detected after consent');
    manager.tokens = {};
    if (manager.hasYouTubeScope('https://www.googleapis.com/auth/youtube')) throw new Error('Missing tokens must report no scopes');
  }

  async testReplyDraftStore() {
    const db = new Database();
    await db.initialize();
    const commentId = `rc_test_${Date.now()}`;
    const videoId = `vid_reply_${Date.now()}`;
    try {
      const draft = await db.saveReplyDraft({ commentId, videoId, draftText: 'Thanks! The cache works per scene.', rationale: 'Direct question' });
      if (!draft || draft.status !== 'proposed') throw new Error('saveReplyDraft did not create a proposed draft');

      const edited = await db.updateReplyDraft(draft.id, { editedText: 'Thanks! Each scene caches separately.' });
      if (edited.editedText !== 'Thanks! Each scene caches separately.') throw new Error('editedText was not persisted');

      const replaced = await db.saveReplyDraft({ commentId, videoId, draftText: 'New draft text' });
      if (replaced.id !== draft.id) throw new Error('Re-drafting must reuse the comment row');
      if (replaced.editedText !== null || replaced.status !== 'proposed') throw new Error('Re-drafting must reset the lifecycle');

      const postedAt = new Date().toISOString();
      await db.updateReplyDraft(draft.id, { status: 'posted', postedCommentId: 'yt_reply_1', postedAt });
      const posted = await db.getReplyDraft(draft.id);
      if (posted.status !== 'posted' || posted.postedCommentId !== 'yt_reply_1') throw new Error('Posting evidence was not stored');

      let blocked = false;
      try {
        await db.saveReplyDraft({ commentId, videoId, draftText: 'Should not overwrite' });
      } catch (error) {
        blocked = error.status === 409;
      }
      if (!blocked) throw new Error('A posted reply draft must never be replaced');

      const postedCount = await db.countReplyDraftsPostedSince(new Date(Date.now() - 60000).toISOString());
      if (postedCount < 1) throw new Error('countReplyDraftsPostedSince missed the posted draft');

      const listed = await db.listReplyDrafts({ videoId, status: 'posted' });
      if (listed.length !== 1) throw new Error('listReplyDrafts filter failed');
    } finally {
      await db.executeQuery('DELETE FROM reply_drafts WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testEngagementInsightStore() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_insight_${Date.now()}`;
    try {
      const synced = await db.saveEngagementInsight({
        videoId, title: 'Test video', commentCount: 4,
        lastSyncedAt: '2026-08-23T10:00:00.000Z',
        newestCommentAt: '2026-08-23T09:00:00.000Z'
      });
      if (!synced || synced.videoId !== videoId) throw new Error('saveEngagementInsight did not store the row');

      const analyzed = await db.saveEngagementInsight({
        videoId, analyzedCount: 4,
        sentiment: { method: 'ai', positive: 3, neutral: 1, negative: 0 },
        themes: [{ title: 'Render cache questions', summary: 'Viewers ask how caching works', kind: 'question', count: 3, commentIds: ['a', 'b', 'c'] }],
        attentionFlags: [{ commentId: 'x', categories: ['scam'], permalink: 'https://www.youtube.com/watch?v=1&lc=x' }],
        analysisMethod: 'ai', analyzedAt: '2026-08-23T10:05:00.000Z'
      });
      if (analyzed.id !== synced.id) throw new Error('Insight upsert must reuse the video row, not duplicate');
      if (analyzed.lastSyncedAt !== '2026-08-23T10:00:00.000Z') throw new Error('Merge lost the sync watermark');
      if (analyzed.themes[0]?.count !== 3 || analyzed.sentiment.positive !== 3) throw new Error('JSON columns did not round-trip');
      if (analyzed.attentionFlags.length !== 1) throw new Error('attention_flags did not round-trip');

      const listed = await db.listEngagementInsights({ limit: 5 });
      if (!listed.some(item => item.videoId === videoId)) throw new Error('listEngagementInsights missed the row');
    } finally {
      await db.executeQuery('DELETE FROM engagement_insights WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testAudienceCommentStore() {
    const db = new Database();
    await db.initialize();
    const commentId = `ac_test_${Date.now()}`;
    const videoId = `vid_test_${Date.now()}`;
    try {
      const first = await db.upsertAudienceComment({
        commentId, videoId,
        text: 'How does the render cache work?',
        authorName: 'Viewer One', authorChannelId: 'UC_viewer_1',
        likeCount: 3, replyCount: 0,
        publishedAt: new Date().toISOString()
      });
      if (!first || first.commentId !== commentId) throw new Error('upsertAudienceComment did not store the comment');
      if (first.isChannelOwner !== false || first.repliedByAgent !== false) throw new Error('Boolean parsing is wrong');

      const second = await db.upsertAudienceComment({
        commentId, videoId, text: 'How does the render cache work? (edited)', likeCount: 5
      });
      if (second.id !== first.id) throw new Error('Re-syncing the same comment must upsert, not duplicate');
      if (second.likeCount !== 5 || !second.text.includes('(edited)')) throw new Error('Upsert did not refresh mutable fields');

      const flagged = await db.setAudienceCommentAnalysis(commentId, ['question']);
      if (flagged.analysisState !== 'analyzed' || !flagged.flags.includes('question')) throw new Error('Analysis flags were not persisted');

      const listed = await db.listAudienceComments({ videoId, topLevelOnly: true });
      if (listed.length !== 1) throw new Error('listAudienceComments missed the top-level comment');

      const counts = await db.countAudienceComments(videoId);
      if (counts.total !== 1 || counts.topLevel !== 1) throw new Error('countAudienceComments returned wrong counts');

      const replied = await db.markAudienceCommentReplied(commentId);
      if (!replied.repliedByAgent) throw new Error('markAudienceCommentReplied did not persist');
    } finally {
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testConfiguration() {
    const fs = require('fs').promises;
    
    // Check package.json
    const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
    if (!packageJson.name || !packageJson.dependencies) {
      throw new Error('Invalid package.json');
    }

    // Check if main index file exists
    await fs.access('./index.js');

    // The startup banner must report the real version. It was hardcoded to "v2.0"
    // through v2.4.0, so bug reports pasted a version that was four releases stale.
    const indexSource = await fs.readFile('index.js', 'utf8');
    const hardcodedBanner = indexSource.match(/YouTube Automation Agent v[\d.]/);
    if (hardcodedBanner) {
      throw new Error(
        `Startup banner hardcodes a version ("${hardcodedBanner[0]}") — interpolate package.json's version instead`
      );
    }
    if (!indexSource.includes('YouTube Automation Agent v${version}')) {
      throw new Error('Startup banner does not report the package.json version');
    }

    // package.json and package-lock.json drifted apart before v2.4.1; keep them aligned
    const lockJson = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
    if (lockJson.version !== packageJson.version) {
      throw new Error(
        `package-lock.json version (${lockJson.version}) does not match package.json (${packageJson.version})`
      );
    }

    this.logger.info('Configuration test completed successfully');
  }

  async testAudienceCommentSync() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_sync_${Date.now()}`;
    const iso = offsetMinutes => new Date(Date.now() - offsetMinutes * 60000).toISOString();
    const thread = (id, publishedAt, replies = []) => ({
      id,
      snippet: {
        totalReplyCount: replies.length,
        topLevelComment: { id, snippet: {
          textOriginal: `Comment ${id}`, authorDisplayName: 'Viewer',
          authorChannelId: { value: 'UC_viewer' }, likeCount: 1, publishedAt, updatedAt: publishedAt
        } }
      },
      replies: { comments: replies }
    });
    try {
      const pages = [
        { items: [thread(`${videoId}_c2`, iso(5)), thread(`${videoId}_c1`, iso(60), [{
            id: `${videoId}_c1_r1`, snippet: {
              textOriginal: 'A reply', authorDisplayName: 'Owner',
              authorChannelId: { value: 'UC_channel_owner' }, likeCount: 0, publishedAt: iso(30), updatedAt: iso(30)
            }
          }]) ] }
      ];
      const service = new AudienceEngagementService(db, null, null, {
        listCommentThreads: async () => pages[0],
        getChannelId: async () => 'UC_channel_owner'
      });

      const first = await service.syncVideoComments(videoId, { title: 'Sync test' });
      if (first.fetched !== 3) throw new Error(`Expected 3 stored comments, got ${first.fetched}`);
      if (!first.insight?.newestCommentAt) throw new Error('Sync did not record the watermark');
      const ownerReply = await db.getAudienceComment(`${videoId}_c1_r1`);
      if (!ownerReply.isChannelOwner || ownerReply.parentCommentId !== `${videoId}_c1`) throw new Error('Reply mapping is wrong');

      const second = await service.syncVideoComments(videoId, {});
      if (second.fetched !== 0) throw new Error('Watermark must stop re-ingesting known comments');

      // Refusal policy: API failure stores nothing and rethrows
      const failing = new AudienceEngagementService(db, null, null, {
        listCommentThreads: async () => { throw new Error('quota exceeded'); },
        getChannelId: async () => 'UC_channel_owner'
      });
      let threw = false;
      try { await failing.syncVideoComments(`${videoId}_other`, {}); } catch (_error) { threw = true; }
      if (!threw) throw new Error('API failure must throw');
      if (await db.getEngagementInsight(`${videoId}_other`)) throw new Error('A failed sync must store nothing');

      // Disabled comments are not an error
      const disabledError = new Error('disabled');
      disabledError.errors = [{ reason: 'commentsDisabled' }];
      const disabledService = new AudienceEngagementService(db, null, null, {
        listCommentThreads: async () => { throw disabledError; },
        getChannelId: async () => 'UC_channel_owner'
      });
      const disabled = await disabledService.syncVideoComments(`${videoId}_disabled`, {});
      if (!disabled.disabled || disabled.fetched !== 0) throw new Error('commentsDisabled must be recorded, not thrown');

      // Taper
      if (service.isSyncDue(null, iso(0))) { /* never-synced is due */ } else throw new Error('Never-synced video must be due');
      const fresh = { lastSyncedAt: iso(60) };
      if (service.isSyncDue(fresh, iso(24 * 60))) throw new Error('A 1h-stale sync of a 1-day-old video is not due (4h taper)');
      if (!service.isSyncDue({ lastSyncedAt: iso(5 * 60) }, iso(24 * 60))) throw new Error('A 5h-stale sync of a 1-day-old video is due');
      if (service.isSyncDue({ lastSyncedAt: iso(13 * 60) }, iso(40 * 24 * 60))) throw new Error('Videos older than 30 days are never auto-due');
    } finally {
      await db.executeQuery("DELETE FROM audience_comments WHERE video_id LIKE ?", [`${videoId}%`]);
      await db.executeQuery("DELETE FROM engagement_insights WHERE video_id LIKE ?", [`${videoId}%`]);
      await db.close();
    }
  }

  async testAudienceCommentAnalysis() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_analysis_${Date.now()}`;
    const seed = async (suffix, text, likeCount = 0) => db.upsertAudienceComment({
      commentId: `${videoId}_${suffix}`, videoId, text, likeCount,
      publishedAt: new Date().toISOString()
    });
    try {
      await seed('q1', 'How do I configure the render cache?', 4);
      await seed('q2', 'Can you explain the cache setup?', 2);
      await seed('q3', 'What cache settings do you use?', 1);
      await seed('scam1', 'Congratulations! Message me on telegram to claim your prize');
      const aiResponse = JSON.stringify({
        comments: [
          { commentId: `${videoId}_q1`, sentiment: 'positive', flags: ['question'] },
          { commentId: `${videoId}_q2`, sentiment: 'neutral', flags: ['question'] },
          { commentId: `${videoId}_q3`, sentiment: 'neutral', flags: ['question'] },
          { commentId: `${videoId}_scam1`, sentiment: 'neutral', flags: ['scam'] },
          { commentId: 'not_a_real_comment', sentiment: 'negative', flags: ['toxic'] }
        ],
        themes: [
          { title: 'Render cache setup', summary: 'Viewers want a cache configuration walkthrough', kind: 'question',
            commentIds: [`${videoId}_q1`, `${videoId}_q2`, `${videoId}_q3`, `${videoId}_scam1`, 'not_a_real_comment'] },
          { title: 'Bad theme', summary: 'Only one supporter', kind: 'feedback', commentIds: [`${videoId}_q1`] }
        ]
      });
      const service = new AudienceEngagementService(db, null, {
        isAvailable: () => true,
        generateText: async () => aiResponse
      }, {});

      const insight = await service.analyzeVideo(videoId);
      if (insight.analysisMethod !== 'ai') throw new Error('AI analysis was not recorded as ai');
      if (insight.sentiment.positive !== 1 || insight.sentiment.neutral !== 3) throw new Error('Sentiment counts are wrong');
      if (insight.themes.length !== 1) throw new Error('Theme normalization must drop single-comment themes');
      if (insight.themes[0].count !== 3) throw new Error('Quarantined and unknown comment ids must not count toward themes');
      if (insight.attentionFlags.length !== 1 || insight.attentionFlags[0].commentId !== `${videoId}_scam1`) {
        throw new Error('Scam comment must land in attentionFlags');
      }
      const scam = await db.getAudienceComment(`${videoId}_scam1`);
      if (!scam.flags.includes('scam')) throw new Error('Per-comment flags were not stored');

      // parseAIJsonResponse handles fenced, embedded, and malformed output
      if (service.parseAIJsonResponse('```json\n{"a":1}\n```')?.a !== 1) throw new Error('Fenced JSON must parse');
      if (service.parseAIJsonResponse('noise before [1,2] noise after')?.[0] !== 1) throw new Error('Embedded arrays must parse');
      if (service.parseAIJsonResponse('not json at all') !== null) throw new Error('Garbage must return null');

      // Fallback: mechanical facts only, no themes
      const fallbackVideo = `${videoId}_fb`;
      await db.upsertAudienceComment({ commentId: `${fallbackVideo}_c1`, videoId: fallbackVideo, text: 'Is this real?', publishedAt: new Date().toISOString() });
      const fallbackService = new AudienceEngagementService(db, null, { isAvailable: () => false }, {});
      const fallback = await fallbackService.analyzeVideo(fallbackVideo);
      if (fallback.analysisMethod !== 'fallback') throw new Error('Fallback method was not recorded');
      if (fallback.themes.length !== 0) throw new Error('Fallback must never invent themes');
      if (fallback.sentiment.method !== 'fallback' || 'positive' in fallback.sentiment) throw new Error('Fallback must not claim sentiment');
      const fallbackComment = await db.getAudienceComment(`${fallbackVideo}_c1`);
      if (!fallbackComment.flags.includes('question')) throw new Error('Fallback question detection failed');

      // syncDueVideos delegates and analyzes only after a fetching sync
      let analyzeCalls = 0;
      const dueService = new AudienceEngagementService(db, null, { isAvailable: () => false }, {
        listCommentThreads: async () => ({ items: [] })
      });
      dueService.analyzeVideo = async () => { analyzeCalls++; };
      const results = await dueService.syncDueVideos([
        { youtubeId: `${videoId}_due`, title: 'Due', publishedAt: new Date().toISOString(), productionId: null },
        { youtubeId: null }
      ]);
      if (results.synced !== 1 || results.skipped !== 1) throw new Error(`syncDueVideos counters are wrong: ${JSON.stringify(results)}`);
      if (analyzeCalls !== 0) throw new Error('A sync that fetched nothing must not trigger analysis');
    } finally {
      await db.executeQuery("DELETE FROM learning_recommendations WHERE category = 'audience_demand' AND evidence LIKE ?", [`%${videoId}%`]);
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id LIKE ?', [`${videoId}%`]);
      await db.executeQuery('DELETE FROM engagement_insights WHERE video_id LIKE ?', [`${videoId}%`]);
      await db.close();
    }
  }

  async testAudienceIdeaMining() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_mining_${Date.now()}`;
    try {
      for (const suffix of ['m1', 'm2', 'm3']) {
        await db.upsertAudienceComment({
          commentId: `${videoId}_${suffix}`, videoId,
          text: `Please cover local caching next (${suffix})`, publishedAt: new Date().toISOString()
        });
      }
      const service = new AudienceEngagementService(db, null, null, {});
      const insight = {
        videoId, title: 'Mining test', analysisMethod: 'ai',
        themes: [
          { title: 'Cover local caching', summary: 'Repeated requests for a caching deep-dive', kind: 'request',
            count: 3, commentIds: [`${videoId}_m1`, `${videoId}_m2`, `${videoId}_m3`] },
          { title: 'Too few asks', summary: 'Only two', kind: 'request', count: 2, commentIds: [`${videoId}_m1`, `${videoId}_m2`] },
          { title: 'Praise cluster', summary: 'Nice video', kind: 'praise', count: 5, commentIds: [`${videoId}_m1`, `${videoId}_m2`, `${videoId}_m3`] }
        ]
      };
      const saved = await service.refreshAudienceRecommendations(videoId, insight);
      if (saved.length !== 1) throw new Error(`Only the >=3 request/question theme may mine an idea; got ${saved.length}`);
      const recommendation = saved[0];
      if (recommendation.category !== 'audience_demand') throw new Error('Category must be audience_demand');
      if (recommendation.status !== 'pending') throw new Error('Mined ideas must be pending until reviewed');
      if (recommendation.confidence !== 'low') throw new Error('Ask-count 3 maps to low confidence');
      const evidence = recommendation.evidence; // parseLearningRecommendation returns it already parsed
      if (evidence.askCount !== 3 || evidence.sampleComments.length !== 3) throw new Error('Evidence is incomplete');
      if (!evidence.sampleComments[0].permalink.includes('&lc=')) throw new Error('Evidence must carry comment permalinks');
      if (recommendation.proposedChange.autoEditPublishedContent !== false) throw new Error('autoEditPublishedContent must be false');

      const again = await service.refreshAudienceRecommendations(videoId, insight);
      if (again[0].id !== recommendation.id) throw new Error('Re-analysis must dedupe by fingerprint, not duplicate');

      const nonAI = await service.refreshAudienceRecommendations(videoId, { ...insight, analysisMethod: 'fallback' });
      if (nonAI.length !== 0) throw new Error('Fallback analysis must never mine ideas');
    } finally {
      await db.executeQuery("DELETE FROM learning_recommendations WHERE category = 'audience_demand' AND evidence LIKE ?", [`%${videoId}%`]);
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testReplyDrafting() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_draft_${Date.now()}`;
    const seed = (suffix, text, flags, extra = {}) => db.upsertAudienceComment({
      commentId: `${videoId}_${suffix}`, videoId, text,
      publishedAt: new Date().toISOString(), ...extra
    }).then(() => db.setAudienceCommentAnalysis(`${videoId}_${suffix}`, flags));
    try {
      await seed('q1', 'How long does a render take?', ['question']);
      await seed('praise1', 'Great video!', ['praise']);
      await seed('scam1', 'Claim your prize now', ['scam']);
      await seed('own1', 'Thanks all!', [], { isChannelOwner: true });
      await db.upsertAudienceComment({
        commentId: `${videoId}_nested`, videoId, parentCommentId: `${videoId}_q1`,
        text: 'Also curious?', publishedAt: new Date().toISOString()
      });
      await db.saveEngagementInsight({ videoId, title: 'Draft test', analysisMethod: 'ai', analyzedAt: new Date().toISOString() });

      let promptSeen = '';
      const service = new AudienceEngagementService(db, null, {
        isAvailable: () => true,
        generateText: async prompt => {
          promptSeen = prompt;
          return JSON.stringify([
            { commentId: `${videoId}_q1`, reply: 'About two minutes per scene on default settings.', rationale: 'Direct question' },
            { commentId: `${videoId}_praise1`, reply: 'Visit http://spam.example now', rationale: 'Link should be dropped' },
            { commentId: `${videoId}_scam1`, reply: 'Should never appear', rationale: 'Quarantined' }
          ]);
        }
      }, {});

      const drafts = await service.draftReplies(videoId);
      if (drafts.length !== 1) throw new Error(`Expected 1 usable draft (link + quarantined dropped), got ${drafts.length}`);
      if (drafts[0].commentId !== `${videoId}_q1` || drafts[0].status !== 'proposed') throw new Error('Draft shape is wrong');
      if (promptSeen.includes(`${videoId}_scam1`) || promptSeen.includes(`${videoId}_own1`) || promptSeen.includes(`${videoId}_nested`)) {
        throw new Error('Quarantined, owner, and nested comments must never reach the draft prompt');
      }

      const noAI = new AudienceEngagementService(db, null, { isAvailable: () => false }, {});
      let status = 0;
      try { await noAI.draftReplies(videoId); } catch (error) { status = error.status; }
      if (status !== 503) throw new Error('Drafting without AI must throw 503');

      await db.saveEngagementInsight({ videoId: `${videoId}_fb`, analysisMethod: 'fallback' });
      status = 0;
      try { await service.draftReplies(`${videoId}_fb`); } catch (error) { status = error.status; }
      if (status !== 409) throw new Error('Drafting without an AI analysis must throw 409');
    } finally {
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id = ?', [videoId]);
      await db.executeQuery('DELETE FROM engagement_insights WHERE video_id LIKE ?', [`${videoId}%`]);
      await db.executeQuery('DELETE FROM reply_drafts WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testReplyApprovalAndPosting() {
    const db = new Database();
    await db.initialize();
    const videoId = `vid_post_${Date.now()}`;
    const commentId = `${videoId}_target`;
    const scopedCredentials = { hasYouTubeScope: scope => scope === 'https://www.googleapis.com/auth/youtube.force-ssl' };
    try {
      await db.upsertAudienceComment({ commentId, videoId, text: 'Question?', publishedAt: new Date().toISOString() });
      const makeDraft = () => db.saveReplyDraft({ commentId, videoId, draftText: 'Answer text' });

      let draft = await makeDraft();
      const posts = [];
      const service = new AudienceEngagementService(db, scopedCredentials, null, {
        insertComment: async ({ parentId, text }) => { posts.push({ parentId, text }); return { id: 'yt_posted_1' }; }
      });

      let code = null;
      try { await service.approveReplyDraft(draft.id, {}); } catch (error) { code = error.code; }
      if (code !== 'REPLY_APPROVAL_REQUIRED') throw new Error('Approval must require confirmed: true');

      const unscoped = new AudienceEngagementService(db, { hasYouTubeScope: () => false }, null, {});
      code = null;
      try { await unscoped.approveReplyDraft(draft.id, { confirmed: true }); } catch (error) { code = error.code; }
      if (code !== 'REPLY_SCOPE_REQUIRED') throw new Error('Missing force-ssl scope must block posting');
      const gate = unscoped.postingEnabled();
      if (gate.enabled || gate.reason !== 'missing_scope') {
        throw new Error('postingEnabled must report missing_scope');
      }

      const posted = await service.approveReplyDraft(draft.id, { confirmed: true, editedText: 'Edited answer' });
      if (posted.status !== 'posted' || posted.postedCommentId !== 'yt_posted_1') throw new Error('Posting evidence missing');
      if (posts[0].parentId !== commentId || posts[0].text !== 'Edited answer') throw new Error('The edited text must be what posts');
      if (!(await db.getAudienceComment(commentId)).repliedByAgent) throw new Error('Source comment must be marked replied');

      let status = null;
      try { await service.approveReplyDraft(draft.id, { confirmed: true }); } catch (error) { status = error.status; }
      if (status !== 409) throw new Error('A posted draft must not post twice');

      // Failure path: failed + reason, manual retry allowed
      const failingComment = `${videoId}_fail`;
      await db.upsertAudienceComment({ commentId: failingComment, videoId, text: 'Other?', publishedAt: new Date().toISOString() });
      const failDraft = await db.saveReplyDraft({ commentId: failingComment, videoId, draftText: 'Will fail' });
      const failing = new AudienceEngagementService(db, scopedCredentials, null, {
        insertComment: async () => { throw new Error('commentThreadNotFound'); }
      });
      status = null;
      try { await failing.approveReplyDraft(failDraft.id, { confirmed: true }); } catch (error) { status = error.status; }
      if (status !== 502) throw new Error('A failed post must throw 502');
      const failed = await db.getReplyDraft(failDraft.id);
      if (failed.status !== 'failed' || !failed.failureReason.includes('commentThreadNotFound')) throw new Error('Failure evidence missing');

      // Daily cap
      const capped = new AudienceEngagementService(db, scopedCredentials, null, { dailyReplyCap: 1, insertComment: async () => ({ id: 'x' }) });
      status = null;
      try { await capped.approveReplyDraft(failDraft.id, { confirmed: true }); } catch (error) { status = error.status; }
      if (status !== 429) throw new Error('The daily reply cap must block further posts');

      // updateReplyDraft rules
      const edited = await service.updateReplyDraft(failDraft.id, { editedText: 'Retry text' });
      if (edited.status !== 'proposed' || edited.editedText !== 'Retry text') throw new Error('Editing must re-open a failed draft');
      const discarded = await service.updateReplyDraft(failDraft.id, { discard: true });
      if (discarded.status !== 'discarded') throw new Error('Discard failed');

      // Summary
      const summary = await service.getSummary();
      if (summary.postedToday < 1) throw new Error('getSummary missed postedToday');
      if (summary.postingEnabled !== true) throw new Error('getSummary posting flag is wrong');
      if (!summary.evidencePolicy.includes('operator approval')) throw new Error('evidencePolicy text missing');
    } finally {
      await db.executeQuery('DELETE FROM audience_comments WHERE video_id = ?', [videoId]);
      await db.executeQuery('DELETE FROM reply_drafts WHERE video_id = ?', [videoId]);
      await db.executeQuery('DELETE FROM engagement_insights WHERE video_id = ?', [videoId]);
      await db.close();
    }
  }

  async testEngagementAIProviderWiring() {
    const { AITextService } = require('./utils/ai-text-service');

    // Regression: index.js must hand AITextService the unwrapped credentials object
    // (manager.credentials), the shape the walkthrough writes to credentials.json.
    // Passing the CredentialManager itself leaves the engagement studio permanently
    // in fallback mode on installs with no provider environment variables.
    const savedEnv = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const configured = new AITextService({
        aiProvider: { provider: 'openai', apiKey: 'test-key', model: 'gpt-5.6' }
      });
      if (!configured.isAvailable()) {
        throw new Error('AITextService must initialize from a credentials-file aiProvider config');
      }

      const wrapped = new AITextService({
        credentials: { aiProvider: { provider: 'openai', apiKey: 'test-key', model: 'gpt-5.6' } }
      });
      if (wrapped.isAvailable()) {
        throw new Error('A CredentialManager-shaped argument must not look configured; index.js has to unwrap it');
      }
    } finally {
      if (savedEnv === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedEnv;
    }
  }

  async testEngagementSyncSchedule() {
    let captured = null;
    const events = [];
    const fakeDb = {
      getAllRows: async () => [
        { youtube_id: 'vid_sched_1', title: 'Scheduled video', published_at: '2026-08-22T00:00:00.000Z', production_id: 'prod_1' }
      ],
      executeQuery: async () => ({}),
      generateId: prefix => `${prefix}_test`
    };
    const scheduler = new DailyAutomation({}, fakeDb, {
      generateContent: async () => {},
      engagement: {
        syncDueVideos: async videos => {
          captured = videos;
          return { synced: 1, skipped: 0, failed: 0, analyzed: 1 };
        }
      }
    });
    scheduler.logAutomationEvent = async (type, status, data) => { events.push({ type, status, data }); };
    await scheduler.collectAudienceEngagement();
    if (!captured || captured[0].youtubeId !== 'vid_sched_1') throw new Error('The scheduler did not map youtube_id');
    if (captured[0].productionId !== 'prod_1' || captured[0].publishedAt !== '2026-08-22T00:00:00.000Z') {
      throw new Error('The scheduler did not map production/publish fields');
    }
    if (!events.some(event => event.type === 'audience_engagement_sync' && event.status === 'success')) {
      throw new Error('The engagement sweep must log an automation event');
    }
    const noService = new DailyAutomation({}, fakeDb, { generateContent: async () => {} });
    await noService.collectAudienceEngagement(); // must be a silent no-op, not a crash
  }

  async testGrowthExperimentRefreshSchedule() {
    const events = [];
    let refreshes = 0;
    const scheduler = new DailyAutomation({}, {}, {
      experiments: {
        refreshDue: async () => {
          refreshes++;
          return { running: 2, refreshed: 1, failed: 0 };
        }
      }
    });
    scheduler.logAutomationEvent = async (type, status, data) => events.push({ type, status, data });
    await scheduler.refreshGrowthExperiments();
    if (refreshes !== 1 || !events.some(event =>
      event.type === 'growth_experiment_refresh' && event.status === 'success' && event.data.refreshed === 1
    )) {
      throw new Error('The scheduler did not refresh and record due controlled experiments');
    }
    const noService = new DailyAutomation({}, {}, {});
    await noService.refreshGrowthExperiments();
  }
}

// Run tests if called directly
if (require.main === module) {
  const tester = new SystemTest();
  tester.runAllTests()
    .then(success => process.exit(success ? 0 : 1))
    .catch(error => {
      console.error(chalk.red('Test runner failed:'), error);
      process.exit(1);
    });
}

module.exports = { SystemTest };
