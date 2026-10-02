const { Logger } = require('../utils/logger');
const { extractJson } = require('../utils/ai-json');
const { AITextService } = require('../utils/ai-text-service');
const { hasSubscribeCall } = require('../utils/subscribe-cta');
const { getTechnique, validTechniqueIds, techniqueCatalog } = require('../utils/techniques');
const { isShortForm, seriesOf } = require('../utils/vertical-short');
const { isReactMode, registerOf } = require('../utils/content-mode');
const { reactProfile, verdicts, twoPartVideos } = require('../utils/react-profile');

// A lesson video (react mode) teaches one technique of the react profile instead of examining one claim.
function isLesson(strategy = {}) {
  return isReactMode() && String(strategy.contentType || '').toLowerCase() === 'lesson' && Boolean(getTechnique(strategy.technique));
}

// The claim a video examines, its verdict and the techniques it relies on, as the public site shows them (react mode,
// with a verdict scale in the profile). An unknown verdict becomes the profile's `unknownVerdict`.
function normalizeExaminedClaim(raw) {
  const scale = verdicts();
  if (!scale || !raw || typeof raw !== 'object') return null;
  const statement = String(raw.statement || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  if (!statement) return null;
  const verdict = String(raw.verdict || '').trim().toLowerCase();
  const fallback = reactProfile().claims?.unknownVerdict;
  return {
    statement,
    verdict: scale[verdict] ? verdict : scale[fallback] ? fallback : null,
    summary: String(raw.summary || '').replace(/\s+/g, ' ').trim().slice(0, 800),
    techniques: validTechniqueIds(raw.techniques).slice(0, 3)
  };
}

// Spoken words per minute of the configured narration engine, measured on real scenes (Kokoro ~195 wpm,
// Azure fr-FR-RemyMultilingualNeural at -5% ~174; ElevenLabs narrators run ~160). NARRATION_WPM overrides it.
const MEASURED_WPM = { kokoro: 195, azure: 174 };
function narrationWpm() {
  const configured = Number(process.env.NARRATION_WPM);
  if (configured > 0) return configured;
  return MEASURED_WPM[String(process.env.TTS_PROVIDER || '').toLowerCase()] || 160;
}

// Word budget for a length such as "8-12 minutes": aim inside the range, not at its edges, so the
// finished video lands above the lower bound (8 minutes is also YouTube's mid-roll threshold).
function wordBudget(length) {
  const numbers = String(length || '').match(/\d+(?:[.,]\d+)?/g)?.map(value => Number(value.replace(',', '.'))) || [];
  const low = numbers[0] || 8;
  const high = numbers[1] || low + 2;
  const wpm = narrationWpm();
  const from = Math.round(Math.min(high, low + 1) * wpm / 50) * 50;
  const to = Math.round(Math.max(low + 1, high - 1) * wpm / 50) * 50;
  return { wpm, from, to: Math.max(from + 100, to) };
}

// Word budget of a vertical Short: 75 to 120 seconds of narration, hook and call to action included, so the Short
// stays well under the three minutes YouTube allows.
function shortBudget() {
  const wpm = narrationWpm();
  return { wpm, from: Math.round(75 * wpm / 600) * 10, to: Math.round(120 * wpm / 600) * 10 };
}

// A part of a series carries its place in its title, whatever the model wrote.
function seriesTitle(title, strategy) {
  const { part, parts } = seriesOf(strategy);
  const base = String(title || '').replace(/\s*[(（]\s*partie\s*\d+\s*\/\s*\d+\s*[)）]\s*$/i, '').trim();
  if (!isShortForm(strategy) || parts < 2) return base.slice(0, 100);
  const suffix = ` (partie ${part}/${parts})`;
  return `${base.slice(0, 100 - suffix.length).trim()}${suffix}`;
}

class ScriptWriterAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ScriptWriter');
    this.templates = this.loadTemplates();
    this.aiTextService = new AITextService(credentials?.credentials || credentials || {});
  }

  async initialize() {
    this.logger.info('Initializing Script Writer Agent...');
    return true;
  }

  loadTemplates() {
    return {
      tutorial: {
        structure: ['hook', 'introduction', 'problem', 'solution_steps', 'demonstration', 'recap', 'cta'],
        tone: 'educational',
        pacing: 'moderate'
      },
      explainer: {
        structure: ['hook', 'question', 'background', 'explanation', 'examples', 'implications', 'summary', 'cta'],
        tone: 'informative',
        pacing: 'steady'
      },
      list: {
        structure: ['hook', 'introduction', 'list_items', 'bonus_item', 'summary', 'cta'],
        tone: 'engaging',
        pacing: 'quick'
      },
      review: {
        structure: ['hook', 'introduction', 'overview', 'pros', 'cons', 'comparison', 'verdict', 'cta'],
        tone: 'analytical',
        pacing: 'detailed'
      },
      story: {
        structure: ['hook', 'setup', 'conflict', 'journey', 'climax', 'resolution', 'lesson', 'cta'],
        tone: 'narrative',
        pacing: 'dynamic'
      },
      lesson: {
        structure: ['hook', 'example', 'technique', 'examples', 'how_to_spot', 'test', 'cta'],
        tone: 'pedagogical',
        pacing: 'steady'
      }
    };
  }

  async generateScript(strategy) {
    try {
      this.logger.info(`Generating script for: ${strategy.topic}`);
      
      const template = this.templates[strategy.contentType.toLowerCase()] || this.templates.explainer;
      const aiScript = await this.generateScriptWithAI(strategy, template);
      if (aiScript) {
        aiScript.fullScript = this.formatFullScript(aiScript);
        await this.db.saveScript(aiScript);
        this.logger.info(`Script generated with AI provider: ${aiScript.title}`);
        return aiScript;
      }
      
      this.logger.info('Using template script generation');
      // Generate script components
      const hook = await this.generateHook(strategy);
      const introduction = await this.generateIntroduction(strategy);
      const mainContent = await this.generateMainContent(strategy, template);
      const conclusion = await this.generateConclusion(strategy);
      const cta = await this.generateCTA(strategy);

      // Assemble complete script
      const script = {
        title: await this.generateTitle(strategy),
        hook,
        introduction,
        mainContent,
        conclusion,
        callToAction: cta,
        duration: this.estimateDuration(mainContent),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords,
        claims: [],
        metadata: {
          strategy: strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0'
        }
      };

      // Format for readability
      script.fullScript = this.formatFullScript(script);
      
      // Save to database
      await this.db.saveScript(script);
      
      this.logger.info(`Script generated: ${script.title}`);
      return script;
    } catch (error) {
      this.logger.error('Failed to generate script:', error);
      throw error;
    }
  }

  async generateScriptWithAI(strategy, template) {
    if (!this.aiTextService.isAvailable()) {
      this.logger.info('Using template script generation because no AI text provider is configured');
      return null;
    }

    const short = isShortForm(strategy);
    // React mode: the profile's rules (utils/react-profile.js); none in standard mode.
    const profile = reactProfile();
    const twoPart = twoPartVideos();
    const scale = verdicts();
    const catalog = techniqueCatalog();
    const desiredLength = short
      ? 'a vertical YouTube Short of 75 to 120 seconds'
      : strategy.requestedLength || process.env.DEFAULT_VIDEO_LENGTH || '8-12 minutes';
    const budget = short ? shortBudget() : wordBudget(desiredLength);
    const prompt = `You are writing the complete spoken narration of a YouTube video. This text is read aloud verbatim by a text-to-speech voice, so write real prose, not a plan.
Return only valid JSON with this exact shape:
{
  "title": "compelling title under 100 characters",
  "hook": "opening hook, one or two punchy spoken sentences",
  "sections": [
    { "title": "chapter title shown on screen for a few seconds (never read aloud)",${twoPart ? ' "register": "opening|main",' : ''} "content": ["one spoken paragraph", "another spoken paragraph"], "duration": 90, "imagePrompt": "one English sentence describing a symbolic, text-free illustration for this section" }
  ],
  "hookImagePrompt": "one English sentence describing the opening illustration",
  "thumbnailText": "2 to 4 words for the thumbnail, complementing the title without repeating it",
  "thumbnailImagePrompt": "one English sentence describing the thumbnail illustration: one striking, recognisable subject",
  "cta": "closing call to action, one or two spoken sentences; the first one explicitly asks the viewer to subscribe",
  "claims": [
    { "text": "specific factual claim a reviewer must verify", "riskLevel": "standard|high", "sourceUrls": ["exact supplied source URL"] }
  ]${scale ? `,
  "examinedClaim": { "statement": "the claim the video examines, stated as those who make it state it", "verdict": "${Object.keys(scale).join('|')}", "summary": "two or three sentences: the video's conclusion and its strongest reason"${catalog ? ', "techniques": ["id from the technique catalog"]' : ''} }` : ''}
}

Language: write the title, hook, every spoken line, and the CTA in the language with ISO code "${process.env.CONTENT_LANGUAGE || 'en'}" (JSON keys stay in English).
Topic: ${strategy.topic}
${strategy.examinedClaimHint ? `Claim to examine, as it circulates: ${strategy.examinedClaimHint}\n` : ''}${this.examinedVideoBlock(strategy)}Style/content type: ${strategy.contentType}
Angle: ${strategy.angle}
Target audience: ${strategy.targetAudience}
Desired length: ${desiredLength}
Tone: ${template.tone}
Pacing: ${template.pacing}
Brand voice: ${strategy.brandVoice || 'clear, credible, and engaging'}
Channel goal: ${strategy.channelGoal || 'help the viewer understand and act'}
Channel value proposition: ${strategy.channelValueProposition || 'give the viewer practical value'}
Editorial rationale: ${strategy.planRationale || 'fit the selected topic and audience'}
Channel constraints: ${strategy.channelConstraints || 'none beyond the factual-safety rules below'}
Preferred call to action: ${strategy.callToAction || 'invite the viewer to subscribe'}
Keywords: ${(strategy.keywords || []).join(', ')}
Research sources: ${JSON.stringify(strategy.researchSources || [])}
${this.titleRule(strategy)}
${profile.script?.thumbnailRule || 'Thumbnail rule: thumbnailText is 2 to 4 words in capitals-friendly wording, adding curiosity rather than repeating the title. thumbnailImagePrompt describes one striking, recognisable subject; no gore.'}
${this.narrativeStructure(strategy)}
Narration rules:
${short
    ? `- Write the FULL narration of a vertical Short: the narration voice reads about ${budget.wpm} words per minute, so it needs ${budget.from}-${budget.to} spoken words in total, hook and cta included, across 2-4 short sections. Never go over ${budget.to}: YouTube only counts a video of three minutes or less as a Short. Every content entry is a complete spoken paragraph of 25-70 words, never a bullet, outline, placeholder or summary; short sentences, one idea each.`
    : `- Write the FULL narration: the narration voice reads about ${budget.wpm} words per minute, so the desired length needs ${budget.from}-${budget.to} spoken words in total across 6-9 sections. Stay inside that range: a shorter script makes a video under the desired length. Every content entry is a complete paragraph of 80-160 words, never a bullet, outline, placeholder or summary.`}
${(profile.script?.rules || []).map(rule => `- ${rule}\n`).join('')}- Never build the narration on trending videos, film trailers, recent releases or unrelated pop culture: stay on the subject.
- The first section opens the video (no "welcome back" filler) and the last section closes it; the hook comes before, the cta after. Do not write "Section", headings or labels inside the spoken text.
- No stage directions, no brackets, no visual notes, no markdown, no emojis; only what the voice says.
- Cite works by their original title unless you are certain a published translation exists under the title you give; never invent translated titles, editions, page numbers or quotations.
- ${profile.script?.voiceRule || 'Follow the brand voice literally, and name real sources, people, works and dates when they are well established. Never attack private persons, and never call for hatred or violence against a group.'}
- Every factual, historical or scientific statement in the narration must also appear in claims with riskLevel; use "high" for anything a hostile viewer could contest.
- imagePrompt / hookImagePrompt: always in English, concrete and visual (objects, figures, places, symbols, light), never abstract adjectives alone, never text or lettering in the image, no living public figures. The rendering style is added automatically; describe only the subject and composition.
Avoid fabricated statistics, unsupported claims, and fake urgency. Use only exact URLs from Research sources; use an empty sourceUrls array when the supplied sources do not support a claim.
${!scale ? '' : `examinedClaim: ${isLesson(strategy) ? 'null for this video, which teaches a technique rather than examining one claim.' : `the single claim the video examines and its verdict (${Object.entries(scale).map(([id, verdict]) => `${id}: ${verdict.definition}`).join('; ')}).${catalog ? ` techniques: the ids, at most 3, of the techniques the claim relies on, from this catalog:\n${catalog}` : ''}`}`}${this.expertRevisionBlock(strategy.expertRevision)}`;

    try {
      const response = await this.aiTextService.generateText(prompt, {
        maxTokens: 8000,
        temperature: 0.7,
        purpose: strategy.expertRevision ? 'script_revision' : 'script'
      });
      const parsed = this.parseAIJsonResponse(response);
      const sections = this.normalizeAISections(parsed.sections, strategy);

      if (!parsed.title || !parsed.hook || sections.length === 0) {
        throw new Error('AI script response missing required fields');
      }

      this.logger.info(`Using AI script generation via ${this.aiTextService.providerName}`);
      return {
        title: seriesTitle(parsed.title, strategy),
        hook: this.normalizeAIHook(parsed.hook),
        hookImagePrompt: typeof parsed.hookImagePrompt === 'string' ? parsed.hookImagePrompt.trim().slice(0, 400) : '',
        thumbnailText: this.normalizeThumbnailText(parsed.thumbnailText),
        thumbnailImagePrompt: typeof parsed.thumbnailImagePrompt === 'string' ? parsed.thumbnailImagePrompt.trim().slice(0, 400) : '',
        // The AI narration already opens and closes the video; keep empty stubs so downstream formatters stay happy.
        introduction: { greeting: '', topicIntro: '', valueProposition: '', credibility: '', duration: '0:00' },
        mainContent: {
          sections,
          totalDuration: this.calculateSectionsDuration(sections)
        },
        conclusion: { type: 'conclusion', title: '', recap: [], finalThought: '', duration: '0 seconds' },
        callToAction: this.normalizeAICTA(parsed.cta, strategy),
        duration: this.estimateDuration({ sections }),
        tone: template.tone,
        pacing: template.pacing,
        keywords: strategy.keywords || [],
        claims: this.normalizeAIClaims(parsed.claims, strategy.researchSources || []),
        examinedClaim: isLesson(strategy) ? null : normalizeExaminedClaim(parsed.examinedClaim),
        technique: getTechnique(strategy.technique)?.id || null,
        metadata: {
          // The previous draft sent with expert corrections is an input, not part of this script.
          strategy: strategy.expertRevision ? { ...strategy, expertRevision: undefined } : strategy,
          generatedAt: new Date().toISOString(),
          version: '1.0',
          generationSource: 'ai',
          ...(strategy.expertRevision ? { expertCorrections: strategy.expertRevision.notes } : {})
        }
      };
    } catch (error) {
      this.logger.warn(`AI script generation failed; using template fallback: ${error.message}`);
      return null;
    }
  }

  // React mode: the watched video a reaction answers is named and quoted word for word, as text (its footage is never
  // reused); the answer is about what the video says, never about its author.
  examinedVideoBlock(strategy) {
    if (strategy.origin !== 'reactive') return '';
    const video = strategy.examinedVideo;
    if (!video?.title) return 'Timing: this claim is circulating right now on YouTube; the video answers it while it circulates.\n';
    const passages = (video.passages || []).map((passage, index) => `${index + 1}. ${passage.timestamp ? `[${passage.timestamp}] ` : ''}« ${passage.text} »`).join('\n');
    const respect = reactProfile().answer?.respect ||
      'Answer what the video says, never its author: no insult, no label for the creator or the audience, no guess about motives, no mockery of a community.';
    return `Examined video: this video answers, while it circulates, the YouTube video « ${video.title} » from the channel « ${video.channel} » (linked in the description). Name it once in the hook or early in the answer. Quote these passages word for word, attributed to that video (for instance « Dans la vidéo « ${video.title} », on entend : « … » »), each one right before answering it:
${passages || `1. « ${video.title} »`}
${respect} The quoted passages are what the video says, not claims to verify: do not list them in claims; list the facts the answer relies on.
`;
  }

  titleRule(strategy) {
    if (isShortForm(strategy)) {
      const { part, parts } = seriesOf(strategy);
      return `${this.titleRule({ ...strategy, format: null })} A Short's title stays under 70 characters (it is cut beyond)${parts > 1 ? `; do not number it, « (partie ${part}/${parts}) » is added to it` : ''}.`;
    }
    const profile = reactProfile();
    if (isLesson(strategy) && profile.lesson?.titleRule) return profile.lesson.titleRule;
    if (isLesson(strategy)) {
      return 'Title rule: the title asks the question a curious viewer has about the pattern the video teaches, not about one example of it, worded the way it would be typed into YouTube search.';
    }
    return profile.script?.titleRule ||
      'Title rule: the title says clearly what the video answers or shows, worded the way the target audience would type it into YouTube search; specific, intriguing and accurate, never a promise the video does not deliver, no clickbait.';
  }

  // A vertical Short (react mode) answers fast and keeps the viewer who scrolls; a series splits the answer, each part
  // on its own passages, each one ending on the next. The react profile can give its own structure.
  shortStructure(strategy) {
    const { part, parts } = seriesOf(strategy);
    const series = parts > 1;
    const custom = reactProfile().answer?.shortStructure;
    if (typeof custom === 'function') return custom({ part, parts });
    const opening = !series || part === 1
      ? 'Hook (one sentence, spoken in the first two seconds, no greeting): what the examined video says, or the question it raises, worded to stop a viewer who scrolls.'
      : `Hook (one sentence, no greeting, no recap of the earlier parts): « Partie ${part} : » followed by what this part answers, worded to stop a viewer who scrolls.`;
    const closing = !series || part === parts
      ? `the conclusion in one sentence${series ? ', on the examined video as a whole' : ''}`
      : `the conclusion of this part in one sentence, then announce that part ${part + 1} answers the next point`;
    return `${series ? `Series: this Short is part ${part} of ${parts} of one answer to the same video. It answers only the passages listed above; the other parts answer the rest.\n` : ''}Narrative structure of a Short (mandatory, in this order):
1. ${opening}
2. What the video says, fairly (one or two sentences).
3. The answer: the channel's response, simply explained, with one or two named references; each quoted passage comes right before its answer.
4. Closing + CTA: ${closing}; the sources are announced as being in the description. The CTA asks the viewer to subscribe, in so many words, in one short sentence.`;
  }

  // The structure of a long video: the react profile's (and its lesson structure, for a video teaching a technique), or
  // an explainer's.
  narrativeStructure(strategy) {
    if (isShortForm(strategy)) return this.shortStructure(strategy);
    const profile = reactProfile();
    const technique = getTechnique(strategy.technique);
    if (isLesson(strategy) && technique) {
      const intro = `Technique taught by this video: ${technique.name} (${technique.id}) — ${technique.definition} Signs: ${(technique.signs || []).join('; ')}.`;
      if (typeof profile.lesson?.structure === 'function') return `${intro}\n${profile.lesson.structure(technique)}`;
      return `${intro}
Narrative structure (mandatory, in this order):
1. Hook + opening section: one striking example of the technique, as it is usually presented.
2. Body sections: why the technique works, then several real examples from different fields, each with named references; then how to recognise it: turn the signs above into questions the viewer can ask.
3. Closing section + CTA: one last example for the viewer to test themselves on, then the answer; the sources announced as being in the description. The CTA always asks the viewer to subscribe, in so many words (the preferred call to action below).`;
    }
    if (profile.script?.structure) return profile.script.structure;
    return `Narrative structure (mandatory, in this order):
1. Hook + opening section: the question the video answers or what it shows, and why it matters to the viewer; no "welcome back" filler.
2. Body sections: each one builds on the previous one, with concrete examples, named references and figures that are well established; each section is understandable on its own and ends on a clear point: its best passages become Shorts.
3. Closing section + CTA: the takeaway in a few sentences, with the sources announced as being in the description. The CTA always asks the viewer to subscribe, in so many words (the preferred call to action below).`;
  }

  // A subject-matter expert reviewed the previous draft of this video and asked for corrections: rewrite that draft,
  // not a new video, so the expert only has the corrected passages to check again.
  expertRevisionBlock(revision) {
    if (!revision?.notes) return '';
    return `

Expert corrections (mandatory): a subject-matter expert${revision.expertProfile ? ` (${revision.expertProfile})` : ''} reviewed the previous draft of this script and requires these corrections:
${revision.notes}

Previous draft (same JSON shape):
${JSON.stringify(revision.previousDraft || {})}

Return the corrected script in the same JSON shape. Apply every correction. Keep everything the expert did not question (title, structure, sections, wording, image prompts) unless a correction requires changing it, and update the claims to match. Never restate a point the expert called wrong; when a correction leaves a point uncertain, remove it rather than rephrase it.`;
  }

  parseAIJsonResponse(response) {
    return extractJson(response);
  }

  normalizeAIHook(hook) {
    const text = typeof hook === 'object' && hook !== null ? hook.text : hook;
    return {
      type: 'ai',
      text: String(text).trim(),
      duration: '0:00-0:05'
    };
  }

  // At most four words, so the thumbnail headline stays legible on a phone.
  normalizeThumbnailText(value) {
    const words = String(value || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    return words.length ? words.slice(0, 4).join(' ').slice(0, 32) : '';
  }

  normalizeAISections(sections, strategy) {
    if (!Array.isArray(sections)) {
      return [];
    }

    return sections
      .slice(0, 10)
      .map((section, index) => {
        const rawContent = Array.isArray(section.content)
          ? section.content
          : [section.content || section.summary || section.description];
        const content = rawContent
          .filter(Boolean)
          .map(line => String(line).trim())
          .filter(Boolean);

        return {
          type: 'ai_generated',
          title: String(section.title || `${strategy.topic} Part ${index + 1}`).trim(),
          content,
          duration: parseInt(section.duration, 10) || 60,
          // Two-part videos (react profile) open with an "opening" part; otherwise every section is the main part.
          register: twoPartVideos() ? registerOf(section.register) : 'main',
          imagePrompt: typeof section.imagePrompt === 'string' ? section.imagePrompt.trim().slice(0, 400) : ''
        };
      })
      .filter(section => section.title && section.content.length > 0);
  }

  normalizeAIClaims(claims, sources) {
    if (!Array.isArray(claims)) return [];
    const allowedUrls = new Set((sources || []).map(source => source.url));
    return claims.slice(0, 25).map(item => ({
      text: String(item?.text || item?.claim || '').trim().slice(0, 1000),
      riskLevel: item?.riskLevel === 'high' ? 'high' : 'standard',
      sourceUrls: [...new Set((Array.isArray(item?.sourceUrls) ? item.sourceUrls : [])
        .map(url => String(url))
        .filter(url => allowedUrls.has(url)))]
    })).filter(item => item.text);
  }

  normalizeAICTA(cta, strategy) {
    // The AI writes the whole closing line; do not append template like/comment lines in another language.
    const spoken = cta && typeof cta === 'object'
      ? String(cta.subscribe || cta.text || '')
      : String(cta || '');
    return {
      type: 'call_to_action',
      subscribe: this.mandatoryCTA(spoken, strategy),
      like: '',
      comment: '',
      nextVideo: '',
      duration: '15 seconds'
    };
  }

  // Asking to subscribe is mandatory: a closing line that does not is replaced by the channel's own call to action,
  // or by the default one when the channel's does not ask either.
  mandatoryCTA(spoken, strategy = {}) {
    const text = String(spoken || '').trim();
    if (hasSubscribeCall(text)) return text;
    return hasSubscribeCall(strategy.callToAction) ? String(strategy.callToAction).trim() : this.t('cta_subscribe', strategy);
  }

  // Minimal localisation for the template (no-AI) path.
  t(key, strategy = {}) {
    const lang = process.env.CONTENT_LANGUAGE || 'en';
    const topic = strategy.topic || '';
    const fr = {
      greeting: 'Bienvenue sur la chaîne.',
      topicIntro: `Aujourd'hui, on s'attaque à ${topic}.`,
      valueProposition: `À la fin de cette vidéo, vous saurez exactement ce qu'il faut penser de ${topic}.`,
      recap: `Voilà ce qu'il fallait retenir sur ${topic}.`,
      finalThought: 'Garde un esprit curieux, et vérifie toujours les sources.',
      cta_subscribe: 'Abonne-toi pour ne rien manquer des prochaines vidéos.'
    };
    const en = {
      greeting: 'Hey everyone, welcome back to the channel!',
      topicIntro: `Today, we're diving deep into ${topic}.`,
      valueProposition: `By the end of this video, you'll understand exactly ${this.getValueProposition(strategy)}.`,
      recap: `So that's everything you need to know about ${topic}.`,
      finalThought: `Remember, ${topic} is a journey, not a destination. Keep learning and improving!`,
      cta_subscribe: `Subscribe for more practical videos about ${topic}.`
    };
    return (lang === 'fr' ? fr : en)[key];
  }
  async generateTitle(strategy) {
    const templates = [
      `${strategy.angle}`,
      `${strategy.topic}: The Complete Guide`,
      `Everything You Need to Know About ${strategy.topic}`,
      `${strategy.topic} in ${new Date().getFullYear()}: What's Changed?`,
      `The Truth About ${strategy.topic} (Shocking Results)`,
      `How to Master ${strategy.topic} in 30 Days`,
      `${strategy.topic}: Beginner to Expert Guide`
    ];

    // Select based on content type
    if (strategy.contentType === 'Tutorial') {
      return `How to ${strategy.topic}: Step-by-Step Guide`;
    } else if (strategy.contentType === 'List') {
      return `Top 10 ${strategy.topic} Tips You Need to Know`;
    } else if (strategy.contentType === 'Review') {
      return `${strategy.topic} Review: Is It Worth It?`;
    }

    return templates[Math.floor(Math.random() * templates.length)];
  }

  async generateHook(strategy) {
    const hooks = [
      {
        type: 'question',
        text: `Have you ever wondered ${this.generateQuestionAbout(strategy.topic)}?`
      },
      {
        type: 'statistic',
        text: `Did you know that ${this.generateStatistic(strategy.topic)}?`
      },
      {
        type: 'statement',
        text: `${strategy.topic} is about to change everything, and here's why...`
      },
      {
        type: 'challenge',
        text: `Most people think they understand ${strategy.topic}, but they're completely wrong.`
      },
      {
        type: 'promise',
        text: `In the next few minutes, you'll learn exactly how to master ${strategy.topic}.`
      }
    ];

    const selected = hooks[Math.floor(Math.random() * hooks.length)];
    
    return {
      type: selected.type,
      text: selected.text,
      duration: '0:00-0:05'
    };
  }

  generateQuestionAbout(topic) {
    const questions = [
      `why ${topic} is becoming so important`,
      `how ${topic} actually works`,
      `what makes ${topic} different from everything else`,
      `why experts are talking about ${topic}`,
      `how ${topic} could change your life`
    ];
    
    return questions[Math.floor(Math.random() * questions.length)];
  }

  generateStatistic(topic) {
    const stats = [
      `many people are still figuring out how ${topic} works`,
      `the conversation around ${topic} keeps expanding`,
      `experts continue to debate where ${topic} is headed`,
      `people often miss the practical side of ${topic}`,
      `${topic} can be easier to approach with a clear framework`
    ];
    
    return stats[Math.floor(Math.random() * stats.length)];
  }

  async generateIntroduction(strategy) {
    return {
      greeting: this.t('greeting', strategy),
      topicIntro: this.t('topicIntro', strategy),
      valueProposition: this.t('valueProposition', strategy),
      credibility: (process.env.CONTENT_LANGUAGE || 'en') === 'en' ? this.getCredibilityStatement(strategy) : '',
      duration: '0:05-0:20'
    };
  }

  getValueProposition(strategy) {
    const propositions = {
      'Tutorial': `how to implement ${strategy.topic} step by step`,
      'Explainer': `what ${strategy.topic} is and why it matters`,
      'List': `the most important things about ${strategy.topic}`,
      'Review': `whether ${strategy.topic} is right for you`,
      'Story': `the incredible journey of ${strategy.topic}`
    };
    
    return propositions[strategy.contentType] || `everything about ${strategy.topic}`;
  }

  getCredibilityStatement(_strategy) {
    const statements = [
      "I've spent months researching this topic",
      "After working with hundreds of people on this",
      "Based on the latest research and data",
      "Drawing from real-world experience",
      "Using proven methods and strategies"
    ];
    
    return statements[Math.floor(Math.random() * statements.length)];
  }

  async generateMainContent(strategy, template) {
    const sections = [];
    
    for (const section of template.structure) {
      if (!['hook', 'introduction', 'cta'].includes(section)) {
        sections.push(await this.generateSection(section, strategy));
      }
    }
    
    return {
      sections,
      totalDuration: this.calculateSectionsDuration(sections)
    };
  }

  async generateSection(sectionType, strategy) {
    const sectionGenerators = {
      problem: () => this.generateProblemSection(strategy),
      solution_steps: () => this.generateSolutionSteps(strategy),
      demonstration: () => this.generateDemonstration(strategy),
      explanation: () => this.generateExplanation(strategy),
      examples: () => this.generateExamples(strategy),
      list_items: () => this.generateListItems(strategy),
      pros: () => this.generatePros(strategy),
      cons: () => this.generateCons(strategy),
      comparison: () => this.generateComparison(strategy),
      implications: () => this.generateImplications(strategy)
    };

    const generator = sectionGenerators[sectionType];
    
    if (generator) {
      return await generator();
    }
    
    return this.generateGenericSection(sectionType, strategy);
  }

  async generateProblemSection(strategy) {
    return {
      type: 'problem',
      title: 'The Challenge',
      content: [
        `Many people struggle with ${strategy.topic}.`,
        `The main issues are:`,
        `1. Lack of clear information`,
        `2. Complexity and confusion`,
        `3. Not knowing where to start`,
        `But don't worry, we're going to solve all of these today.`
      ],
      visuals: ['Problem illustration', 'Statistics graphic'],
      duration: 30
    };
  }

  async generateSolutionSteps(strategy) {
    const steps = [];
    const numSteps = 3 + Math.floor(Math.random() * 3); // 3-5 steps
    
    for (let i = 1; i <= numSteps; i++) {
      steps.push({
        number: i,
        title: `Step ${i}: ${this.generateStepTitle(strategy.topic, i)}`,
        description: this.generateStepDescription(strategy.topic, i),
        tip: this.generateProTip(strategy.topic)
      });
    }
    
    return {
      type: 'solution_steps',
      title: 'The Solution',
      steps,
      duration: steps.length * 45
    };
  }

  generateStepTitle(topic, stepNumber) {
    const titles = [
      'Research and Preparation',
      'Setting Up the Foundation',
      'Implementation and Execution',
      'Testing and Optimization',
      'Scaling and Automation'
    ];
    
    return titles[stepNumber - 1] || `Advanced ${topic} Techniques`;
  }

  generateStepDescription(topic, _stepNumber) {
    return `This step involves understanding the key aspects of ${topic} and how to apply them effectively. Pay special attention to the details here, as they make all the difference.`;
  }

  generateProTip(_topic) {
    const tips = [
      `Pro tip: Start small and scale gradually`,
      `Remember: Consistency is more important than perfection`,
      `Quick tip: Document everything as you go`,
      `Expert advice: Focus on one aspect at a time`,
      `Insider secret: This works best when combined with regular practice`
    ];
    
    return tips[Math.floor(Math.random() * tips.length)];
  }

  async generateDemonstration(_strategy) {
    return {
      type: 'demonstration',
      title: 'Live Demo',
      content: [
        `Now let me show you exactly how this works.`,
        `[Screen recording or visual demonstration]`,
        `As you can see, the process is straightforward once you understand the basics.`,
        `The key is to follow the steps exactly as shown.`
      ],
      visuals: ['Screen recording', 'Step-by-step graphics'],
      duration: 120
    };
  }

  async generateExplanation(strategy) {
    return {
      type: 'explanation',
      title: 'Deep Dive',
      content: [
        `Let's break down ${strategy.topic} into its core components.`,
        `First, we need to understand the fundamental principles.`,
        `The science behind this is fascinating...`,
        `[Detailed explanation with visuals]`,
        `This is why ${strategy.topic} works so effectively.`
      ],
      visuals: ['Diagrams', 'Infographics', 'Charts'],
      duration: 90
    };
  }

  async generateExamples(strategy) {
    return {
      type: 'examples',
      title: 'Real-World Examples',
      content: [
        `Let's look at some real examples of ${strategy.topic} in action.`,
        `Example 1: [Specific case study]`,
        `Example 2: [Another relevant example]`,
        `Example 3: [Third compelling example]`,
        `These examples show the versatility and power of ${strategy.topic}.`
      ],
      visuals: ['Case study graphics', 'Before/after comparisons'],
      duration: 75
    };
  }

  async generateListItems(strategy) {
    const items = [];
    const numItems = 5 + Math.floor(Math.random() * 6); // 5-10 items
    
    for (let i = 1; i <= numItems; i++) {
      items.push({
        number: numItems - i + 1, // Countdown for engagement
        title: this.generateListItemTitle(strategy.topic, i),
        description: this.generateListItemDescription(strategy.topic),
        impact: this.generateImpactStatement()
      });
    }
    
    return {
      type: 'list_items',
      title: `Top ${numItems} Things About ${strategy.topic}`,
      items,
      duration: items.length * 30
    };
  }

  generateListItemTitle(topic, index) {
    const titles = [
      `The Hidden Power of ${topic}`,
      `Why ${topic} Matters More Than You Think`,
      `The Surprising Truth About ${topic}`,
      `How ${topic} Can Transform Your Approach`,
      `The ${topic} Secret Nobody Talks About`,
      `Mastering ${topic} in Record Time`,
      `The Ultimate ${topic} Hack`,
      `${topic}: The Game Changer`,
      `Breaking Down ${topic} Myths`,
      `The Future of ${topic}`
    ];
    
    return titles[index - 1] || `Advanced ${topic} Technique #${index}`;
  }

  generateListItemDescription(topic) {
    return `This aspect of ${topic} is crucial because it fundamentally changes how we approach the subject. Understanding this will give you a significant advantage.`;
  }

  generateImpactStatement() {
    const impacts = [
      'This alone can save you hours',
      'Game-changing for beginners',
      'Essential for long-term success',
      'Often overlooked but critical',
      'The difference between success and failure'
    ];
    
    return impacts[Math.floor(Math.random() * impacts.length)];
  }

  async generatePros(_strategy) {
    return {
      type: 'pros',
      title: 'The Benefits',
      points: [
        'Easy to get started',
        'Cost-effective solution',
        'Proven results',
        'Scalable approach',
        'Community support'
      ],
      duration: 45
    };
  }

  async generateCons(_strategy) {
    return {
      type: 'cons',
      title: 'Things to Consider',
      points: [
        'Learning curve at the beginning',
        'Requires consistent effort',
        'Results may vary',
        'Some technical knowledge helpful'
      ],
      duration: 30
    };
  }

  async generateComparison(strategy) {
    return {
      type: 'comparison',
      title: 'How It Compares',
      content: `Compared to alternatives, ${strategy.topic} stands out because of its unique approach and proven effectiveness.`,
      comparisonPoints: [
        'More efficient than traditional methods',
        'Better ROI than competitors',
        'Easier to implement',
        'More sustainable long-term'
      ],
      duration: 60
    };
  }

  async generateImplications(strategy) {
    return {
      type: 'implications',
      title: 'What This Means',
      content: [
        `The implications of ${strategy.topic} are far-reaching.`,
        'This will change how we think about the industry.',
        'Early adopters will have a significant advantage.',
        'The potential for growth is enormous.'
      ],
      duration: 45
    };
  }

  generateGenericSection(sectionType, strategy) {
    return {
      type: sectionType,
      title: sectionType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      content: `This section covers important aspects of ${strategy.topic} that you need to know.`,
      duration: 60
    };
  }

  async generateConclusion(strategy) {
    return {
      type: 'conclusion',
      title: 'Wrapping Up',
      recap: [this.t('recap', strategy)],
      finalThought: this.t('finalThought', strategy),
      duration: '30 seconds'
    };
  }

  async generateCTA(strategy) {
    return {
      type: 'call_to_action',
      subscribe: this.mandatoryCTA(strategy.callToAction, strategy),
      like: "Give this video a thumbs up if you learned something new.",
      comment: `Let me know in the comments: What's your experience with ${strategy.topic}?`,
      nextVideo: "Check out this related video for more insights.",
      duration: '15 seconds'
    };
  }

  formatFullScript(script) {
    let fullScript = '';
    
    // Title
    fullScript += `TITLE: ${script.title}\n\n`;
    fullScript += '═'.repeat(50) + '\n\n';
    
    // Hook
    fullScript += `[${script.hook.duration}] HOOK\n`;
    fullScript += `${script.hook.text}\n\n`;
    
    // Introduction
    fullScript += `[${script.introduction.duration}] INTRODUCTION\n`;
    fullScript += `${script.introduction.greeting}\n`;
    fullScript += `${script.introduction.topicIntro}\n`;
    fullScript += `${script.introduction.valueProposition}\n`;
    fullScript += `${script.introduction.credibility}\n\n`;
    
    // Main Content
    fullScript += 'MAIN CONTENT\n';
    fullScript += '─'.repeat(30) + '\n\n';
    
    for (const section of script.mainContent.sections) {
      fullScript += `[${this.formatDuration(section.duration)}] ${section.title.toUpperCase()}\n`;
      
      if (Array.isArray(section.content)) {
        section.content.forEach(line => {
          fullScript += `${line}\n`;
        });
      } else if (section.steps) {
        section.steps.forEach(step => {
          fullScript += `\n${step.title}\n`;
          fullScript += `${step.description}\n`;
          fullScript += `💡 ${step.tip}\n`;
        });
      } else if (section.items) {
        section.items.forEach(item => {
          fullScript += `\n#${item.number}: ${item.title}\n`;
          fullScript += `${item.description}\n`;
          fullScript += `Impact: ${item.impact}\n`;
        });
      } else if (section.points) {
        section.points.forEach(point => {
          fullScript += `• ${point}\n`;
        });
      } else {
        fullScript += `${section.content}\n`;
      }
      
      if (section.visuals) {
        fullScript += `\n[VISUALS: ${section.visuals.join(', ')}]\n`;
      }
      
      fullScript += '\n';
    }
    
    // Conclusion
    fullScript += `[${script.conclusion.duration}] CONCLUSION\n`;
    script.conclusion.recap.forEach(line => {
      fullScript += `${line}\n`;
    });
    fullScript += `\n${script.conclusion.finalThought}\n\n`;
    
    // Call to Action
    fullScript += `[${script.callToAction.duration}] CALL TO ACTION\n`;
    fullScript += `${script.callToAction.subscribe}\n`;
    fullScript += `${script.callToAction.like}\n`;
    fullScript += `${script.callToAction.comment}\n`;
    fullScript += `${script.callToAction.nextVideo}\n\n`;
    
    // Metadata
    fullScript += '═'.repeat(50) + '\n';
    fullScript += `ESTIMATED DURATION: ${script.duration}\n`;
    fullScript += `TONE: ${script.tone}\n`;
    fullScript += `PACING: ${script.pacing}\n`;
    fullScript += `KEYWORDS: ${script.keywords.join(', ')}\n`;
    
    return fullScript;
  }

  estimateDuration(mainContent) {
    const totalSeconds = mainContent.sections.reduce((total, section) => {
      return total + (section.duration || 60);
    }, 0);
    
    // Add hook, intro, conclusion, CTA
    const fullDuration = totalSeconds + 5 + 15 + 30 + 15;
    
    return this.formatDuration(fullDuration);
  }

  formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  calculateSectionsDuration(sections) {
    return sections.reduce((total, section) => total + (section.duration || 60), 0);
  }
}

module.exports = { ScriptWriterAgent, wordBudget, narrationWpm, normalizeExaminedClaim };
