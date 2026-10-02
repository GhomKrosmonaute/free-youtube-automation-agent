const fs = require('fs').promises;
const path = require('path');
const { runFFmpeg, getMediaDuration } = require('./ffmpeg');
const { Logger } = require('./logger');
const { extractJson } = require('./ai-json');
const {
  timedSentences, readWordTimings, captionCues, retimedWords, estimatedWords, cuesToSrt, sceneTimeline
} = require('./narration-timing');
const { scriptScenes } = require('./scene-repair-service');
const { ensureFonts, filterPath, assDocument, glueTypography, PALETTES, paletteFor } = require('./visualizer');
const { hasSubscribeCall, subscribeSentence, subscribeLine } = require('./subscribe-cta');
const backgroundMusic = require('./background-music');
const { siteLink } = require('./claims-site');
const { registerOf, isOpening } = require('./content-mode');
const { reactProfile, twoPartVideos } = require('./react-profile');

// "native": vertical montage rebuilt from the clean scene illustrations and the scene recordings (no burned 16:9
// titles or captions). The other layouts reframe the finished 16:9 video, which already carries its own captions;
// they remain for productions without illustrations and are never chosen by the autonomous path.
const LAYOUTS = new Set(['native', 'blur', 'crop', 'stacked']);
const LANGUAGE = process.env.CONTENT_LANGUAGE || 'en';
const FR = LANGUAGE === 'fr';
// Deciding which sentences make a Short is an editorial judgement: it goes to the most capable model.
const DEFAULT_SHORTS_MODEL = 'claude-fable-5-1';
const LOCKED = ['approved', 'scheduled', 'uploading', 'published', 'reconciliation_required'];
// A Short is a montage of the strongest sentences of one argument: 15 to 40 seconds of speech (20 to 30 aimed),
// then the subscribe line.
const SPEECH = { min: 15, max: 40, aim: [20, 30] };
const MAX_CUTS = 6;
const MAX_HOOK_SECONDS = 7;
const LEAD = 0.06; // before the first word of a cut, never into the previous sentence
const TRAIL = 0.12; // after its last word, never into the next sentence
const CUT_GAP = 0.15; // a breath between two cuts
const CTA_GAP = 0.35;
const TAIL = 0.6; // the end card stays on screen after the last word
const SHOT_SECONDS = 4.5; // a held illustration is re-framed about this often
const EDITOR_SCORES = ['hook', 'standalone', 'density', 'payoff'];
const CRITIC_SCORES = ['hook', 'clarity', 'density', 'fidelity', 'payoff'];
const MIN_FIDELITY = 8;
// Openings that can only continue something said before. The first sentence of a Short cannot start on them,
// nor on a pronoun or demonstrative ("Ce mécanisme…", "Il montre…") whose referent the viewer never heard.
const BACK_REFERENCE = /^(«\s*)?(deuxième|troisième|quatrième|cinquième|dernier|dernière|ensuite|mais|donc|or|autrement dit|bref|enfin|puis|du coup|par ailleurs|de plus|second|third|then|but|so|also)\b/i;
const BACK_REFERENCE_OPENING = /^(«\s*)?(ce(?!\s+(que|qui|qu['’]))|cet|cette|ces|cela|ça|ceci|celui(?!\s+qui)|celle(?!\s+qui)|il(?!\s+y\s+a)|elle|ils|elles|lui|eux|là|this|that|these|those|it|they)(?![\p{L}\p{N}])/iu;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || minimum));
}

function sentence(value = '') {
  return String(value).trim().split(/(?<=[.!?])\s+/)[0]?.trim() || '';
}

function truncate(value, maximum) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(0, maximum - 1)).trim()}…`;
}

// A description keeps its paragraphs: only the length is capped.
function limit(value, maximum) {
  const text = String(value || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;
}

function round(value) {
  return Number(Number(value).toFixed(3));
}

// Letters and digits only: compares what is heard with what is captioned regardless of spacing and punctuation.
function spokenKey(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function cutLabel([first, last]) {
  return first === last ? String(first) : `${first}-${last}`;
}

class ShortsRepurposingService {
  constructor(db, publishing, options = {}) {
    this.db = db;
    this.publishing = publishing;
    this.social = options.social || null;
    this.logger = options.logger || new Logger('ShortsRepurposing');
    this.aiTextService = options.aiTextService || null;
    this.model = options.model || process.env.SHORTS_MODEL || DEFAULT_SHORTS_MODEL;
    this.minScore = Number(options.minScore || process.env.SHORTS_MIN_SCORE || 7);
    this.dataRoot = options.dataRoot || path.join(__dirname, '..', 'data', 'shorts');
    this.width = Number(options.width || 1080);
    this.height = Number(options.height || 1920);
    this.runFFmpeg = options.runFFmpeg || runFFmpeg;
    this.synthesize = options.synthesize || null;
  }

  // input.requireAI: refuse the mechanical fallback (used by the autonomous path, which would rather publish
  // no Short than a cut without a conclusion). input.append: add Shorts next to the existing ones, without reusing
  // the sentences of those already approved or published; only the new drafts are returned. Returns [] when the
  // editor found no Short worth publishing.
  async propose(productionId, input = {}) {
    const bundle = await this.requireSource(productionId);
    const existing = await this.db.listShortClips(productionId);
    const append = input.append === true;
    if (existing.length && input.replace !== true && !append) return existing;
    if (!append && existing.some(clip => LOCKED.includes(clip.status))) {
      const error = new Error('Approved, scheduled, or published Shorts cannot be replaced');
      error.status = 409;
      throw error;
    }

    const count = Math.round(clamp(input.count || 3, 1, 5));
    const sourceScenes = bundle.scenes || [];
    const scenes = sourceScenes.filter(scene =>
      scene.assetPath && scene.status === 'ready' &&
      ['current', 'intentional_silence'].includes(scene.narrationStatus)
    );
    if (!scenes.length || scenes.length !== sourceScenes.length) {
      const error = new Error('Every source scene must be rebuilt and current before creating Short drafts');
      error.status = 409;
      throw error;
    }

    const sourceTitle = bundle.editorData?.title || bundle.seo?.title || bundle.script?.title || bundle.strategy?.topic || 'Untitled video';
    const baseTime = this.nextPublishBase(bundle);
    const inheritedEvidence = this.inheritedEvidence(bundle);
    const tags = [...new Set([...(bundle.seo?.tags || []), 'Shorts'])].slice(0, 15);
    const native = Boolean(bundle.assets?.audio?.path) && await this.hasIllustrations(scenes, scenes);
    if (input.requireAI && !native) {
      // A reframed 16:9 video is not a Short the channel publishes on its own.
      this.logger.warn(`No autonomous Short for ${productionId}: the scene illustrations are missing`);
      return [];
    }
    const profile = await this.db.getChannelProfile?.().catch(() => null) || null;
    const channelId = await this.db.getSetting?.('youtube_channel_id').catch(() => null) || null;
    const subscribe = subscribeLine(profile?.call_to_action, channelId);

    let selections = null;
    let cta = null;
    if (this.aiTextService?.isAvailable?.()) {
      const transcript = await this.buildTranscript(bundle, scenes);
      // Every Short ends asking to subscribe: without that line there is no Short.
      cta = native ? await this.ctaFor(transcript, bundle, profile) : null;
      if (native && !cta && input.requireAI) {
        this.logger.warn(`No autonomous Short for ${productionId}: no subscribe line to close it with`);
        return [];
      }
      try {
        const live = existing.filter(clip => LOCKED.includes(clip.status));
        selections = await this.selectWithAI(transcript, bundle, count, {
          exclude: append ? this.usedSentences(live, transcript) : new Set(),
          allowCuts: native,
          profile
        });
      } catch (error) {
        this.logger.warn(`AI Short selection failed: ${String(error.message).slice(0, 300)}`);
      }
    }
    if (!selections && input.requireAI) {
      const error = new Error('No AI editor is available to edit Short montages');
      error.status = 503;
      throw error;
    }

    let clips;
    if (selections) {
      clips = selections.map((selection, position) => {
        const timeline = this.montageTimeline(selection.segments, cta);
        return {
          productionId,
          position,
          title: truncate(selection.title, 96),
          description: limit(`${selection.description}\n\n${subscribe}\n\n#Shorts`, 5000),
          tags,
          sourceSceneIds: selection.sceneIds,
          startSeconds: selection.segments[0].start,
          duration: round(timeline.total),
          layout: native ? 'native' : 'blur',
          rationale: truncate(selection.rationale, 1000),
          status: 'proposed',
          publishTime: new Date(baseTime.getTime() + position * 86400000).toISOString(),
          privacyStatus: 'private',
          inheritedEvidence,
          segments: selection.segments,
          cta: native ? cta : null,
          critic: selection.critic || {}
        };
      });
    } else {
      const windows = this.selectWindows(scenes, count);
      clips = windows.map((window, position) => {
        const lead = window.scenes[0];
        const hook = sentence(lead.scriptText) || lead.label || sourceTitle;
        return {
          productionId,
          position,
          title: truncate(hook, 96),
          description: limit(FR
            ? `Extrait de « ${sourceTitle} ». La vidéo complète est sur la chaîne.\n\n${subscribe}\n\n#Shorts`
            : `A quick takeaway from ${sourceTitle}. Watch the full video on this channel.\n\n${subscribe}\n\n#Shorts`, 5000),
          tags,
          sourceSceneIds: window.scenes.map(scene => scene.id),
          startSeconds: window.startSeconds,
          duration: window.duration,
          layout: native ? 'native' : position === 1 ? 'crop' : position === 2 ? 'stacked' : 'blur',
          rationale: `Selected from ${window.scenes.map(scene => scene.label).join(', ')} as a self-contained vertical excerpt.`,
          status: 'proposed',
          publishTime: new Date(baseTime.getTime() + position * 86400000).toISOString(),
          privacyStatus: 'private',
          inheritedEvidence
        };
      });
    }
    if (!append) return this.db.replaceShortClips(productionId, clips);
    const known = new Set(existing.map(clip => clip.id));
    return (await this.db.appendShortClips(productionId, clips)).filter(clip => !known.has(clip.id));
  }

  // Every sentence of the narration with its absolute time in the video, its scene and its register.
  // Word timings give exact bounds; otherwise estimated bounds are snapped to real pauses.
  async buildTranscript(bundle, scenes) {
    const registers = scriptScenes(bundle.script || {}).map(blueprint => blueprint.register);
    const silences = await this.detectSilences(bundle.assets?.audio?.path);
    const transcript = [];
    for (const scene of sceneTimeline(scenes)) {
      const words = await readWordTimings(scene.audioPath);
      const cta = /^call to action$/i.test(String(scene.label || '').trim());
      for (const item of timedSentences(scene.scriptText, scene.duration, words)) {
        let start = scene.startSeconds + item.start;
        let end = scene.startSeconds + item.end;
        if (!words) {
          start = this.snapToSilence(start, silences, scene.startSeconds, scene.startSeconds + scene.duration);
          end = this.snapToSilence(end, silences, scene.startSeconds, scene.startSeconds + scene.duration);
        }
        transcript.push({
          index: transcript.length, sceneId: scene.id, sceneLabel: scene.label, register: registerOf(registers[scene.position]),
          text: item.text, start, end: Math.max(start + 0.3, end), timed: Boolean(words), cta
        });
      }
    }
    return transcript;
  }

  async detectSilences(audioPath) {
    if (!audioPath) return [];
    try {
      const result = await this.runFFmpeg(['-hide_banner', '-nostats', '-i', audioPath, '-af', 'silencedetect=noise=-35dB:d=0.16', '-f', 'null', '-']);
      const log = String(result?.stderr || '');
      const silences = [];
      const pattern = /silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g;
      let match;
      while ((match = pattern.exec(log))) silences.push({ start: Number(match[1]), end: Number(match[2]) });
      return silences;
    } catch (_error) {
      return [];
    }
  }

  snapToSilence(time, silences, lower, upper) {
    let best = null;
    for (const silence of silences) {
      const middle = (silence.start + silence.end) / 2;
      if (middle < lower - 0.2 || middle > upper + 0.2) continue;
      if (Math.abs(middle - time) <= 1.5 && (!best || Math.abs(middle - time) < Math.abs(best - time))) best = middle;
    }
    return best ?? time;
  }

  // The closing subscribe line of every Short: the sentence of the video's call to action that asks to subscribe,
  // cut from its recording. A video without one gets the channel's line synthesized in the narration voice.
  async ctaFor(transcript, bundle, profile) {
    const item = transcript.find(entry => entry.cta && entry.timed && hasSubscribeCall(entry.text));
    if (item) {
      const segment = this.segmentFor(transcript, item.index, item.index);
      return { kind: 'narration', start: segment.start, end: segment.end, text: item.text };
    }
    const synthesize = this.synthesize || (process.env.AZURE_SPEECH_KEY ? require('./azure-tts').synthesize : null);
    if (!synthesize) return null;
    const text = subscribeSentence(profile?.call_to_action);
    const output = path.join(this.dataRoot, bundle.id, 'subscribe.mp3');
    try {
      await synthesize(text, output);
      return { kind: 'file', path: output, duration: round(await getMediaDuration(output)), text };
    } catch (error) {
      this.logger.warn(`Subscribe line could not be synthesized: ${error.message}`);
      return null;
    }
  }

  // Sentences already used by the given Shorts (their cuts, or the window of an older single-passage Short).
  usedSentences(clips, transcript) {
    const ranges = clips.flatMap(clip => clip.segments?.length
      ? clip.segments
      : [{ start: clip.startSeconds, end: clip.startSeconds + clip.duration }]);
    return new Set(transcript.filter(item => {
      const middle = (item.start + item.end) / 2;
      return ranges.some(range => middle >= range.start && middle <= range.end);
    }).map(item => item.index));
  }

  async generate(prompt, options) {
    try {
      return await this.aiTextService.generateText(prompt, { model: this.model, ...options });
    } catch (error) {
      if (!this.model || this.model === this.aiTextService.model) throw error;
      // The account may not offer the requested model: fall back to the default text model.
      this.logger.warn(`Shorts model ${this.model} unavailable (${String(error.message).slice(0, 160)}); using ${this.aiTextService.model}`);
      return this.aiTextService.generateText(prompt, options);
    }
  }

  // The editor composes montages from the transcript; each one then goes before an independent critic.
  async selectWithAI(transcript, bundle, count, { exclude = new Set(), allowCuts = true, profile = null } = {}) {
    if (!transcript.length) return [];
    const lines = transcript.filter(item => !item.cta && !exclude.has(item.index)).map(item =>
      `[${item.index}] (${(item.end - item.start).toFixed(1)}s, ${twoPartVideos() ? `${item.register}, ` : ''}« ${item.sceneLabel} ») ${item.text}`
    ).join('\n');
    const calibration = await this.calibration();
    const candidates = Math.min(6, count * 2);
    const prompt = `You are the Shorts editor of a YouTube channel${profile?.channel_name ? ` called "${profile.channel_name}"` : ''}. Your Shorts also go to TikTok and Instagram Reels.
Brand voice: ${profile?.brand_voice || 'clear and engaging'}
Published video: "${bundle.script?.title || bundle.seo?.title || ''}"

Below is the full narration, one numbered sentence per line, with its spoken duration, ${twoPartVideos() ? `its part of the video ${reactProfile().shorts?.partsNote || '("opening" = the first part, "main" = the main part, after the turn)'} ` : ''}and its chapter.${exclude.size ? ' Sentences already used by published Shorts are left out.' : ''}

${lines}
${calibration ? `\n${calibration}\n` : ''}
Edit at most ${candidates} Shorts. A Short is ${allowCuts ? `a montage: keep only the strongest sentences of ONE line of argument and cut everything else. Write it as "cuts", an ordered list of at most ${MAX_CUTS} [first, last] sentence ranges (inclusive) played back to back` : 'one contiguous passage: "cuts" holds a single [first, last] sentence range (inclusive)'}.
What makes a Short worth watching:
- The first sentence is the hook: a surprising fact, a precise figure, a provocative question or a bold claim that stops someone scrolling within two seconds. It is short (at most ${MAX_HOOK_SECONDS - 1} seconds) and needs no context: it never starts with a connector, a back-reference, a pronoun or a demonstrative ("Deuxième…", "Mais…", "Donc…", "Ce…", "Cette…", "Il…", "Autrement dit…").
- Then only sentences that carry the argument: a named source, a date, a figure, a concrete example, a quotation, a decisive step of the reasoning. Cut transitions, reformulations, hedges, announcements ("voyons…", "on va voir…"), a second example of a point already made and rhetorical padding.${allowCuts ? ' A passage of a long video almost always holds a sentence or two a Short does not need: cut them. Keep a passage whole only when every one of its sentences is indispensable.' : ''}
- The last sentence lands the point: the conclusion or a punchline that closes the idea.
- ${SPEECH.aim[0]} to ${SPEECH.aim[1]} seconds of speech (sum of the durations), never under ${SPEECH.min} nor over ${SPEECH.max}. Shorter is better once the argument is complete.
${allowCuts ? `Montage rules (the meaning must survive the cuts):
- Ranges stay in the order of the video: never reorder sentences.
- After each cut, the next sentence must not depend on a sentence you removed: no pronoun, "ce", "cela", "cette", "ces", "il" or "là" pointing to something cut, no "deuxièmement" whose "premièrement" was cut.
- Cold open (optional): when the strongest hook of the argument is not where it starts (a striking figure, the punchline, a provocative claim), set "hook" to that sentence's number: it plays first, then the cuts in order without it. Only a sentence that reads naturally as an opening, does not lean on what precedes it and does not distort the argument once moved; otherwise "hook" is null.
- The montage says nothing the full video does not say: never join two sentences so that they suggest a claim the narration does not make, never cut a qualification that changes the meaning of a claim.
` : ''}${twoPartVideos() ? `- ${reactProfile().shorts?.mainPartRule || 'It carries the point of the main part: at least one sentence from the main part.'}\n` : ''}- Different Shorts never share a sentence.
- The closing subscribe line is added automatically: do not include the video's call to action.
Score each Short from 1 to 10 on hook, standalone (understood without the video), density (every sentence earns its place) and payoff. Only return Shorts scoring at least ${this.minScore} on all four: an empty list is better than a weak Short.
For each Short, write in the language with ISO code "${LANGUAGE}":
- "title": at most 70 characters, makes someone scrolling stop, states the question or the surprise; not a copy of its first sentence${reactProfile().shorts?.titleRule ? `; ${reactProfile().shorts.titleRule}` : ''}.
- "description": one or two sentences in the brand voice${reactProfile().shorts?.descriptionRule ? `, ${reactProfile().shorts.descriptionRule}` : ''}, ending with an invitation to watch the full video on the channel.
Return only JSON: {"shorts":[{"cuts":[[0,0]],${allowCuts ? '"hook":null,' : ''}"title":"","description":"","scores":{"hook":0,"standalone":0,"density":0,"payoff":0},"why":"one sentence on why it stands alone"}]}`;

    // Two editing rounds at most: the second one reads why the critic rejected the first montages.
    const accepted = [];
    let rejected = [];
    for (let round = 0; round < 2 && accepted.length < count; round++) {
      const feedback = rejected.length
        ? `\nA critic who watches Shorts like your audience rejected these montages. Edit new ones that avoid these faults (their sentences may be reused differently):\n${rejected.map(item => `- "${item.title}" (sentences ${item.cuts.map(cutLabel).join(', ')}): ${item.critic.reason || 'below the bar'}`).join('\n')}\n`
        : '';
      const parsed = extractJson(await this.generate(`${prompt}${feedback}`, { maxTokens: 5000, temperature: 0.4, purpose: 'shorts_editor' }));
      const proposals = Array.isArray(parsed) ? parsed : parsed?.shorts;
      if (!Array.isArray(proposals)) throw new Error('The Shorts editor returned no list');
      const taken = new Set([...exclude, ...accepted.flatMap(item => item.sentences)]);
      rejected = [];
      for (const selection of this.validateSelections(proposals, transcript, candidates, { exclude: taken, allowCuts })) {
        if (accepted.length >= count) break;
        if (accepted.some(item => item.sentences.some(index => selection.sentences.includes(index)))) continue;
        const reviewed = await this.review(selection, transcript, bundle, { exclude: taken, allowCuts });
        if (reviewed.passed) accepted.push(reviewed);
        else rejected.push(reviewed);
      }
    }
    return accepted.sort((a, b) => a.segments[0].start - b.segments[0].start);
  }

  // The editor's proposals that respect the hard rules, best scored first, sharing no sentence.
  validateSelections(candidates, transcript, limit, options = {}) {
    const accepted = [];
    const scored = candidates.map(candidate => {
      const scores = candidate?.scores || {};
      const values = EDITOR_SCORES.map(key => Number(scores[key]) || 0);
      return { candidate, minimum: Math.min(...values), total: values.reduce((sum, value) => sum + value, 0) };
    }).sort((a, b) => b.total - a.total);
    for (const { candidate, minimum } of scored) {
      if (minimum < this.minScore) continue;
      const selection = this.buildSelection(candidate, transcript, options);
      if (!selection) continue;
      if (accepted.some(item => item.sentences.some(index => selection.sentences.includes(index)))) continue;
      accepted.push(selection);
      if (accepted.length >= limit) break;
    }
    return accepted;
  }

  buildSelection(candidate, transcript, { exclude = new Set(), allowCuts = true } = {}) {
    const raw = Array.isArray(candidate?.cuts) ? candidate.cuts : [[candidate?.start, candidate?.end]];
    const ranges = [];
    for (const cut of raw) {
      const [first, last] = Array.isArray(cut) ? cut.map(Number) : [];
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last >= transcript.length || last < first) return null;
      const previous = ranges[ranges.length - 1];
      if (previous && first <= previous[1]) return null; // never reordered, never overlapping
      if (previous && first === previous[1] + 1) previous[1] = last;
      else ranges.push([first, last]);
    }
    if (!ranges.length || ranges.length > MAX_CUTS || (!allowCuts && ranges.length > 1)) return null;
    // Cold open: one sentence of the same argument, usually its most striking one, played first and not repeated.
    let coldOpen = null;
    let heard = ranges;
    if (candidate.hook !== null && candidate.hook !== undefined && candidate.hook !== '' && allowCuts) {
      const hook = Number(candidate.hook);
      if (!Number.isInteger(hook) || hook < ranges[0][0] || hook > ranges[ranges.length - 1][1]) return null;
      if (hook !== ranges[0][0]) {
        const body = ranges.flatMap(([first, last]) => (hook < first || hook > last
          ? [[first, last]]
          : [[first, hook - 1], [hook + 1, last]].filter(([from, to]) => from <= to)));
        if (!body.length || body.length > MAX_CUTS) return null;
        coldOpen = hook;
        heard = [[hook, hook], ...body];
      }
    }
    const sentences = heard.flatMap(([first, last]) => Array.from({ length: last - first + 1 }, (_, offset) => first + offset));
    const items = sentences.map(index => transcript[index]);
    if (items.some(item => item.cta || exclude.has(item.index))) return null;
    // Cutting inside a passage needs the exact word timings.
    if (ranges.length > 1 && items.some(item => !item.timed)) return null;
    // A two-part video's Short carries the main part, never the opening alone.
    if (twoPartVideos() && !items.some(item => item.register === 'main')) return null;
    const hook = items[0];
    if (BACK_REFERENCE.test(hook.text) || BACK_REFERENCE_OPENING.test(hook.text) || hook.end - hook.start > MAX_HOOK_SECONDS) return null;
    const segments = heard.map(([first, last]) => ({
      ...this.segmentFor(transcript, first, last),
      first, last,
      text: transcript.slice(first, last + 1).map(item => item.text).join(' ')
    }));
    const speech = segments.reduce((sum, segment) => sum + segment.end - segment.start, 0);
    if (speech < SPEECH.min || speech > SPEECH.max) return null;
    const title = String(candidate.title || '').trim();
    if (!title) return null;
    return {
      cuts: heard, coldOpen, sentences, segments, speech, title,
      description: String(candidate.description || '').trim(),
      scores: candidate.scores || {},
      sceneIds: [...new Set(items.map(item => item.sceneId))],
      rationale: `Sentences ${coldOpen !== null ? `${coldOpen} (cold open), ` : ''}${(coldOpen !== null ? heard.slice(1) : heard).map(cutLabel).join(', ')}. ${String(candidate.why || '').trim()}`.trim()
    };
  }

  // Source bounds of sentences first..last: a hair before the first word and after the last one, never into the
  // neighbouring sentences.
  segmentFor(transcript, first, last) {
    const previousEnd = first > 0 ? transcript[first - 1].end : 0;
    const nextStart = last + 1 < transcript.length ? transcript[last + 1].start : transcript[last].end + 1;
    return {
      start: round(Math.max(previousEnd, transcript[first].start - LEAD, 0)),
      end: round(Math.min(nextStart, transcript[last].end + TRAIL))
    };
  }

  // An independent critic judges the montage as a viewer would. The sentences it would drop are cut and the tighter
  // montage is judged again: it replaces the first one when it passes. Returns the montage with the critic's verdict
  // and `passed`.
  async review(selection, transcript, bundle, options = {}) {
    const verdict = await this.critique(selection, transcript, bundle);
    const judged = { ...selection, critic: { ...verdict, revised: false }, passed: this.accepts(verdict) };
    if (!judged.passed) this.logger.info(`Shorts critic rejected "${selection.title}" (${this.scoreLine(verdict)}): ${verdict.reason || 'below the bar'}`);
    const tighter = this.withoutSentences(judged, verdict.drop, transcript, options);
    if (tighter) {
      const second = await this.critique(tighter, transcript, bundle);
      if (this.accepts(second)) return { ...tighter, critic: { ...second, revised: true, first: verdict }, passed: true };
      this.logger.info(`Shorts critic rejected the tightened "${selection.title}" (${this.scoreLine(second)}): ${second.reason || 'below the bar'}`);
    }
    return judged;
  }

  scoreLine(verdict = {}) {
    return [...CRITIC_SCORES.map(key => `${key} ${verdict.scores?.[key] ?? '?'}`), `swipe ${verdict.swipeAt ?? '-'}`, verdict.verdict || '?'].join(', ');
  }

  // The montage without the given sentences (numbered from 1 in the order heard), or null when what remains breaks
  // the hard rules.
  withoutSentences(selection, numbers = [], transcript, options = {}) {
    const drop = new Set(numbers.map(number => selection.sentences[Number(number) - 1]).filter(index => index !== undefined));
    if (!drop.size || drop.size >= selection.sentences.length) return null;
    const kept = selection.sentences.filter(item => !drop.has(item));
    const hook = selection.coldOpen !== null && selection.coldOpen !== undefined && kept[0] === selection.coldOpen ? selection.coldOpen : null;
    const cuts = [];
    for (const index of kept.filter(item => item !== hook).sort((a, b) => a - b)) {
      const previous = cuts[cuts.length - 1];
      if (previous && index === previous[1] + 1) previous[1] = index;
      else cuts.push([index, index]);
    }
    if (hook !== null) {
      // The cold open goes back where it was, so the body's span still contains it.
      const at = cuts.findIndex(([first]) => first > hook);
      cuts.splice(at === -1 ? cuts.length : at, 0, [hook, hook]);
      for (let index = cuts.length - 1; index > 0; index--) {
        if (cuts[index][0] === cuts[index - 1][1] + 1) cuts.splice(index - 1, 2, [cuts[index - 1][0], cuts[index][1]]);
      }
    }
    return this.buildSelection({ ...selection, cuts, hook, why: selection.rationale.replace(/^Sentences [^.]*\.\s*/, '') }, transcript, options);
  }

  accepts(verdict = {}) {
    const scores = verdict.scores || {};
    return CRITIC_SCORES.every(key => (Number(scores[key]) || 0) >= this.minScore) &&
      (Number(scores.fidelity) || 0) >= MIN_FIDELITY &&
      !verdict.swipeAt && String(verdict.verdict || '').toLowerCase() === 'publish';
  }

  async critique(selection, transcript, bundle) {
    let number = 0;
    const heard = selection.cuts.map(([first, last], cut) => transcript.slice(first, last + 1)
      .map(item => `(${++number}) [${(item.end - item.start).toFixed(1)}s]${cut === 0 && selection.coldOpen !== null && selection.coldOpen !== undefined ? ' [cold open: moved from later in the passage]' : ''} ${item.text}`).join('\n')).join('\n✂\n');
    const firstIndex = Math.min(...selection.sentences);
    const lastIndex = Math.max(...selection.sentences);
    const original = truncate(transcript.slice(firstIndex, lastIndex + 1).map(item => item.text).join(' '), 7000);
    const calibration = await this.calibration();
    const prompt = `You are a demanding viewer of YouTube Shorts, TikTok and Reels, and a senior short-form editor. Judge this Short honestly: most Shorts are swiped away within two seconds, and a montage can betray what its source says.
It comes from the video "${bundle.script?.title || bundle.seo?.title || ''}".

Title shown on screen: "${selection.title}"
What the viewer hears, sentence by sentence ("✂" marks a cut where sentences of the original were removed), followed by the channel's subscribe line:
${heard}

The original narration from the first to the last sentence, to judge the fidelity of the cuts:
«${original}»
${calibration ? `\n${calibration}\n` : ''}
Score from 1 to 10:
- hook: would you stop scrolling within the first two seconds?
- clarity: does someone who never saw the video understand every sentence?
- density: does every sentence earn its place (a fact, a source, a step of the reasoning)?
- fidelity: do the cuts keep the meaning of the original, with no sentence depending on something removed and no claim the original does not make?
- payoff: does the ending land?
"swipeAt": the number of the sentence where a typical viewer would swipe away, or null if they would watch to the end.
"drop": the numbers of the sentences that weaken the Short and could be removed without breaking it (empty if none).
"verdict": "publish" or "reject"; "reason": one sentence.
Return only JSON: {"scores":{"hook":0,"clarity":0,"density":0,"fidelity":0,"payoff":0},"swipeAt":null,"drop":[],"verdict":"","reason":""}`;
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed?.scores; attempt++) {
      let answer = '';
      try {
        answer = await this.generate(prompt, { maxTokens: 1200, temperature: 0.2, purpose: 'shorts_critic' });
        parsed = extractJson(answer);
      } catch (error) {
        parsed = null;
        this.logger.warn(`Shorts critic answer unreadable (${String(error.message).slice(0, 120)}): ${String(answer).slice(0, 600)}`);
      }
      if (parsed && !parsed.scores) this.logger.warn(`Shorts critic answer without scores: ${String(answer).slice(0, 600)}`);
    }
    parsed = parsed || { reason: 'the critic gave no readable verdict' };
    return {
      scores: Object.fromEntries(CRITIC_SCORES.map(key => [key, Number(parsed.scores?.[key]) || 0])),
      swipeAt: parsed.swipeAt ? Number(parsed.swipeAt) || null : null,
      drop: Array.isArray(parsed.drop) ? parsed.drop.map(Number).filter(Number.isInteger) : [],
      verdict: String(parsed.verdict || 'reject').toLowerCase(),
      reason: truncate(parsed.reason, 300)
    };
  }

  // What the channel's audience actually watched: the best and worst measured Shorts, so the editor and the critic
  // judge against real retention rather than taste alone.
  async calibration() {
    if (!this.db?.listMeasuredShortClips) return '';
    try {
      const measured = (await this.db.listMeasuredShortClips(60))
        .filter(clip => Number(clip.performance?.views) >= 100 && Number.isFinite(Number(clip.performance?.averageViewPercentage)));
      if (measured.length < 4) return '';
      const sorted = [...measured].sort((a, b) => b.performance.averageViewPercentage - a.performance.averageViewPercentage);
      const line = clip => {
        const opening = clip.segments?.[0]?.text ? sentence(clip.segments[0].text) : '';
        return `- "${clip.title}" (${Math.round(clip.duration)} s): ${Math.round(clip.performance.averageViewPercentage)}% watched on average, ${clip.performance.views} views${opening ? `; opens on « ${truncate(opening, 160)} »` : ''}`;
      };
      const best = sorted.slice(0, 3);
      const worst = sorted.slice(-3).filter(clip => !best.includes(clip));
      return `What this channel's audience actually watched (YouTube Shorts retention):\nBest:\n${best.map(line).join('\n')}\nWorst:\n${worst.map(line).join('\n')}`;
    } catch (error) {
      this.logger.warn(`Shorts calibration unavailable: ${error.message}`);
      return '';
    }
  }

  // Retention of each published Short once it has had three days to find its audience, measured again weekly for a
  // month. calibration() shows the editor and the critic what this audience actually watched.
  async measurePerformance(analytics, now = new Date()) {
    const query = analytics?.youtubeAnalytics?.reports?.query?.bind(analytics.youtubeAnalytics.reports);
    if (!query || !this.db?.listShortClipsToMeasure) return 0;
    const day = 86400000;
    const clips = (await this.db.listShortClipsToMeasure(
      new Date(now.getTime() - 3 * day).toISOString(), new Date(now.getTime() - 7 * day).toISOString()
    )).filter(clip => now.getTime() - new Date(clip.publishTime).getTime() <= 35 * day || !clip.performance?.measuredAt);
    let measured = 0;
    for (const clip of clips) {
      try {
        const response = await query({
          ids: 'channel==MINE',
          startDate: String(clip.publishTime).slice(0, 10),
          endDate: now.toISOString().slice(0, 10),
          metrics: 'views,averageViewDuration,averageViewPercentage',
          filters: `video==${clip.youtubeId}`
        });
        const [views = 0, averageViewDuration = 0, averageViewPercentage = 0] = response?.data?.rows?.[0] || [];
        await this.db.updateShortClip(clip.id, {
          performance: { views, averageViewDuration, averageViewPercentage, measuredAt: now.toISOString() }
        });
        measured++;
      } catch (error) {
        this.logger.warn(`Retention of Short ${clip.youtubeId} not measured: ${error.message}`);
      }
    }
    return measured;
  }

  // Mechanical fallback when no AI editor is available: scene-anchored windows.
  selectWindows(scenes, requestedCount) {
    const timeline = [];
    let cursor = 0;
    for (const scene of scenes) {
      const duration = clamp(scene.duration || 5, 1, 180);
      timeline.push({ ...scene, startSeconds: cursor, duration });
      cursor += duration;
    }
    const count = Math.min(requestedCount, timeline.length);
    const anchorIndexes = [];
    for (let index = 0; index < count; index++) {
      anchorIndexes.push(Math.min(timeline.length - 1, Math.floor(index * timeline.length / count)));
    }
    return [...new Set(anchorIndexes)].map(anchorIndex => {
      const selected = [timeline[anchorIndex]];
      let total = selected[0].duration;
      let next = anchorIndex + 1;
      while (total < 20 && next < timeline.length && total + timeline[next].duration <= 60) {
        selected.push(timeline[next]);
        total += timeline[next].duration;
        next++;
      }
      let previous = anchorIndex - 1;
      while (total < 15 && previous >= 0 && total + timeline[previous].duration <= 60) {
        selected.unshift(timeline[previous]);
        total += timeline[previous].duration;
        previous--;
      }
      return {
        scenes: selected,
        startSeconds: selected[0].startSeconds,
        duration: Math.min(180, total)
      };
    });
  }

  async hasIllustrations(scenes, allScenes = scenes) {
    for (const scene of scenes) {
      if (!await this.illustrationFor(scene, allScenes)) return false;
    }
    return scenes.length > 0;
  }

  // The clean illustration of a scene. A scene drawn without one of its own (the call to action reuses the previous
  // picture) shows the nearest earlier illustration, as in the long video.
  async illustrationFor(scene, allScenes = []) {
    const own = await this.ownIllustration(scene);
    if (own) return own;
    const earlier = allScenes.filter(other => other.position < scene.position).sort((a, b) => b.position - a.position);
    for (const other of earlier) {
      const candidate = await this.ownIllustration(other);
      if (candidate) return candidate;
    }
    return null;
  }

  async ownIllustration(scene) {
    const candidates = [];
    if (scene.assetType === 'image' && scene.assetPath) candidates.push(scene.assetPath);
    if (scene.assetPath) {
      candidates.push(path.join(path.dirname(scene.assetPath), `${String(scene.position).padStart(3, '0')}_illustration.png`));
    }
    for (const candidate of candidates) {
      if (await this.isFile(candidate)) return candidate;
    }
    return null;
  }

  async isFile(filePath) {
    try {
      const stats = await fs.stat(filePath);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  async update(productionId, clipId, input = {}) {
    const clip = await this.requireClip(productionId, clipId);
    if (LOCKED.includes(clip.status)) {
      const error = new Error('This Short is locked after approval');
      error.status = 409;
      throw error;
    }
    const changes = {};
    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title || title.length > 100) throw new Error('Short title must be between 1 and 100 characters');
      changes.title = title;
    }
    if (input.description !== undefined) changes.description = String(input.description).trim().slice(0, 5000);
    if (input.tags !== undefined) {
      const tags = Array.isArray(input.tags) ? input.tags : String(input.tags).split(',');
      changes.tags = [...new Set(tags.map(tag => String(tag).trim()).filter(Boolean))].slice(0, 30);
    }
    if (input.layout !== undefined) {
      if (!LAYOUTS.has(input.layout)) throw new Error('Short layout must be native, blur, crop, or stacked');
      changes.layout = input.layout;
    }
    if (input.publishTime !== undefined) {
      const date = new Date(input.publishTime);
      if (Number.isNaN(date.getTime())) throw new Error('Short publish time is invalid');
      changes.publishTime = date.toISOString();
    }
    if (input.privacyStatus !== undefined) {
      if (!['private', 'unlisted', 'public'].includes(input.privacyStatus)) throw new Error('Short privacy is invalid');
      changes.privacyStatus = input.privacyStatus;
    }
    if (clip.status === 'rendered' && Object.keys(changes).some(key => ['layout', 'title'].includes(key))) {
      changes.status = 'proposed';
      changes.outputPath = null;
      changes.captionsPath = null;
    }
    return this.db.updateShortClip(clipId, changes);
  }

  async render(productionId, clipId) {
    const bundle = await this.requireSource(productionId);
    const clip = await this.requireClip(productionId, clipId);
    if (LOCKED.includes(clip.status)) {
      const error = new Error('This Short is locked after approval');
      error.status = 409;
      throw error;
    }
    const sourceVideo = bundle.assets?.finalVideo?.path;
    await this.requireFile(sourceVideo, 'The approved source MP4 is missing');
    const sourceScenes = (bundle.scenes || []).filter(scene => clip.sourceSceneIds.includes(scene.id));
    if (!sourceScenes.length) throw new Error('The selected source scenes no longer exist');

    const directory = path.join(this.dataRoot, productionId);
    await fs.mkdir(directory, { recursive: true });
    const outputPath = path.join(directory, `${clip.id}.mp4`);
    const captionsPath = path.join(directory, `${clip.id}.srt`);
    await this.db.updateShortClip(clip.id, { status: 'rendering', error: null });

    try {
      const native = clip.layout === 'native' && bundle.assets?.audio?.path && await this.hasIllustrations(sourceScenes, bundle.scenes || []);
      const changes = {};
      if (native) {
        const result = await this.renderMontage(bundle, clip, outputPath, captionsPath);
        await this.verifyRender(outputPath, result);
        changes.duration = round(result.total);
        if (result.credits.length && !clip.description.includes(result.credits[0])) {
          changes.description = limit(`${clip.description}\n\n${FR ? 'Musique' : 'Music'} : ${result.credits.join(' · ')}`, 5000);
        }
      } else {
        // The reframed 16:9 video already shows its own word-timed captions: none are burned on top. The caption
        // track sent to YouTube holds the words spoken inside the window.
        const words = await retimedWords([{ start: clip.startSeconds, end: clip.startSeconds + clip.duration, at: 0 }], bundle.scenes || []);
        await fs.writeFile(captionsPath, cuesToSrt(captionCues('', clip.duration, { words, maxWords: 7, maxChars: 42 })), 'utf8');
        // A centre crop would cut a visual insert card in half: keep the whole frame when the excerpt shows one.
        const cropsInsert = clip.layout === 'crop' && this.showsInsert(bundle, clip);
        const filter = this.videoFilter(clip.layout === 'native' || cropsInsert ? 'blur' : clip.layout);
        await this.runFFmpeg([
          '-y', '-ss', String(clip.startSeconds), '-i', sourceVideo, '-t', String(clip.duration),
          '-filter_complex', filter, '-map', '[shortv]', '-map', '0:a:0?',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
          '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-shortest', outputPath
        ]);
      }
      await this.runFFmpeg(['-v', 'error', '-i', outputPath, '-f', 'null', '-']);
      const stats = await fs.stat(outputPath);
      if (!stats.isFile() || stats.size <= 0) throw new Error('FFmpeg returned an empty Short');
      return this.db.updateShortClip(clip.id, {
        ...changes, status: 'rendered', outputPath, captionsPath, error: null,
        renderedAt: new Date().toISOString()
      });
    } catch (error) {
      await this.db.updateShortClip(clip.id, { status: 'failed', error: error.message });
      throw error;
    }
  }

  // Where each cut lands in the Short: cuts back to back with a breath between them, then the subscribe line.
  montageTimeline(segments, cta) {
    let at = 0;
    const placed = segments.map((segment, index) => {
      if (index) at += CUT_GAP;
      const item = { ...segment, at: round(at) };
      at += segment.end - segment.start;
      return item;
    });
    let ctaAt = null;
    if (cta) {
      at += CTA_GAP;
      ctaAt = round(at);
      at += cta.kind === 'file' ? Number(cta.duration) : cta.end - cta.start;
    }
    return { segments: placed, ctaAt, total: at + TAIL };
  }

  // Vertical montage from the clean illustrations: blurred full-bleed background, the illustration with a camera
  // move that changes at every cut (or the insert card the video showed at that moment) in the middle, the Short's
  // title on top, big word-timed captions below, and the subscribe card over the closing line.
  async renderMontage(bundle, clip, outputPath, captionsPath) {
    const W = this.width;
    const H = this.height;
    const scale = W / 1080;
    const scenes = sceneTimeline(bundle.scenes || []);
    const sourceSegments = clip.segments?.length
      ? clip.segments
      : [{ start: Number(clip.startSeconds), end: Number(clip.startSeconds) + Number(clip.duration) }];
    const cta = clip.cta || null;
    const { segments, ctaAt, total } = this.montageTimeline(sourceSegments, cta);
    const registers = scriptScenes(bundle.script || {}).map(blueprint => blueprint.register);
    const used = scenes.filter(scene => segments.some(segment => scene.startSeconds < segment.end && scene.startSeconds + scene.duration > segment.start));
    const register = !twoPartVideos() || used.some(scene => !isOpening(registers[scene.position])) ? 'main' : 'opening';
    const colors = PALETTES[paletteFor(register, process.env.VISUAL_PALETTE)] || PALETTES.blood;
    const fonts = await ensureFonts();
    const workDir = path.join(path.dirname(outputPath), `.short_${clip.id}`);
    await fs.mkdir(workDir, { recursive: true });

    try {
      // Sound: the cuts from the scene recordings, then a continuous music bed under the whole Short.
      const narrationPath = path.join(workDir, 'narration.wav');
      await this.buildNarration(scenes, segments, cta, ctaAt, total, narrationPath);
      const music = await this.mixMusic(bundle, clip, segments, narrationPath, total, workDir);

      // Captions: the words actually heard, moved onto the montage.
      const words = await this.montageWords(scenes, segments, cta, ctaAt);
      const cues = captionCues('', total, { words, maxWords: 4, maxChars: 18 });
      await fs.writeFile(captionsPath, cuesToSrt(cues), 'utf8');
      const assPath = path.join(workDir, 'captions.ass');
      await fs.writeFile(assPath, assDocument(cues, {
        // Kept clear of the Shorts overlay: the action buttons on the right and the title/channel strip at the bottom.
        fontSize: Math.round(76 * scale), bold: -1, playResX: W, playResY: H,
        marginH: Math.round(120 * scale), marginV: Math.round(580 * scale), outlineWidth: Math.round(14 * scale)
      }));
      const titleFile = path.join(workDir, 'title.txt');
      const titleWords = glueTypography(String(clip.title || '').toUpperCase()).split(' ').filter(Boolean);
      const titleLines = [''];
      for (const word of titleWords) {
        if (titleLines[titleLines.length - 1].length + word.length + 1 > 20 && titleLines[titleLines.length - 1]) titleLines.push(word);
        else titleLines[titleLines.length - 1] = `${titleLines[titleLines.length - 1]} ${word}`.trim();
      }
      await fs.writeFile(titleFile, titleLines.slice(0, 4).join('\n'));
      const subscribeFile = path.join(workDir, 'subscribe.txt');
      await fs.writeFile(subscribeFile, FR ? 'ABONNE-TOI' : 'SUBSCRIBE');
      // Under the subscribe card: where the full video is, or, for a Short that stands alone (clip.endLine), the line
      // it gives (the next part of a series), or nothing.
      const endLine = clip.endLine === undefined ? (FR ? 'VIDÉO COMPLÈTE SUR LA CHAÎNE' : 'FULL VIDEO ON THE CHANNEL') : clip.endLine;
      const fullVideoFile = path.join(workDir, 'full.txt');
      if (endLine) await fs.writeFile(fullVideoFile, endLine);

      // Pictures: one shot per cut and scene, split where the video showed an insert card.
      const shots = await this.montageShots(bundle, scenes, segments, ctaAt, total);
      const inputs = [];
      const chain = [];
      const fgHeight = Math.round(760 * scale / 2) * 2;
      const fgY = Math.round(560 * scale);
      let frameCursor = 0;
      let elapsed = 0;
      for (const [index, shot] of shots.entries()) {
        elapsed += shot.duration;
        const endFrame = Math.round(elapsed * 30);
        const frames = Math.max(1, endFrame - frameCursor);
        frameCursor = endFrame;
        const imageIndex = inputs.filter(item => item === '-i').length;
        inputs.push('-i', shot.image);
        const zoom = (0.12 / frames).toFixed(7);
        // Camera moves in turn: push in, pan right, pull out of the left third, pan left, push in on the right third.
        const move = [
          `z='1.0+on*${zoom}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
          `z='1.12':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,
          `z='1.25-on*${zoom}':x='(iw-iw/zoom)*0.2':y='ih/2-(ih/zoom/2)'`,
          `z='1.12':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`,
          `z='1.13+on*${zoom}':x='(iw-iw/zoom)*0.8':y='(ih-ih/zoom)*0.4'`
        ][shot.motion % 5];
        chain.push(
          `[${imageIndex}:v]split[bgsrc${index}][fgsrc${index}]`,
          `[bgsrc${index}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:3,eq=brightness=-0.22:saturation=0.8,setsar=1,loop=loop=${frames}:size=1:start=0,setpts=N/(30*TB)[bg${index}]`,
          `[fgsrc${index}]scale=-2:${fgHeight},crop=${W}:${fgHeight},zoompan=${move}:d=${frames}:s=${W}x${fgHeight}:fps=30,setsar=1[fg${index}]`,
          `[bg${index}][fg${index}]overlay=0:${fgY}:shortest=1[pic${index}]`
        );
        let picture = `pic${index}`;
        if (shot.card) {
          const cardIndex = imageIndex + 1;
          inputs.push('-i', shot.card);
          chain.push(
            `[${cardIndex}:v]scale=-2:${fgHeight},format=rgba,loop=loop=${frames}:size=1:start=0,setpts=N/(30*TB)[card${index}]`,
            `[pic${index}][card${index}]overlay=(W-w)/2:${fgY}:shortest=1[carded${index}]`
          );
          picture = `carded${index}`;
        }
        chain.push(`[${picture}]trim=end_frame=${frames},setpts=PTS-STARTPTS,fps=30,format=yuv420p[seg${index}]`);
      }
      const audioIndex = inputs.filter(item => item === '-i').length;
      inputs.push('-i', music?.path || narrationPath);
      const titleSize = Math.round(64 * scale);
      const ruleY = Math.round(170 * scale);
      const textY = ruleY + Math.round(36 * scale);
      // The subscribe card comes up over the closing line: the cut CTA, the given moment (a standalone Short's own
      // spoken call to action), or the last seconds.
      const closing = Number.isFinite(clip.closingAt) ? clip.closingAt : ctaAt === null ? Math.max(0, total - 2.5) : ctaAt;
      chain.push(
        `${shots.map((_, index) => `[seg${index}]`).join('')}concat=n=${shots.length}:v=1:a=0[base]`,
        `[base]drawbox=x=${Math.round(80 * scale)}:y=${ruleY}:w=${Math.round(140 * scale)}:h=${Math.max(4, Math.round(8 * scale))}:color=${colors.accent}@1:t=fill[v1]`,
        `[v1]drawtext=fontfile='${filterPath(fonts.bold)}':textfile='${filterPath(titleFile)}':fontcolor=${colors.title}:fontsize=${titleSize}:line_spacing=${Math.round(10 * scale)}:x=${Math.round(80 * scale)}:y=${textY}:shadowcolor=0x000000@0.8:shadowx=3:shadowy=3:enable='lt(t,${closing.toFixed(2)})'[v2]`,
        `[v2]drawtext=fontfile='${filterPath(fonts.bold)}':textfile='${filterPath(subscribeFile)}':fontcolor=${colors.accent}:fontsize=${Math.round(104 * scale)}:x=${Math.round(80 * scale)}:y=${textY}:shadowcolor=0x000000@0.8:shadowx=3:shadowy=3:enable='gte(t,${closing.toFixed(2)})'[v3]`,
        endLine
          ? `[v3]drawtext=fontfile='${filterPath(fonts.bold)}':textfile='${filterPath(fullVideoFile)}':fontcolor=${colors.title}:fontsize=${Math.round(40 * scale)}:x=${Math.round(80 * scale)}:y=${textY + Math.round(130 * scale)}:shadowcolor=0x000000@0.8:shadowx=2:shadowy=2:enable='gte(t,${closing.toFixed(2)})'[v4]`
          : '[v3]null[v4]',
        `[v4]ass='${filterPath(assPath)}'[shortv]`,
        `[${audioIndex}:a]afade=t=in:d=0.04,afade=t=out:st=${Math.max(0, total - 0.35).toFixed(2)}:d=0.35[shorta]`
      );
      await this.runFFmpeg([
        '-y', ...inputs, '-filter_complex', chain.join(';'), '-map', '[shortv]', '-map', '[shorta]',
        '-t', total.toFixed(3), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', '30',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outputPath
      ]);
      const expectedText = sourceSegments.every(segment => segment.text)
        ? [...sourceSegments.map(segment => segment.text), ...(cta ? [cta.text] : [])].join(' ')
        : null;
      return { total, cues, words, expectedText, credits: music?.credits || [] };
    } finally {
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  // The narration of the montage: each cut taken from the scene recordings (a cut that crosses a scene boundary
  // takes both), short fades so no cut clicks, a breath between cuts, then the subscribe line.
  async buildNarration(scenes, segments, cta, ctaAt, total, outputPath) {
    const files = [];
    const inputIndex = file => {
      if (!files.includes(file)) files.push(file);
      return files.indexOf(file);
    };
    const pieces = [];
    const sourcePieces = (start, end) => scenes
      .filter(scene => scene.audioPath && scene.startSeconds < end && scene.startSeconds + scene.duration > start)
      .map(scene => ({
        input: inputIndex(scene.audioPath),
        from: Math.max(start, scene.startSeconds) - scene.startSeconds,
        to: Math.min(end, scene.startSeconds + scene.duration) - scene.startSeconds
      }))
      .filter(piece => piece.to - piece.from > 0.04);
    segments.forEach((segment, index) => {
      if (index) pieces.push({ silence: CUT_GAP });
      pieces.push(...sourcePieces(segment.start, segment.end));
    });
    if (cta) {
      pieces.push({ silence: CTA_GAP });
      if (cta.kind === 'file') pieces.push({ input: inputIndex(cta.path), from: 0, to: Number(cta.duration) });
      else pieces.push(...sourcePieces(cta.start, cta.end));
    }
    const format = 'aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo';
    const chain = pieces.map((piece, index) => {
      if (piece.silence) return `anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${piece.silence.toFixed(3)},${format}[p${index}]`;
      const length = piece.to - piece.from;
      return `[${piece.input}:a]atrim=start=${piece.from.toFixed(3)}:end=${piece.to.toFixed(3)},asetpts=PTS-STARTPTS,${format},` +
        `afade=t=in:d=0.02,afade=t=out:st=${Math.max(0, length - 0.03).toFixed(3)}:d=0.03[p${index}]`;
    });
    chain.push(`${pieces.map((_, index) => `[p${index}]`).join('')}concat=n=${pieces.length}:v=0:a=1,apad=whole_dur=${total.toFixed(3)}[out]`);
    await this.runFFmpeg([
      '-y', ...files.flatMap(file => ['-i', file]), '-filter_complex', chain.join(';'),
      '-map', '[out]', '-c:a', 'pcm_s16le', outputPath
    ]);
  }

  // A continuous bed in the ambiance the video had at the first cut, ducked under the voice like the video's own.
  // Returns { path, credits }, or null without music.
  async mixMusic(bundle, clip, segments, narrationPath, total, workDir) {
    if (!backgroundMusic.enabled()) return null;
    const tracks = bundle.assets?.music?.tracks || [];
    const first = segments[0]?.start || 0;
    const track = tracks.find(item => first >= item.start && first < item.end) || tracks[tracks.length - 1] || null;
    try {
      const result = await backgroundMusic.mixSoundtrack({
        narrationPath,
        segments: [{ register: registerOf(track?.phase), duration: total, position: 0, ambiance: track?.ambiance || null }],
        outputPath: path.join(workDir, 'soundtrack.flac'),
        key: clip.id,
        minSeconds: 0
      });
      return result?.path ? { path: result.path, credits: result.credits || [] } : null;
    } catch (error) {
      this.logger.warn(`Short without music: ${error.message}`);
      return null;
    }
  }

  async montageWords(scenes, segments, cta, ctaAt) {
    const ranges = segments.map(segment => ({ start: segment.start, end: segment.end, at: segment.at }));
    if (cta && cta.kind !== 'file') ranges.push({ start: cta.start, end: cta.end, at: ctaAt });
    const words = await retimedWords(ranges, scenes);
    if (cta?.kind === 'file') {
      const spoken = await readWordTimings(cta.path) || estimatedWords(cta.text, cta.duration);
      words.push(...spoken.map(word => ({ text: word.text, start: word.start + ctaAt, end: word.end + ctaAt })));
    }
    return words;
  }

  // Shots covering the whole Short: one per cut and scene, split where an insert card was on screen in the video;
  // a shot holds through the breath that follows it, and the last picture stays under the subscribe line.
  async montageShots(bundle, scenes, segments, ctaAt, total) {
    const inserts = bundle.assets?.inserts?.items || [];
    const insertDir = scenes.find(scene => scene.assetPath)?.assetPath
      ? path.join(path.dirname(scenes.find(scene => scene.assetPath).assetPath), 'inserts')
      : null;
    const shots = [];
    for (const [index, segment] of segments.entries()) {
      const until = index + 1 < segments.length ? segments[index + 1].at : (ctaAt ?? total);
      const cuts = new Set([segment.start, segment.end]);
      for (const scene of scenes) {
        if (scene.startSeconds > segment.start && scene.startSeconds < segment.end) cuts.add(scene.startSeconds);
      }
      for (const item of inserts) {
        for (const time of [item.at, item.until]) if (time > segment.start && time < segment.end) cuts.add(time);
      }
      const bounds = [...cuts].sort((a, b) => a - b);
      const pieces = [];
      for (let piece = 0; piece + 1 < bounds.length; piece++) {
        const from = bounds[piece];
        const to = bounds[piece + 1];
        const middle = (from + to) / 2;
        const scene = scenes.find(item => middle >= item.startSeconds && middle < item.startSeconds + item.duration) || scenes[scenes.length - 1];
        const insert = inserts.find(item => middle >= item.at && middle < item.until);
        const card = insert && insertDir && await this.isFile(path.join(insertDir, insert.path)) ? path.join(insertDir, insert.path) : null;
        const image = await this.illustrationFor(scene, scenes);
        const previous = pieces[pieces.length - 1];
        // A flash shorter than half a second reads as a glitch: it stays on the previous picture.
        if (previous && (to - from < 0.5 || (previous.image === image && previous.card === card))) previous.duration += to - from;
        else pieces.push({ image, card, duration: to - from });
      }
      pieces[pieces.length - 1].duration += until - (segment.at + segment.end - segment.start);
      shots.push(...pieces);
    }
    if (ctaAt !== null) {
      shots.push({ image: shots[shots.length - 1].image, card: null, duration: total - ctaAt });
    } else {
      shots[shots.length - 1].duration += total - shots.reduce((sum, shot) => sum + shot.duration, 0);
    }
    // One picture held for long reads as a slideshow: a long illustration shot is re-framed every few seconds.
    const paced = shots.flatMap(shot => {
      if (shot.card || shot.duration < SHOT_SECONDS * 1.5) return [shot];
      const parts = Math.round(shot.duration / SHOT_SECONDS);
      return Array.from({ length: parts }, () => ({ ...shot, duration: shot.duration / parts }));
    });
    return paced.map((shot, index) => ({ ...shot, motion: index }));
  }

  // The rendered Short must be what was edited: a vertical frame of the planned length, an audible soundtrack, and
  // captions that are exactly the words heard.
  async verifyRender(outputPath, { total, cues, words, expectedText }) {
    let log = '';
    try {
      const result = await this.runFFmpeg(['-hide_banner', '-i', outputPath, '-af', 'volumedetect', '-f', 'null', '-']);
      log = String(result?.stderr || '');
    } catch (error) {
      throw new Error(`The rendered Short cannot be decoded: ${String(error.stderr || error.message).slice(0, 300)}`);
    }
    const problems = [];
    const size = log.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
    if (!size || Number(size[1]) !== this.width || Number(size[2]) !== this.height) problems.push(`frame is ${size ? `${size[1]}x${size[2]}` : 'unknown'}, not ${this.width}x${this.height}`);
    const duration = log.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    const seconds = duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : NaN;
    if (!(Math.abs(seconds - total) <= 0.25)) problems.push(`lasts ${Number.isFinite(seconds) ? seconds.toFixed(2) : '?'}s instead of ${total.toFixed(2)}s`);
    const volume = log.match(/mean_volume:\s*(-?[\d.]+) dB/);
    if (!/Audio:/.test(log) || !volume || Number(volume[1]) < -45) problems.push('the soundtrack is missing or silent');
    if (cues.some(cue => cue.start < 0 || cue.end > total + 0.01)) problems.push('a caption falls outside the Short');
    if (expectedText !== null && spokenKey(words.map(word => word.text).join(' ')) !== spokenKey(expectedText)) {
      problems.push('the captions are not exactly the words heard');
    }
    if (problems.length) throw new Error(`The rendered Short failed its checks: ${problems.join('; ')}`);
  }

  // Whether a visual insert (agents/visual-insert-agent.js) is on screen during the clip.
  showsInsert(bundle, clip) {
    const start = Number(clip.startSeconds) || 0;
    const end = start + (Number(clip.duration) || 0);
    return (bundle.assets?.inserts?.items || []).some(item => item.at < end && item.until > start);
  }

  videoFilter(layout) {
    if (layout === 'crop') {
      return `[0:v]scale=${this.width}:${this.height}:force_original_aspect_ratio=increase,crop=${this.width}:${this.height},fps=30,format=yuv420p[shortv]`;
    }
    if (layout === 'stacked') {
      const foregroundHeight = Math.round(this.height * 0.56);
      const y = Math.round(this.height * 0.13);
      return `[0:v]split=2[bg][fg];` +
        `[bg]scale=${this.width}:${this.height}:force_original_aspect_ratio=increase,crop=${this.width}:${this.height},boxblur=28:3[soft];` +
        `[fg]scale=${this.width}:${foregroundHeight}:force_original_aspect_ratio=decrease[front];` +
        `[soft][front]overlay=(W-w)/2:${y},fps=30,format=yuv420p[shortv]`;
    }
    return `[0:v]split=2[bg][fg];` +
      `[bg]scale=${this.width}:${this.height}:force_original_aspect_ratio=increase,crop=${this.width}:${this.height},boxblur=28:3[soft];` +
      `[fg]scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease[front];` +
      `[soft][front]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p[shortv]`;
  }

  async approve(productionId, clipId, input = {}) {
    if (input.confirmed !== true) {
      const error = new Error('Confirm the inherited evidence and Short schedule before approval');
      error.status = 409;
      error.code = 'SHORT_APPROVAL_REQUIRED';
      throw error;
    }
    const bundle = await this.requireSource(productionId);
    const clip = await this.requireClip(productionId, clipId);
    if (bundle.review_status !== 'approved') {
      const error = new Error('Approve the source production before scheduling its Shorts');
      error.status = 409;
      throw error;
    }
    const evidence = this.inheritedEvidence(bundle);
    if (!evidence.ready) {
      const error = new Error(`Source evidence is incomplete: ${evidence.blockingReasons.join(', ')}`);
      error.status = 409;
      throw error;
    }
    if (clip.status !== 'rendered') {
      const error = new Error('Render the current Short draft before approval');
      error.status = 409;
      throw error;
    }
    await this.requireFile(clip.outputPath, 'The rendered Short MP4 is missing');
    const publishTime = new Date(input.publishTime || clip.publishTime);
    if (Number.isNaN(publishTime.getTime())) throw new Error('Choose a valid Short publish time');
    const privacyStatus = input.privacyStatus || clip.privacyStatus || 'private';
    if (!['private', 'unlisted', 'public'].includes(privacyStatus)) throw new Error('Short privacy is invalid');
    const profile = await this.db.getChannelProfile?.().catch(() => null) || null;
    let description = clip.description;
    if (!hasSubscribeCall(description)) {
      const channelId = await this.db.getSetting?.('youtube_channel_id').catch(() => null) || null;
      description = `${description}\n\n${subscribeLine(profile?.call_to_action, channelId)}`;
    }
    const parentUrl = bundle.schedule?.youtube_url || bundle.schedule?.youtubeUrl;
    if (parentUrl && !description.includes(parentUrl)) {
      description = `${description}\n\n${FR ? 'Vidéo complète' : 'Watch the full video'} : ${parentUrl}`;
    }
    const site = siteLink(bundle);
    if (site && !description.includes(site.url)) description = `${description}\n${site.line}`;
    description = description.slice(0, 5000);
    const audio = bundle.assets?.audio || {};
    const schedule = await this.publishing.scheduleContent({
      id: clip.id,
      script: { title: clip.title },
      seo: {
        title: clip.title,
        description,
        tags: [...new Set([...(clip.tags || []), 'Shorts'])]
      },
      assets: {
        finalVideo: { path: clip.outputPath, simulated: false, aspectRatio: '9:16', duration: clip.duration },
        audio,
        captions: clip.captionsPath ? { path: clip.captionsPath } : null,
        thumbnail: null
      },
      scheduledPublishTime: publishTime.toISOString(),
      priority: 60,
      privacyStatus,
      containsSyntheticMedia: evidence.containsSyntheticMedia,
      contentType: 'short',
      sourceProductionId: productionId,
      shortClipId: clip.id
    });
    if (!schedule) {
      const error = new Error('The Short could not be scheduled because its rendered media or narration evidence is incomplete');
      error.status = 409;
      throw error;
    }
    const approved = await this.db.updateShortClip(clip.id, {
      status: 'scheduled', publishTime: publishTime.toISOString(), privacyStatus, description,
      inheritedEvidence: evidence, approvedAt: new Date().toISOString(), scheduleId: schedule.id,
      error: null
    });
    // The same Short goes to TikTok and Instagram Reels at the same time, when those platforms are configured.
    await this.social?.enqueueShort({
      clip: approved, publishTime: publishTime.toISOString(),
      containsSyntheticMedia: evidence.containsSyntheticMedia, profile
    });
    return approved;
  }

  inheritedEvidence(bundle) {
    const blockingReasons = [];
    if (bundle.review_status !== 'approved') blockingReasons.push('source approval');
    if (!['verified', 'not_required'].includes(bundle.provenance?.status || 'not_required')) blockingReasons.push('provenance review');
    const unlicensed = (bundle.scenes || []).filter(scene => scene.assetOrigin === 'uploaded' && !scene.rightsConfirmed);
    if (unlicensed.length) blockingReasons.push('media rights');
    const stale = (bundle.scenes || []).filter(scene =>
      !['ready'].includes(scene.status) || !['current', 'intentional_silence'].includes(scene.narrationStatus)
    );
    if (stale.length) blockingReasons.push('current scene evidence');
    return {
      ready: blockingReasons.length === 0,
      blockingReasons,
      sourceReviewStatus: bundle.review_status || 'needs_review',
      provenanceStatus: bundle.provenance?.status || 'not_required',
      rightsConfirmed: unlicensed.length === 0,
      containsSyntheticMedia: bundle.provenance?.containsSyntheticMedia === true,
      capturedAt: new Date().toISOString()
    };
  }

  nextPublishBase(bundle) {
    const sourceTime = new Date(bundle.schedule?.publish_time || bundle.schedule?.published_at || bundle.scheduled_publish_time || Date.now());
    const minimum = new Date(Date.now() + 3600000);
    const candidate = Number.isNaN(sourceTime.getTime()) ? minimum : new Date(sourceTime.getTime() + 86400000);
    return candidate > minimum ? candidate : minimum;
  }

  async requireSource(productionId) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) {
      const error = new Error('Source production not found');
      error.status = 404;
      throw error;
    }
    if (!bundle.assets?.finalVideo?.path || bundle.assets.finalVideo.simulated) {
      const error = new Error('A real source MP4 is required before creating Shorts');
      error.status = 409;
      throw error;
    }
    return bundle;
  }

  async requireClip(productionId, clipId) {
    const clip = await this.db.getShortClip(clipId);
    if (!clip || clip.productionId !== productionId) {
      const error = new Error('Short draft not found');
      error.status = 404;
      throw error;
    }
    return clip;
  }

  async requireFile(filePath, message) {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile() || stats.size <= 0) throw new Error(message);
    } catch (_error) {
      const error = new Error(message);
      error.status = 409;
      throw error;
    }
  }
}

module.exports = { ShortsRepurposingService, LAYOUTS, DEFAULT_SHORTS_MODEL, SPEECH };
