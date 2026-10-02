const { Logger } = require('../utils/logger');
const { extractJson } = require('../utils/ai-json');
const { AITextService } = require('../utils/ai-text-service');
const { techniques, getTechnique } = require('../utils/techniques');
const { isReactMode } = require('../utils/content-mode');
const { reactProfile } = require('../utils/react-profile');

// React mode: one video in `lesson.every` (react profile) teaches one of its techniques (the "lesson" format).
function lessonEvery() {
  const every = Math.round(Number(reactProfile().lesson?.every));
  return every >= 2 && techniques().length ? every : 0;
}

class ContentStrategyAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ContentStrategy');
    this.trendingTopics = [];
    this.competitorData = [];
    this.contentCalendar = [];
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  async initialize() {
    this.logger.info('Initializing Content Strategy Agent...');
    await this.loadHistoricalData();
    await this.analyzeTrends();
    return true;
  }

  async loadHistoricalData() {
    try {
      const history = await this.db.getContentHistory();
      this.historicalPerformance = history;
    } catch (error) {
      this.logger.warn('No historical data found, starting fresh');
      this.historicalPerformance = [];
    }
  }

  async analyzeTrends() {
    try {
      // Analyze YouTube trends
      const trends = await this.fetchYouTubeTrends();
      
      // Analyze competitor channels
      const competitors = await this.analyzeCompetitors();
      this.competitorData = competitors;
      
      // Combine insights
      this.trendingTopics = this.mergeTrendData(trends, competitors);
      
      this.logger.info(`Identified ${this.trendingTopics.length} trending topics`);
    } catch (error) {
      this.logger.error('Error analyzing trends:', error);
    }
  }

  async fetchYouTubeTrends() {
    // Use YouTube API to fetch trending videos
    const youtube = this.credentials.getYouTubeClient();
    
    try {
      const response = await youtube.videos.list({
        part: 'snippet,statistics',
        chart: 'mostPopular',
        maxResults: 50,
        regionCode: process.env.YOUTUBE_REGION || 'US'
      });

      return response.data.items.map(video => ({
        videoId: video.id,
        title: video.snippet.title,
        tags: video.snippet.tags || [],
        viewCount: parseInt(video.statistics?.viewCount, 10) || 0,
        category: video.snippet.categoryId,
        publishedAt: video.snippet.publishedAt,
        publisher: video.snippet.channelTitle || 'YouTube',
        url: `https://www.youtube.com/watch?v=${video.id}`
      }));
    } catch (error) {
      this.logger.error('Failed to fetch YouTube trends:', error);
      return [];
    }
  }

  async analyzeCompetitors() {
    const competitorChannels = (process.env.COMPETITOR_CHANNELS || '').split(',');
    const competitorData = [];

    for (const channelId of competitorChannels) {
      if (!channelId) continue;
      
      try {
        const videos = await this.getChannelVideos(channelId);
        const analysis = this.analyzeVideoPerformance(videos);
        competitorData.push({
          channelId,
          topPerformingTopics: analysis.topTopics,
          averageViews: analysis.avgViews,
          uploadFrequency: analysis.frequency
        });
      } catch (error) {
        this.logger.error(`Failed to analyze competitor ${channelId}:`, error);
      }
    }

    return competitorData;
  }

  async getChannelVideos(channelId) {
    const youtube = this.credentials.getYouTubeClient();
    
    try {
      const response = await youtube.search.list({
        part: 'snippet',
        channelId: channelId,
        maxResults: 20,
        order: 'date',
        type: 'video'
      });

      const videoIds = response.data.items.map(item => item.id.videoId).join(',');
      
      const videoDetails = await youtube.videos.list({
        part: 'statistics,snippet',
        id: videoIds
      });

      return videoDetails.data.items;
    } catch (error) {
      this.logger.error(`Failed to get videos for channel ${channelId}:`, error);
      return [];
    }
  }

  analyzeVideoPerformance(videos) {
    if (!videos || videos.length === 0) {
      return { topTopics: [], avgViews: 0, frequency: 0 };
    }

    const topics = {};
    let totalViews = 0;

    videos.forEach(video => {
      const title = video.snippet.title.toLowerCase();
      const views = parseInt(video.statistics?.viewCount, 10) || 0;
      totalViews += views;

      // Extract topics from title
      const keywords = this.extractKeywords(title);
      keywords.forEach(keyword => {
        if (!topics[keyword]) topics[keyword] = { count: 0, views: 0, evidence: [] };
        topics[keyword].count++;
        topics[keyword].views += views;
        topics[keyword].evidence.push({
          url: `https://www.youtube.com/watch?v=${video.id}`,
          title: video.snippet.title,
          publisher: video.snippet.channelTitle || 'Configured competitor channel',
          publishedAt: video.snippet.publishedAt,
          sourceType: 'video'
        });
      });
    });

    const topTopics = Object.entries(topics)
      .sort((a, b) => b[1].views - a[1].views)
      .slice(0, 10)
      .map(([topic, data]) => ({ topic, avgViews: data.views / data.count, evidence: data.evidence.slice(0, 5) }));

    return {
      topTopics,
      avgViews: totalViews / videos.length,
      frequency: videos.length
    };
  }

  extractKeywords(text) {
    // Simple keyword extraction
    const stopWords = ['the', 'is', 'at', 'which', 'on', 'and', 'a', 'an', 'as', 'are', 'was', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might', 'must', 'can', 'could', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now'];
    
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 3 && !stopWords.includes(word));
  }

  mergeTrendData(trends, competitors) {
    const mergedTopics = new Map();

    // Add trending topics
    trends.forEach(trend => {
      const keywords = this.extractKeywords(trend.title);
      keywords.forEach(keyword => {
        if (!mergedTopics.has(keyword)) {
          mergedTopics.set(keyword, { score: 0, sources: [], evidence: [] });
        }
        const topic = mergedTopics.get(keyword);
        topic.score += trend.viewCount / 1000000; // Normalize by millions
        topic.sources.push('trending');
        topic.evidence.push({
          url: trend.url,
          title: trend.title,
          publisher: trend.publisher,
          publishedAt: trend.publishedAt,
          sourceType: 'video'
        });
      });
    });

    // Add competitor topics
    competitors.forEach(competitor => {
      if (competitor.topPerformingTopics) {
        competitor.topPerformingTopics.forEach(({ topic, avgViews, evidence = [] }) => {
          if (!mergedTopics.has(topic)) {
            mergedTopics.set(topic, { score: 0, sources: [], evidence: [] });
          }
          const topicData = mergedTopics.get(topic);
          topicData.score += avgViews / 100000; // Normalize
          topicData.sources.push('competitor');
          topicData.evidence.push(...evidence);
        });
      }
    });

    // Convert to array and sort by score
    return Array.from(mergedTopics.entries())
      .map(([topic, data]) => ({ topic, ...data }))
      .map(item => ({
        ...item,
        evidence: [...new Map(item.evidence.filter(source => source.url).map(source => [source.url, source])).values()].slice(0, 5)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
  }

  async generateContentStrategy(requestedTopic = null) {
    try {
      let topic, angle, targetAudience, contentType;

      const aiStrategy = await this.generateContentStrategyWithAI(requestedTopic);
      if (aiStrategy) {
        await this.db.saveContentStrategy(aiStrategy);
        this.logger.info(`Generated AI strategy for: ${aiStrategy.topic}`);
        return aiStrategy;
      }

      this.logger.info('Using template content strategy generation');
      if (requestedTopic) {
        topic = requestedTopic;
        angle = await this.generateAngle(topic);
      } else {
        // Select from trending topics
        const selectedTopic = this.selectOptimalTopic();
        topic = selectedTopic.topic;
        angle = await this.generateAngle(topic);
      }

      // Determine target audience
      targetAudience = await this.identifyTargetAudience(topic);

      // Select content type
      contentType = this.selectContentType(topic);

      // Generate content calendar entry
      const strategy = {
        topic,
        angle,
        targetAudience,
        contentType,
        keywords: this.extractKeywords(topic),
        estimatedViews: this.predictViews(topic),
        bestPublishTime: this.calculateBestPublishTime(),
        competitorAnalysis: this.getCompetitorInsights(topic),
        createdAt: new Date().toISOString()
      };

      // Save to database
      await this.db.saveContentStrategy(strategy);

      this.logger.info(`Generated strategy for: ${topic}`);
      return strategy;
    } catch (error) {
      this.logger.error('Failed to generate content strategy:', error);
      throw error;
    }
  }

  async researchAndPlanChannel(channelStrategy) {
    const targetCount = Math.max(1, Math.min(5, Number(channelStrategy.videos_per_run || 1)));
    await this.analyzeTrends();

    const recentRows = await this.db.getAllRows(
      "SELECT topic, created_at FROM content_strategies WHERE created_at >= datetime('now', '-90 days') ORDER BY created_at DESC LIMIT 50"
    );
    const approvedLearnings = this.db.listLearningRecommendations
      ? await this.db.listLearningRecommendations({ status: 'approved', limit: 10 })
      : [];
    const signals = this.usableTrends().slice(0, 15).map(item => ({
      topic: item.topic,
      score: Number(item.score || 0),
      sources: [...new Set(item.sources || [])],
      evidence: item.evidence || []
    }));
    const sourceCatalog = [...new Map(
      signals.flatMap(signal => signal.evidence || []).map(source => [source.url, source])
    ).values()].slice(0, 30);
    const signalSources = new Set(signals.flatMap(signal => signal.sources));
    const gaps = await this.openGaps();
    const researchSources = [
      ...(gaps.length ? ['Measured topic gaps (YouTube demand against existing answers)'] : []),
      ...(signalSources.has('trending') ? ['YouTube most-popular videos'] : []),
      ...(signalSources.has('competitor') ? ['Configured competitor channels'] : []),
      ...(recentRows.length ? ['Channel content history'] : []),
      ...(approvedLearnings.length ? ['Operator-approved channel performance learnings'] : [])
    ];
    const lessonDue = await this.lessonDue();
    const research = {
      generatedAt: new Date().toISOString(),
      sources: researchSources.length ? researchSources : ['No usable live signals returned; evergreen strategy fallback'],
      signals,
      sourceCatalog,
      recentTopics: recentRows.map(row => row.topic),
      competitorChannelsAnalyzed: this.competitorData.length,
      approvedLearnings: approvedLearnings.map(item => ({
        category: item.category,
        title: item.title,
        rationale: item.rationale,
        confidence: item.confidence,
        proposedChange: item.proposedChange
      })),
      lessonDue,
      // Claims widely defended on YouTube and rarely answered (utils/topic-gap-finder.js); never sources of a script.
      gaps: gaps.map(gap => ({ gapId: gap.id, claim: gap.claim, pillar: gap.pillar, supportingViews: gap.demandViews, answeringViews: gap.supplyViews }))
    };

    let plan = await this.generateAutonomousPlanWithAI(channelStrategy, research, targetCount);
    plan = this.normalizeAutonomousPlan(plan, channelStrategy, targetCount, research);
    if (plan.length < targetCount) {
      const fallback = this.buildFallbackAutonomousPlan(channelStrategy, research, targetCount);
      plan = this.normalizeAutonomousPlan([...plan, ...fallback], channelStrategy, targetCount, research);
    }

    return { research, plan };
  }

  async generateAutonomousPlanWithAI(channelStrategy, research, targetCount) {
    if (!this.aiTextService.isAvailable()) return [];
    const prompt = `You are the strategy lead for an autonomous YouTube channel.
Turn the channel strategy and the supplied research signals into a focused content plan.
Return only a valid JSON array with exactly ${targetCount} items using this shape:
[{"topic":"specific video topic","pillar":"one exact content pillar from the supplied strategy","angle":"distinct audience-relevant angle","rationale":"why this advances the channel objective using the supplied evidence","format":"explainer|tutorial|list|review|story","length":"short|medium|long","sourceUrls":["exact URL from the supplied source catalog"],"gapId":"the gapId of the measured gap this item answers, or empty"}]

Language: write topic, angle and rationale in the language with ISO code "${process.env.CONTENT_LANGUAGE || 'en'}".
Channel objective: ${channelStrategy.objective}
Audience: ${channelStrategy.audience}
Value proposition: ${channelStrategy.value_proposition || 'not specified'}
Content pillars: ${(channelStrategy.contentPillars || []).join(', ')}
Preferred format: ${channelStrategy.default_format}
Preferred length: ${channelStrategy.default_length}
Success metric: ${channelStrategy.success_metric || 'not specified'}
Primary KPI: ${channelStrategy.primary_kpi || 'views'}
Target: ${channelStrategy.target_value || 'not set'} per ${channelStrategy.target_window_days || 28} days
Monthly production budget: ${channelStrategy.monthly_budget ?? 'not set'} ${channelStrategy.outcome_currency || 'USD'}
Constraints: ${channelStrategy.constraints || 'none'}
Research signals: ${JSON.stringify(research.signals)}
Allowed source catalog: ${JSON.stringify(research.sourceCatalog)}
Recent topics to avoid repeating: ${JSON.stringify(research.recentTopics)}
Operator-approved performance learnings to apply: ${JSON.stringify(research.approvedLearnings)}
${research.gaps.length ? `Measured gaps: claims that many people watch being supported on YouTube and few watch being answered. Plan the other items on these first, the widest gap (most supporting views, fewest answering views) first, unless one does not fit the channel; for such an item, copy its gapId and keep the claim's substance in the topic, worded as the people who hold it search for it. ${JSON.stringify(research.gaps)}
` : ''}${research.lessonDue ? `${typeof reactProfile().lesson?.plannerRule === 'function'
    ? reactProfile().lesson.plannerRule(research.lessonDue)
    : `Lesson video due: the FIRST item uses format "lesson" and teaches the technique "${research.lessonDue.name}" (${research.lessonDue.definition}) through examples from several subjects. Its topic is the question a curious viewer asks about the pattern (for example "${research.lessonDue.question}"); never the name of the technique.`} The other items follow the rules below.
` : ''}
${reactProfile().planner?.topicRule || 'Topic wording: each topic becomes the working title of the video, so write it the way the target audience would search for it on YouTube: specific and intriguing, never a promise the video will not deliver; use the question the video answers when that is clearer.'}
Do not invent trend data, statistics, sources, URLs, or factual claims. Use only exact URLs from the supplied source catalog. Apply only the supplied approved learnings; pending or rejected recommendations are not authorized. Prefer evergreen topics when the supplied signals are weak. Learnings with category "audience_demand" are audience-requested topics mined from real comments on published videos; prefer planning a video that directly answers one when it fits the channel objective, and cite it in the rationale.`;

    try {
      const response = await this.aiTextService.generateText(prompt, { maxTokens: 1800, temperature: 0.65, purpose: 'autonomous_plan' });
      const parsed = this.parseAIJsonResponse(response);
      return Array.isArray(parsed) ? parsed : Array.isArray(parsed.plan) ? parsed.plan : [];
    } catch (error) {
      this.logger.warn(`AI channel plan failed; using evidence-aware fallback: ${error.message}`);
      return [];
    }
  }

  buildFallbackAutonomousPlan(channelStrategy, research, targetCount) {
    const recent = new Set(research.recentTopics.map(topic => String(topic).toLowerCase()));
    const readableSignals = research.signals
      .map(signal => signal.topic)
      .filter(topic => topic.includes(' ') && topic.length >= 8 && !recent.has(topic.toLowerCase()));
    const pillars = channelStrategy.contentPillars || [];
    const lang = process.env.CONTENT_LANGUAGE || 'en';
    const pillarTopics = pillars.map(pillar => lang === 'fr'
      ? `${pillar} : le point de départ`
      : `${pillar}: a practical guide for ${channelStrategy.audience}`);
    const candidates = [...readableSignals, ...pillarTopics, ...(lang === 'en' ? this.getEvergreenFallbackTopics() : [])];

    return candidates.slice(0, targetCount).map((topic, index) => ({
      topic,
      pillar: pillars.find(pillar => topic.toLowerCase().includes(String(pillar).toLowerCase())) || pillars[index % Math.max(1, pillars.length)] || '',
      angle: `${topic} through the lens of ${channelStrategy.value_proposition || channelStrategy.objective}`,
      rationale: readableSignals.includes(topic)
        ? 'Matches a current YouTube or configured competitor signal and fits the channel strategy.'
        : research.approvedLearnings.length
          ? `Builds an evergreen topic from the channel strategy while applying approved learning: ${research.approvedLearnings[0].title}.`
          : 'Builds an evergreen topic from the channel strategy when live research signals are limited.',
      format: index === 0 ? channelStrategy.default_format : ['explainer', 'tutorial', 'list'][index % 3],
      length: channelStrategy.default_length,
      sourceUrls: research.signals.find(signal => signal.topic === topic)?.evidence?.map(source => source.url) || []
    }));
  }

  // A lesson teaches one technique instead of examining one claim: due once `every - 1` videos have been completed
  // since the last one (or since the start), on the technique taught least recently and, among those never taught, the
  // one the channel's examined claims rely on most.
  async lessonDue() {
    const every = lessonEvery();
    if (!every) return null;
    const jobs = await this.db.getAllRows(
      "SELECT style FROM generation_jobs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 50"
    ).catch(() => []);
    const sinceLast = jobs.findIndex(job => String(job.style || '').toLowerCase() === 'lesson');
    if ((sinceLast === -1 ? jobs.length : sinceLast) < every - 1) return null;
    const technique = await this.nextTechnique();
    return { technique: technique.id, name: technique.name, definition: technique.definition, question: technique.question };
  }

  // The widest measured gaps not yet planned (utils/topic-gap-finder.js).
  async openGaps() {
    if (!isReactMode()) return [];
    return this.db.listTopicGaps ? this.db.listTopicGaps({ status: 'open', limit: 8 }).catch(() => []) : [];
  }

  async nextTechnique() {
    const parse = value => { try { return JSON.parse(value || 'null'); } catch (_error) { return null; } };
    const snapshots = await this.db.getAllRows(
      'SELECT strategy, script, created_at FROM production_snapshots ORDER BY created_at DESC LIMIT 200'
    ).catch(() => []);
    const lastTaught = new Map();
    const relied = new Map();
    for (const row of snapshots) {
      const taught = getTechnique(parse(row.strategy)?.technique);
      if (taught && !lastTaught.has(taught.id)) lastTaught.set(taught.id, row.created_at || '');
      for (const id of parse(row.script)?.examinedClaim?.techniques || []) relied.set(id, (relied.get(id) || 0) + 1);
    }
    return [...techniques()].sort((a, b) =>
      (lastTaught.get(a.id) || '').localeCompare(lastTaught.get(b.id) || '') || (relied.get(b.id) || 0) - (relied.get(a.id) || 0))[0];
  }

  // The lesson leads the plan when one is due (the model's, or one built from the technique's question) and never
  // appears otherwise. Runs twice on the same plan, so it must not add a second one.
  placeLesson(items, channelStrategy, research) {
    const due = research.lessonDue;
    const regular = items.filter(item => item.format !== 'lesson');
    if (!due) return regular;
    const proposed = items.find(item => item.format === 'lesson');
    const technique = getTechnique(due.technique);
    const lesson = {
      topic: proposed?.topic || technique.question,
      pillar: proposed?.pillar || '',
      angle: proposed?.angle || `${technique.name} : ${technique.definition}`,
      rationale: proposed?.rationale || reactProfile().lesson?.rationale || `Lesson: ${technique.name}, recognised across several subjects.`,
      format: 'lesson',
      length: proposed?.length || channelStrategy.default_length,
      sourceUrls: proposed?.sourceUrls || [],
      technique: technique.id,
      origin: 'lesson'
    };
    return [lesson, ...regular.filter(item => item.topic.toLowerCase() !== lesson.topic.toLowerCase())];
  }

  normalizeAutonomousPlan(plan, channelStrategy, targetCount, research = {}) {
    const formats = new Set(['explainer', 'tutorial', 'list', 'review', 'story', ...(lessonEvery() ? ['lesson'] : [])]);
    const lengths = new Set(['short', 'medium', 'long']);
    const allowedSourceUrls = new Set((research.sourceCatalog || []).map(source => source.url));
    const pillars = channelStrategy.contentPillars || [];
    const gaps = new Map((research.gaps || []).map(gap => [gap.gapId, gap]));
    // An item answering a measured gap carries it (and the claim as measured) to the job; unknown ids are dropped.
    const gapOf = item => {
      const gap = gaps.get(String(item.gapId || '').trim());
      return gap ? { gapId: gap.gapId, claim: gap.claim, origin: 'gap' } : {};
    };
    const seen = new Set();
    const normalized = plan
      .map(item => ({
        topic: String(item.topic || '').trim().slice(0, 200),
        pillar: pillars.find(pillar => String(pillar).toLowerCase() === String(item.pillar || '').trim().toLowerCase()) || '',
        angle: String(item.angle || '').trim().slice(0, 500),
        rationale: String(item.rationale || '').trim().slice(0, 1000),
        format: formats.has(String(item.format || '').toLowerCase())
          ? String(item.format).toLowerCase()
          : channelStrategy.default_format,
        length: lengths.has(String(item.length || '').toLowerCase())
          ? String(item.length).toLowerCase()
          : channelStrategy.default_length,
        sourceUrls: [...new Set((Array.isArray(item.sourceUrls) ? item.sourceUrls : [])
          .map(url => String(url))
          .filter(url => allowedSourceUrls.has(url)))],
        ...gapOf(item)
      }))
      .filter(item => {
        const key = item.topic.toLowerCase();
        if (!item.topic || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return this.placeLesson(normalized, channelStrategy, research).slice(0, targetCount);
  }

  // General YouTube trends (films, trailers, sport...) are noise for a niche channel and leaked into scripts
  // as hooks; they are only used when STRATEGY_USE_TRENDING=true. Competitor signals are always kept.
  usableTrends() {
    if (String(process.env.STRATEGY_USE_TRENDING || '').toLowerCase() === 'true') return this.trendingTopics;
    return this.trendingTopics.filter(item => (item.sources || []).some(source => source !== 'trending'));
  }

  async generateContentStrategyWithAI(requestedTopic = null) {
    if (!this.aiTextService.isAvailable()) {
      this.logger.info('Using template content strategy generation because no AI text provider is configured');
      return null;
    }

    const trendingTopics = this.usableTrends()
      .slice(0, 10)
      .map(topic => topic.topic)
      .join(', ');
    const prompt = `You are selecting a YouTube content strategy.
Return only valid JSON with this exact shape:
{
  "topic": "specific video topic",
  "angle": "distinct content angle",
  "targetAudience": "specific audience",
  "contentType": "Tutorial|Explainer|List|Review|Story|News",
  "keywords": ["keyword"]
}

Language: write topic, angle, targetAudience and keywords in the language with ISO code "${process.env.CONTENT_LANGUAGE || 'en'}".
Requested topic: ${requestedTopic || 'none'}
Trending topics available: ${trendingTopics || 'none'}
Channel target audience: ${process.env.TARGET_AUDIENCE || 'General audience interested in educational content'}
Avoid fabricated claims and unsupported numbers.`;

    try {
      const response = await this.aiTextService.generateText(prompt, {
        maxTokens: 1000,
        temperature: 0.7,
        purpose: 'strategy'
      });
      const parsed = this.parseAIJsonResponse(response);
      const topic = String(parsed.topic || requestedTopic || '').trim();

      if (!topic) {
        throw new Error('AI strategy response missing topic');
      }

      const contentType = this.normalizeContentType(parsed.contentType, topic);
      const keywords = Array.isArray(parsed.keywords) && parsed.keywords.length > 0
        ? parsed.keywords.map(keyword => String(keyword).trim()).filter(Boolean)
        : this.extractKeywords(topic);

      this.logger.info(`Using AI content strategy via ${this.aiTextService.providerName}`);
      return {
        topic,
        angle: String(parsed.angle || await this.generateAngle(topic)).trim(),
        targetAudience: String(parsed.targetAudience || await this.identifyTargetAudience(topic)).trim(),
        contentType,
        keywords,
        estimatedViews: this.predictViews(topic),
        bestPublishTime: this.calculateBestPublishTime(),
        competitorAnalysis: this.getCompetitorInsights(topic),
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      this.logger.warn(`AI content strategy failed; using template fallback: ${error.message}`);
      return null;
    }
  }

  parseAIJsonResponse(response) {
    return extractJson(response);
  }

  normalizeContentType(contentType, topic) {
    const allowed = new Set(['Tutorial', 'Explainer', 'List', 'Review', 'Story', 'News']);
    const normalized = String(contentType || '').trim();
    const titleCased = normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();

    return allowed.has(titleCased) ? titleCased : this.selectContentType(topic);
  }
  selectOptimalTopic() {
    // Use scoring algorithm to select best topic
    const recentTopics = this.getRecentTopics();

    const scoredTopics = this.trendingTopics
      .filter(topic => !recentTopics.includes(topic.topic))
      .map(topic => ({
        ...topic,
        finalScore: topic.score * this.getSeasonalMultiplier(topic.topic) * this.getAudienceMultiplier(topic.topic)
      }))
      .sort((a, b) => b.finalScore - a.finalScore);

    // Single keywords scraped from trending titles ("crown", "official") make
    // meaningless video topics — only use a trend that reads like a real subject.
    const readable = scoredTopics.find(t => t.topic.trim().includes(' ') && t.topic.trim().length >= 8);
    if (readable) {
      return readable;
    }

    const fallbackTopics = this.getEvergreenFallbackTopics();
    const pick = fallbackTopics[Math.floor(Math.random() * fallbackTopics.length)];
    this.logger.info(`Template mode: no readable trending topic available — using evergreen topic "${pick}"`);
    return { topic: pick, score: 1 };
  }

  getEvergreenFallbackTopics() {
    return [
      'Time Management Strategies That Actually Work',
      'Beginner Mistakes to Avoid When Learning a New Skill',
      'How to Start a Side Project With Zero Budget',
      'Simple Habits That Improve Focus and Productivity',
      'How to Learn Anything Faster Using Proven Study Techniques',
      'Practical Ways to Save Money Every Month',
      'How Artificial Intelligence Is Changing Everyday Life',
      'The Science of Building Habits That Stick',
      'How to Give a Presentation People Actually Remember',
      'Getting Started With Investing: A Beginner Roadmap',
      'Digital Minimalism: Reclaiming Your Attention',
      'How to Negotiate Anything: Tactics That Work',
      'The Psychology of Procrastination and How to Beat It',
      'Remote Work Productivity: Setting Up for Success',
      'How to Read More Books Without Finding Extra Time'
    ];
  }

  async generateAngle(topic) {
    // Generate unique angle for the topic
    const angles = [
      `The Ultimate Guide to ${topic}`,
      `${topic}: What Nobody Is Telling You`,
      `How ${topic} Will Change Everything in ${new Date().getFullYear()}`,
      `The Hidden Truth About ${topic}`,
      `${topic} Explained in 5 Minutes`,
      `Why ${topic} Is More Important Than You Think`,
      `${topic}: Expert Secrets Revealed`,
      `The Complete ${topic} Tutorial for Beginners`
    ];

    return angles[Math.floor(Math.random() * angles.length)];
  }

  async identifyTargetAudience(topic) {
    // Simplified audience identification
    const audiences = {
      tech: 'Tech enthusiasts, developers, early adopters',
      business: 'Entrepreneurs, business owners, professionals',
      education: 'Students, educators, lifelong learners',
      entertainment: 'General audience, entertainment seekers',
      lifestyle: 'Lifestyle enthusiasts, self-improvement seekers'
    };

    const category = this.categorize(topic);
    return audiences[category] || audiences.entertainment;
  }

  categorize(topic) {
    const categories = {
      tech: ['technology', 'software', 'app', 'ai', 'code', 'programming', 'crypto', 'blockchain'],
      business: ['business', 'money', 'finance', 'startup', 'entrepreneur', 'marketing'],
      education: ['learn', 'tutorial', 'how to', 'guide', 'course', 'study'],
      lifestyle: ['life', 'health', 'fitness', 'food', 'travel', 'fashion']
    };

    const topicLower = topic.toLowerCase();
    
    for (const [category, keywords] of Object.entries(categories)) {
      if (keywords.some(keyword => topicLower.includes(keyword))) {
        return category;
      }
    }

    return 'entertainment';
  }

  selectContentType(topic) {
    const types = [
      { type: 'Tutorial', suitableFor: ['how to', 'guide', 'learn'] },
      { type: 'List', suitableFor: ['best', 'top', 'worst'] },
      { type: 'Review', suitableFor: ['review', 'vs', 'comparison'] },
      { type: 'Explainer', suitableFor: ['what is', 'why', 'explained'] },
      { type: 'News', suitableFor: ['breaking', 'latest', 'new'] },
      { type: 'Story', suitableFor: ['story', 'journey', 'experience'] }
    ];

    const topicLower = topic.toLowerCase();
    
    for (const contentType of types) {
      if (contentType.suitableFor.some(keyword => topicLower.includes(keyword))) {
        return contentType.type;
      }
    }

    return 'Explainer';
  }

  predictViews(topic) {
    // Simplified view prediction based on topic score
    const topicData = this.trendingTopics.find(t => t.topic === topic);
    const baseViews = topicData ? topicData.score * 10000 : 5000;
    const variance = baseViews * 0.3;
    return Math.floor(baseViews + (Math.random() * variance * 2) - variance);
  }

  calculateBestPublishTime() {
    // Analyze best publishing times
    const bestTimes = [
      { day: 'Tuesday', hour: 14 },
      { day: 'Wednesday', hour: 14 },
      { day: 'Thursday', hour: 14 },
      { day: 'Friday', hour: 15 },
      { day: 'Saturday', hour: 10 },
      { day: 'Sunday', hour: 10 }
    ];

    const selected = bestTimes[Math.floor(Math.random() * bestTimes.length)];
    const nextDate = this.getNextWeekday(selected.day);
    nextDate.setHours(selected.hour, 0, 0, 0);
    
    return nextDate.toISOString();
  }

  getNextWeekday(dayName) {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const targetDay = days.indexOf(dayName);
    const today = new Date();
    const currentDay = today.getDay();
    const daysUntilTarget = (targetDay - currentDay + 7) % 7 || 7;
    const nextDate = new Date(today);
    nextDate.setDate(today.getDate() + daysUntilTarget);
    return nextDate;
  }

  getCompetitorInsights(topic) {
    // Get insights from competitor analysis
    return this.competitorData
      .filter(competitor => 
        competitor.topPerformingTopics.some(t => 
          t.topic.toLowerCase().includes(topic.toLowerCase())
        )
      )
      .map(competitor => ({
        channelId: competitor.channelId,
        averageViews: competitor.averageViews,
        relevantVideos: competitor.topPerformingTopics.filter(t => 
          t.topic.toLowerCase().includes(topic.toLowerCase())
        )
      }));
  }

  getRecentTopics() {
    // Get topics used in last 7 days to avoid repetition
    return this.historicalPerformance
      .filter(content => {
        const contentDate = new Date(content.createdAt);
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        return contentDate > weekAgo;
      })
      .map(content => content.topic);
  }

  getSeasonalMultiplier(topic) {
    // Adjust score based on seasonal relevance
    const month = new Date().getMonth();
    const seasonalTopics = {
      winter: ['christmas', 'holiday', 'new year', 'winter'],
      spring: ['spring', 'easter', 'garden'],
      summer: ['summer', 'vacation', 'beach', 'travel'],
      fall: ['halloween', 'thanksgiving', 'autumn', 'back to school']
    };

    const season = month < 3 ? 'winter' : month < 6 ? 'spring' : month < 9 ? 'summer' : 'fall';
    const topicLower = topic.toLowerCase();
    
    if (seasonalTopics[season].some(keyword => topicLower.includes(keyword))) {
      return 1.5;
    }
    
    return 1.0;
  }

  getAudienceMultiplier(topic) {
    // Adjust score based on target audience size
    const category = this.categorize(topic);
    const multipliers = {
      tech: 1.2,
      business: 1.1,
      education: 1.0,
      entertainment: 1.3,
      lifestyle: 1.15
    };
    
    return multipliers[category] || 1.0;
  }
}

module.exports = { ContentStrategyAgent };
