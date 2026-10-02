// Expert review of scripts on highly specialised subjects (quantum physics, relativity, clinical medicine...).
// The web-searched fact-check catches a wrong date, name or figure; it does not catch an explanation of entanglement
// that sounds right and is subtly wrong. Right after the script is written, a model decides whether the subject needs a
// specialist. If it does, the job stops before narration and images, EXPERT_REVIEW_WEBHOOK_URL is told what to have
// checked, and nothing goes further until someone approves the script, asks for corrections (the script is rewritten
// with them, then reviewed again) or drops the video. The model scores its confidence in every specialised passage
// from 1 to 10: a passage above EXPERT_REVIEW_CONFIDENCE (6.6) is validated without an expert, and only the others are
// sent to one. An imprecise figure with no health stakes that the argument does not rest on (an energy, a distance, a
// count) never holds a video: it is annotated as an assumed approximation. With TYPESAFE_API_KEY, Jev sorts the scripts
// first: one it finds clearly outside the specialised fields skips the Claude assessment.
const { Blob } = require('buffer');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { Logger } = require('./logger');
const { extractJson } = require('./ai-json');
const jev = require('./jev');
const { mention, allowedMentions, discordWebhook, alertWebhookUrl, md } = require('./discord-alert');
const { isOpening } = require('./content-mode');

// Fields where a well-read generalist with web search can still get the explanation wrong. EXPERT_REVIEW_DOMAINS
// (separated by ";") replaces the list.
const DEFAULT_DOMAINS = [
  'quantum physics (quantum mechanics, entanglement, measurement, decoherence, quantum field theory)',
  'relativity, cosmology and astrophysics',
  'particle and nuclear physics',
  'thermodynamics and statistical physics',
  'neuroscience and consciousness research',
  'molecular biology, genetics and epigenetics',
  'pharmacology, toxicology and clinical medicine (mechanisms, treatments, trial results)',
  'epidemiology and biostatistics',
  'climate science',
  'advanced mathematics'
];
const DECISIONS = { approve: 'approved', revise: 'revision_requested', reject: 'rejected' };
// The reviewer name of decisions taken without a human (confidence threshold, Jev): the public site must not present
// them as a human review.
const AUTOMATIC_REVIEWER = 'validation automatique';
const isAutomaticDecision = reviewer => String(reviewer || '').startsWith(AUTOMATIC_REVIEWER);
// Discord rejects a message over 2,000 characters, and 6,000 across its embeds (10 at most); Slack cuts a text at 40,000.
const MESSAGE_LIMIT = 1900;
const EMBEDS_LIMIT = 5900;
const TEXT_LIMIT = 39000;

// auto: a model decides per script; always: every script waits for an expert; off: no expert review.
function mode() {
  const value = String(process.env.EXPERT_REVIEW || 'auto').trim().toLowerCase();
  return ['off', 'always'].includes(value) ? value : 'auto';
}

function domains() {
  const configured = String(process.env.EXPERT_REVIEW_DOMAINS || '').split(';').map(item => item.trim()).filter(Boolean);
  return configured.length ? configured : DEFAULT_DOMAINS;
}

// A passage the model scores above this (out of 10) is validated without an expert.
function confidenceThreshold() {
  const value = parseFloat(process.env.EXPERT_REVIEW_CONFIDENCE);
  // Low enough that only real doubts wait for a specialist, who is hard to reach; viewers who are experts can still
  // report an error once the video is out (npm run errata).
  return Number.isFinite(value) && value >= 1 && value <= 10 ? value : 6.6;
}

// Below this probability that the narration is specialised, Jev's first sort spares the Claude assessment. On the
// channel's scripts, specialised subjects scored 0.37 to 0.96 and the others 0.16 at most.
function triageThreshold() {
  const value = parseFloat(process.env.EXPERT_TRIAGE_THRESHOLD);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.25;
}

function confidenceOf(value) {
  const number = Number(value);
  return value !== null && value !== '' && Number.isFinite(number) ? Math.min(10, Math.max(1, number)) : null;
}

// 6.6 → 6,6 for a French reader.
const score = value => (value === null || value === undefined ? '?' : String(value).replace('.', ','));

const webhookUrl = alertWebhookUrl;


const text = (value, limit) => String(value ?? '').trim().slice(0, limit);
// What a reader sees: cut after a whole word and marked, never in the middle of one.
function clip(value, limit) {
  const whole = String(value ?? '').trim();
  if (whole.length <= limit) return whole;
  if (limit <= 1) return '';
  const cut = whole.slice(0, limit - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`;
}

// Every passage in full, one embed each, as many as Discord takes; the attached brief holds them all anyway.
function passageEmbeds(passages) {
  const embeds = [];
  let length = 0;
  for (const [index, passage] of passages.entries()) {
    const embed = {
      title: `Passage ${index + 1}/${passages.length}${passage.confidence != null ? ` · confiance ${score(passage.confidence)}/10` : ''}`,
      description: `> « ${md(passage.excerpt)} »${passage.concern ? `\n\n${md(passage.concern)}` : ''}`
    };
    const size = embed.title.length + embed.description.length;
    if (embeds.length === 10 || length + size > EMBEDS_LIMIT) break;
    embeds.push(embed);
    length += size;
  }
  return embeds;
}

// Named after the title's first clause: relecture-comment-fonctionne-une-eclipse.md
function briefName(review) {
  const slug = String(review.title || '').split(/[?:!.]/)[0].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  return `relecture-${slug || review.id}${review.revision > 1 ? `-v${review.revision}` : ''}.md`;
}


// Discord takes the brief as an attached file, which a forwarded message keeps: multipart, the message in payload_json.
function discordForm(payload) {
  const form = new FormData();
  form.append('payload_json', JSON.stringify({
    content: payload.content,
    embeds: payload.embeds,
    allowed_mentions: payload.allowed_mentions,
    attachments: [{ id: 0, filename: payload.script.filename, description: 'Script complet et passages à vérifier' }]
  }));
  form.append('files[0]', new Blob([payload.script.markdown], { type: 'text/markdown' }), payload.script.filename);
  return form;
}

// What the voice will say, in the JSON shape the script writer returns, so a revision can be asked on this exact draft.
function draftOf(script = {}) {
  const sections = (script.mainContent?.sections || []).map(section => ({
    title: text(section.title, 200),
    register: section.register || undefined,
    content: (Array.isArray(section.content) ? section.content : [section.content])
      .filter(line => typeof line === 'string' && line.trim()).map(line => line.trim()),
    duration: section.duration,
    imagePrompt: section.imagePrompt || undefined
  })).filter(section => section.content.length);
  return {
    title: text(script.title, 100),
    hook: text(script.hook?.text, 2000),
    sections: sections.length ? sections : [{ title: '', content: [text(script.fullScript, 40000)].filter(Boolean) }],
    hookImagePrompt: script.hookImagePrompt || '',
    thumbnailText: script.thumbnailText || '',
    thumbnailImagePrompt: script.thumbnailImagePrompt || '',
    cta: text(script.callToAction?.subscribe, 2000),
    claims: (script.claims || []).map(claim => ({
      text: claim.text, riskLevel: claim.riskLevel || 'standard', sourceUrls: claim.sourceUrls || []
    })),
    // Kept so a rewrite after corrections returns it too (not part of the approved words: scriptHash ignores it).
    examinedClaim: script.examinedClaim || null
  };
}

function narrationOf(draft) {
  return [draft.hook, ...draft.sections.flatMap(section => section.content), draft.cta].filter(Boolean).join('\n\n');
}

// An approval holds for these exact words: any change to the title or the narration needs a new review.
function scriptHash(draft) {
  const spoken = [draft.title, draft.hook, draft.sections.map(section => [section.title, section.content]), draft.cta];
  return crypto.createHash('sha256').update(JSON.stringify(spoken)).digest('hex');
}

class ExpertReviewService {
  constructor(db, options = {}) {
    this.db = db;
    this.ai = options.aiTextService || null;
    this.jev = options.jev || jev;
    this.resumeJob = options.resumeJob || null;
    this.logger = options.logger || new Logger('ExpertReview');
    this.http = options.http || axios;
    this.directory = options.directory || process.env.EXPERT_REVIEW_DIR || path.join(__dirname, '..', 'data', 'expert-reviews');
    this.retryDelayMs = options.retryDelayMs ?? 2000;
    this.ticking = null;
  }

  enabled() {
    const current = mode();
    if (current === 'off') return false;
    return current === 'always' || Boolean(this.ai?.isAvailable?.());
  }

  // Generation stage between the script and everything that costs time (voice, images, montage). Returns the script
  // with its expertReview verdict, or throws EXPERT_REVIEW_PENDING after sending the alert so the job waits.
  async gate({ jobId = null, strategy = {}, script }) {
    const draft = draftOf(script);
    const hash = scriptHash(draft);
    const previous = jobId ? (await this.db.listExpertReviews({ jobId, limit: 1 }))[0] || null : null;
    if (previous?.status === 'rejected') {
      const error = new Error(`The expert review rejected this video: ${previous.decisionNotes || 'no reason given'}`);
      error.status = 409;
      throw error;
    }
    if (previous?.scriptHash === hash) {
      if (previous.status === 'approved') return this.annotate(script, previous);
      if (previous.status === 'pending') throw this.held(previous);
    }

    // A rewrite after corrections goes back to the expert anyway: no first sort for it.
    const assessment = await this.assess(strategy, draft, { triage: !previous });
    // Once a subject has needed an expert, every rewrite of its script goes back to the expert.
    const required = mode() === 'always' || assessment.required || Boolean(previous);
    if (!required) {
      return {
        ...script,
        expertReview: {
          required: false,
          // auto_validated: a specialised script whose every passage scored above the confidence threshold.
          status: assessment.specialised ? 'auto_validated' : 'not_required',
          domain: assessment.domain || null,
          reason: assessment.reason || null,
          confidenceThreshold: assessment.confidenceThreshold ?? null,
          autoValidated: assessment.validated || [],
          approximations: assessment.approximations || [],
          triage: assessment.triage || null,
          jevProbability: assessment.jevProbability ?? null
        }
      };
    }
    if (!jobId) {
      const error = new Error(`This script needs an expert review (${assessment.domain || 'specialised subject'}); generate it as a job so it can wait for the decision`);
      error.status = 409;
      throw error;
    }

    const review = await this.db.createExpertReview({
      jobId,
      revision: (previous?.revision || 0) + 1,
      topic: strategy.topic || null,
      title: draft.title,
      domain: assessment.domain || previous?.domain || null,
      assessment: {
        ...assessment,
        required: true,
        expertProfile: assessment.expertProfile || previous?.assessment?.expertProfile || '',
        previousCorrections: previous?.status === 'revision_requested' ? previous.decisionNotes : null,
        // The rewrite came back word for word: say so rather than present it as corrected.
        unchanged: previous?.status === 'revision_requested' && previous.scriptHash === hash
      },
      script: draft,
      scriptHash: hash
    });
    const scriptPath = await this.writeScriptFile(review).catch(error => {
      this.logger.warn(`Could not write the script file for expert review ${review.id}: ${error.message}`);
      return null;
    });
    const stored = scriptPath ? await this.db.updateExpertReview(review.id, { scriptPath }) : review;
    await this.alert(stored);
    throw this.held(stored);
  }

  async assess(strategy, draft, { triage = true } = {}) {
    if (!this.ai?.isAvailable?.()) {
      return { required: false, domain: '', expertProfile: '', reason: '', passages: [], unavailable: true };
    }
    const sorted = triage && mode() !== 'always' ? await this.triage(strategy, draft) : null;
    if (sorted && sorted.probability < triageThreshold()) {
      return {
        required: false,
        specialised: false,
        domain: '',
        expertProfile: '',
        reason: `Tri par Jev : sujet hors des domaines spécialisés (probabilité ${score(sorted.probability)}, seuil ${score(triageThreshold())}).`,
        passages: [],
        validated: [],
        approximations: [],
        triage: sorted,
        jevProbability: sorted.probability
      };
    }
    // Recorded either way, so the review says what Jev made of the subject.
    const jevProbability = sorted ? sorted.probability : null;
    const threshold = confidenceThreshold();
    const prompt = `You decide whether a YouTube script must be checked by a human subject-matter expert before it is narrated and published. A web-searched fact-check verifies names, dates, quotations and figures afterwards; what it cannot catch is an explanation that sounds right but is subtly wrong in a highly specialised field. Only that can call for an expert.

Only these fields count as highly specialised:
${domains().map(domain => `- ${domain}`).join('\n')}

The script is specialised when the narration explains, simplifies or argues from the mechanisms, results or mathematics of one of these fields (what entanglement or the observer effect really means, why a molecule acts on the body, what a study design or a p-value shows), including when it uses that science to answer a claim.
It is not when such a field is only mentioned in passing or limited to well-known, uncontroversial facts that a generalist can verify (the age of the universe, that a trial found no effect), or when the subject belongs to another field.

When it is specialised, list every passage that explains, simplifies or argues from such a field, and score from 1 to 10 your confidence that a specialist would accept it as written: accurate, and not misleading in what it simplifies. Score what you actually know, not the prestige of the field: textbook knowledge worded accurately deserves 9 or 10, even in a specialised field. Keep 8 or less for a real doubt: a mechanism you are unsure of, a nuance specialists dispute, a simplification that could mislead, an interpretation of a study that may overreach. Names, dates, quotations and what a study reported are verified by the fact-check afterwards: score the explanation and the interpretation, not those facts. Passages scored above ${threshold} are validated without an expert; only the others are sent to one.

An imprecise figure is never a reason to require an expert. An order of magnitude, an estimate or a rounded figure (an energy, a distance, a size, an age, a count) is an assumed approximation when it says nothing about health (no dose, risk, treatment, diagnosis or effect on the body) and the argument does not depend on its exact value: list it under approximations, not passages.

Topic: ${strategy.topic || draft.title}
Title: ${draft.title}
Narration:
${narrationOf(draft)}

Return only JSON in this exact shape:
{"specialised": true, "domain": "the specialised field", "expertProfile": "who should review it (discipline and level, e.g. a physicist specialised in quantum mechanics)", "reason": "one or two sentences", "passages": [{"excerpt": "a sentence copied exactly from the narration", "confidence": 7, "concern": "what a specialist would check in it and why your confidence is not higher, or why it holds when you score it above the threshold"}], "approximations": [{"excerpt": "a sentence copied exactly from the narration", "note": "what is approximate and why its precision does not matter"}]}
List up to 12 passages and up to 8 approximations. When the script is not specialised, use false, empty strings and an empty passages array, and still list the approximations.`;
    try {
      const response = await this.ai.generateText(prompt, {
        maxTokens: 3000, temperature: 0, model: process.env.EXPERT_REVIEW_MODEL || undefined, purpose: 'expert_review'
      });
      const parsed = extractJson(response);
      const specialised = parsed.specialised === true;
      const scored = (Array.isArray(parsed.passages) ? parsed.passages : []).slice(0, 12)
        .map(item => ({ excerpt: clip(item?.excerpt, 600), confidence: confidenceOf(item?.confidence), concern: clip(item?.concern, 600) }))
        .filter(item => item.excerpt);
      // The least sure first; a passage without a usable score goes to the expert.
      const passages = scored.filter(item => !(item.confidence > threshold))
        .sort((a, b) => (a.confidence ?? 0) - (b.confidence ?? 0));
      return {
        jevProbability,
        // An expert reads only the passages at or below the threshold; a specialised script with none listed goes whole.
        required: specialised && (passages.length > 0 || scored.length === 0),
        specialised,
        domain: text(parsed.domain, 200),
        expertProfile: text(parsed.expertProfile, 300),
        reason: text(parsed.reason, 800),
        confidenceThreshold: threshold,
        passages,
        validated: scored.filter(item => item.confidence > threshold),
        // Imprecise figures the video assumes (no health stakes, not load-bearing): annotated, never held for.
        approximations: (Array.isArray(parsed.approximations) ? parsed.approximations : []).slice(0, 8)
          .map(item => ({ excerpt: clip(item?.excerpt, 600), note: clip(item?.note, 400) }))
          .filter(item => item.excerpt)
      };
    } catch (error) {
      // Not knowing is not a pass: the script waits for a human rather than going out unchecked.
      this.logger.warn(`Expert review assessment failed; holding the script for an expert as a precaution: ${error.message.slice(0, 200)}`);
      return {
        jevProbability,
        required: true, domain: '', expertProfile: '', passages: [], failed: true,
        reason: `L'évaluation automatique du sujet a échoué (${error.message.slice(0, 120)}) : relecture demandée par précaution.`
      };
    }
  }

  // Jev's probability that the narration explains a specialised field; null without Jev or when it fails, and the
  // Claude assessment runs as before.
  async triage(strategy, draft) {
    if (!this.jev?.enabled?.()) return null;
    try {
      const answers = await this.jev.ask({
        purpose: 'expert_triage',
        state: { topic: strategy.topic || draft.title, title: draft.title, narration: narrationOf(draft) },
        questions: {
          specialised: {
            type: 'noul',
            instructions: 'Does this YouTube narration explain, simplify or argue from the mechanisms, results or mathematics of a highly specialised scientific field, beyond facts a generalist can verify?',
            criteria: {
              true: `Yes: it explains how something works in one of these fields (${domains().join('; ')}), e.g. a physical, biological or medical mechanism, or what a study design or a statistic shows, even to answer a claim`,
              false: 'No: it deals with history, philosophy, logic or argumentation, or only mentions science in passing or through well-known facts'
            }
          }
        }
      });
      const probability = Number(answers.specialised?.noul);
      return Number.isFinite(probability) ? { provider: 'jev', probability } : null;
    } catch (error) {
      this.logger.warn(`Jev's first sort failed; the full assessment runs instead: ${error.message.slice(0, 200)}`);
      return null;
    }
  }

  annotate(script, review) {
    return {
      ...script,
      expertReview: {
        required: true,
        status: 'approved',
        reviewId: review.id,
        revision: review.revision,
        domain: review.domain,
        expertProfile: review.assessment?.expertProfile || null,
        reviewer: review.decidedBy || null,
        humanReviewed: !isAutomaticDecision(review.decidedBy),
        notes: review.decisionNotes || null,
        confidenceThreshold: review.assessment?.confidenceThreshold ?? null,
        autoValidated: review.assessment?.validated || [],
        approximations: review.assessment?.approximations || [],
        approvedAt: review.decidedAt
      }
    };
  }

  held(review) {
    const error = new Error(`Waiting for an expert review of the script (${review.domain || 'specialised subject'}), review ${review.id}`);
    error.code = 'EXPERT_REVIEW_PENDING';
    error.checkpointStatus = 'waiting';
    error.reviewId = review.id;
    return error;
  }

  // The script laid out for a reader: what to check first, then every spoken word, then the declared claims. forExpert
  // is the brief sent to someone outside the channel: what is asked of them instead of the commands and the local path.
  renderScript(review, { forExpert = false } = {}) {
    const draft = review.script || {};
    const assessment = review.assessment || {};
    const lines = [
      `# ${draft.title || review.title || 'Script'}`,
      '',
      ...(forExpert ? [
        'Script d\'une vidéo YouTube de vulgarisation, à relire avant l\'enregistrement de la voix. Merci de vérifier en priorité les passages listés ci-dessous, puis le reste du texte si vous le pouvez.',
        ''
      ] : []),
      `- Sujet : ${review.topic || draft.title || ''}`,
      `- Domaine : ${review.domain || 'non déterminé'}`,
      assessment.expertProfile ? `- Relecteur attendu : ${assessment.expertProfile}` : null,
      `- Pourquoi : ${assessment.reason || ''}`,
      `- Révision : ${review.revision}`,
      !forExpert && assessment.jevProbability != null
        ? `- Tri par Jev : probabilité d'un sujet spécialisé ${score(assessment.jevProbability)} (seuil ${score(triageThreshold())})`
        : null,
      assessment.previousCorrections ? `- Corrections demandées sur la version précédente : ${assessment.previousCorrections}` : null,
      assessment.unchanged ? '- ⚠️ Ce texte est identique à la version précédente : les corrections n\'ont pas été appliquées.' : null,
      `- ${forExpert ? 'Référence' : 'Revue'} : ${review.id}`,
      ''
    ].filter(line => line !== null);
    if ((assessment.passages || []).length) {
      lines.push('## Passages à vérifier en priorité', '');
      assessment.passages.forEach((passage, index) => lines.push(
        `${index + 1}. « ${passage.excerpt} »${passage.confidence != null ? ` (confiance ${score(passage.confidence)}/10)` : ''}`,
        `   → ${passage.concern}`
      ));
      lines.push('');
    }
    // For the operator only: the expert is not asked about what needs no expert.
    if (!forExpert && (assessment.validated || []).length) {
      lines.push(`## Validés automatiquement (confiance au-dessus de ${score(assessment.confidenceThreshold)}/10)`, '');
      assessment.validated.forEach(item => lines.push(`- « ${item.excerpt} » (${score(item.confidence)}/10)${item.concern ? ` → ${item.concern}` : ''}`));
      lines.push('');
    }
    if ((assessment.approximations || []).length) {
      lines.push('## Approximations assumées (sans enjeu de santé, inutile de les vérifier)', '');
      assessment.approximations.forEach(item => lines.push(`- « ${item.excerpt} »${item.note ? ` → ${item.note}` : ''}`));
      lines.push('');
    }
    lines.push('## Texte lu par la voix', '');
    if (draft.hook) lines.push('### Accroche', '', draft.hook, '');
    for (const section of draft.sections || []) {
      lines.push(`### ${section.title || 'Suite'}${isOpening(section.register) ? ' (ouverture)' : ''}`, '', ...section.content.flatMap(paragraph => [paragraph, '']));
    }
    if (draft.cta) lines.push('### Conclusion', '', draft.cta, '');
    if ((draft.claims || []).length) {
      lines.push('## Affirmations déclarées (vérifiées ensuite par recherche web)', '');
      draft.claims.forEach(claim => lines.push(`- [${claim.riskLevel === 'high' ? 'risque élevé' : 'standard'}] ${claim.text}`));
      lines.push('');
    }
    if (forExpert) {
      lines.push('## Votre retour', '',
        '- Pour chaque passage : exact, ou à corriger, avec la formulation juste et si possible une source.',
        '- Puis un avis d\'ensemble : valider le script tel quel, le faire corriger, ou renoncer à la vidéo.', '');
    } else {
      lines.push('## Décision', '', ...this.commands(review.id).map(command => `- ${command}`), '');
    }
    return lines.join('\n');
  }

  async writeScriptFile(review) {
    await fs.mkdir(this.directory, { recursive: true });
    const filePath = path.join(this.directory, `${review.id}.md`);
    await fs.writeFile(filePath, this.renderScript(review));
    return filePath;
  }

  commands(reviewId) {
    return [
      `Valider : npm run expert -- approve ${reviewId}`,
      `Faire corriger : npm run expert -- revise ${reviewId} "corrections de l'expert"`,
      `Abandonner : npm run expert -- reject ${reviewId} "raison"`
    ];
  }

  // Complete enough to forward to the expert as it is: Discord gets every passage in full and the brief attached, Slack
  // the brief in its text; the structured fields and the brief stay alongside for other consumers.
  buildPayload(review) {
    const assessment = review.assessment || {};
    const passages = assessment.passages || [];
    const ping = mention();
    const pingPrefix = ping.tags.length ? `${ping.tags.join(' ')} ` : '';
    const brief = this.renderScript(review, { forExpert: true });
    const filename = briefName(review);
    const embeds = passageEmbeds(passages);
    const unshown = passages.length - embeds.length;
    const validated = assessment.validated || [];
    const validatedLine = validated.length
      ? `${validated.length} passage${validated.length > 1 ? 's' : ''} au-dessus de ${score(assessment.confidenceThreshold)}/10 de confiance, sans expert (npm run expert -- show ${review.id})`
      : null;
    // Slack's text: plain lines, Slack does not read Discord markdown, then the whole brief.
    const plain = clip([
      `${pingPrefix}🔬 Relecture experte requise${review.revision > 1 ? ` (révision ${review.revision})` : ''} : « ${review.title} »`,
      `Domaine : ${review.domain || 'non déterminé'}${assessment.expertProfile ? `. À faire relire par : ${assessment.expertProfile}` : ''}`,
      assessment.unchanged ? '⚠️ Le script réécrit est identique au précédent : les corrections n\'ont pas été appliquées.' : null,
      validatedLine ? `Validés automatiquement : ${validatedLine}.` : null,
      'La vidéo attend avant la voix et le montage ; rien ne sera publié sans décision.',
      ...this.commands(review.id),
      '',
      brief
    ].filter(line => line !== null).join('\n'), TEXT_LIMIT);
    // Discord's content: who should check what and the commands; the passages follow as embeds. The reason takes the
    // room the rest leaves (it is whole in the brief).
    const content = reason => [
      '## 🔬 Relecture experte requise',
      `${pingPrefix}**« ${md(review.title)} »**${review.revision > 1 ? ` · révision ${review.revision}` : ''}`,
      '',
      `**Domaine** : ${md(review.domain || 'non déterminé')}`,
      assessment.expertProfile ? `**À faire relire par** : ${md(assessment.expertProfile)}` : null,
      reason ? `**Pourquoi** : ${md(reason)}` : null,
      assessment.previousCorrections ? `**Corrections demandées** : ${md(clip(assessment.previousCorrections, 250))}` : null,
      assessment.unchanged ? '⚠️ **Le script réécrit est identique au précédent** : les corrections n\'ont pas été appliquées.' : null,
      passages.length
        ? `**À vérifier** : ${passages.length} passage${passages.length > 1 ? 's' : ''} ci-dessous${unshown ? ` (${unshown > 1 ? `les ${unshown} derniers` : 'le dernier'} dans le fichier joint)` : ''}, et le script complet joint (\`${filename}\`).`
        : `**À vérifier** : tout le script, joint (\`${filename}\`).`,
      validatedLine ? `**Validés automatiquement** : ${md(validatedLine)}.` : null,
      '',
      '### Décision',
      `✅ Valider : \`npm run expert -- approve ${review.id}\``,
      `✏️ Faire corriger : \`npm run expert -- revise ${review.id} "corrections"\``,
      `🗑️ Abandonner : \`npm run expert -- reject ${review.id} "raison"\``,
      '-# La vidéo attend avant la voix et le montage ; rien ne sera publié sans décision. Transfère ce message à l\'expert : le fichier joint contient tout ce qu\'il doit relire.'
    ].filter(line => line !== null).join('\n');
    // The label, and a margin for the backslashes md() adds.
    const room = MESSAGE_LIMIT - content('').length - 60;
    const markdown = content(clip(assessment.reason, Math.max(room, 0))).slice(0, MESSAGE_LIMIT);
    return {
      text: plain,
      content: markdown,
      embeds,
      // Discord pings only the configured mention, never an @everyone that slipped into a quoted passage.
      allowed_mentions: allowedMentions(ping),
      event: 'expert_review_required',
      review: {
        id: review.id,
        jobId: review.jobId,
        revision: review.revision,
        title: review.title,
        topic: review.topic,
        domain: review.domain,
        expertProfile: assessment.expertProfile || null,
        reason: assessment.reason || null,
        passages: assessment.passages || [],
        approximations: assessment.approximations || [],
        scriptPath: review.scriptPath || null,
        createdAt: review.createdAt
      },
      script: { title: review.title, filename, markdown: brief },
      actions: {
        approve: `npm run expert -- approve ${review.id}`,
        revise: `npm run expert -- revise ${review.id} "<corrections>"`,
        reject: `npm run expert -- reject ${review.id} "<raison>"`,
        api: `POST /api/expert-reviews/${review.id}/decision {"decision":"approve|revise|reject","notes":"...","reviewer":"..."}`
      }
    };
  }

  async alert(review) {
    await this.db.createNotification({
      type: 'expert_review_required',
      level: 'warning',
      title: 'Expert review required',
      message: `${review.title}: ${review.domain || 'specialised subject'}`,
      data: { reviewId: review.id, jobId: review.jobId, revision: review.revision }
    }).catch(error => this.logger.warn(`Could not record the expert review notification: ${error.message}`));
    return this.deliver(review);
  }

  async deliver(review) {
    const url = webhookUrl();
    if (!url) {
      this.logger.warn(`Expert review ${review.id} is waiting but EXPERT_REVIEW_WEBHOOK_URL is not set: nobody was alerted (npm run expert lists it)`);
      return this.db.updateExpertReview(review.id, { notifyError: 'EXPERT_REVIEW_WEBHOOK_URL is not set' });
    }
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const payload = this.buildPayload(review);
        await this.http.post(url, discordWebhook(url) ? discordForm(payload) : payload, { timeout: 15000 });
        this.logger.info(`Expert review ${review.id} sent to the webhook (${review.domain || 'specialised subject'})`);
        return this.db.updateExpertReview(review.id, { notifiedAt: new Date().toISOString(), notifyError: null });
      } catch (error) {
        lastError = error;
        if (attempt < 3 && this.retryDelayMs) await new Promise(resolve => setTimeout(resolve, this.retryDelayMs * attempt));
      }
    }
    // The review stays pending and the scheduler sends it again on its next tick.
    const reason = `${lastError?.response?.status ? `HTTP ${lastError.response.status}` : lastError?.message || 'unknown error'}`.slice(0, 300);
    this.logger.warn(`Expert review webhook failed for ${review.id}: ${reason}`);
    return this.db.updateExpertReview(review.id, { notifyError: reason });
  }

  async decide(reviewId, input = {}) {
    const review = await this.db.getExpertReview(reviewId);
    if (!review) throw this.failure(404, 'Expert review not found');
    if (review.status !== 'pending') throw this.failure(409, `This expert review is already ${review.status.replace(/_/g, ' ')}`);
    const decision = String(input.decision || '').trim().toLowerCase();
    if (!DECISIONS[decision]) throw this.failure(400, 'Decision must be approve, revise or reject');
    const notes = text(input.notes, 8000);
    if (decision === 'revise' && notes.length < 10) throw this.failure(400, 'Describe the corrections to make (at least 10 characters)');

    const decided = await this.db.updateExpertReview(review.id, {
      status: DECISIONS[decision],
      decisionNotes: notes || null,
      decidedBy: text(input.reviewer || process.env.EXPERT_REVIEWER, 200) || null,
      decidedAt: new Date().toISOString()
    });
    this.logger.info(`Expert review ${review.id}: ${DECISIONS[decision].replace(/_/g, ' ')}`);
    if (decision === 'reject') {
      await this.closeRejected(decided);
      return { review: decided, resumed: false, message: 'Video dropped; its job is closed.' };
    }
    const resumed = await this.resume(decided);
    return {
      review: decided,
      resumed: resumed.resumed,
      message: resumed.resumed
        ? decision === 'approve' ? 'Production resumed with the approved script.' : 'The script is being rewritten with the corrections; it will come back for review.'
        : `Decision recorded; production resumes on the next scheduler tick (${resumed.reason}).`
    };
  }

  async closeRejected(review) {
    const job = await this.db.getGenerationJob(review.jobId);
    if (!job || job.status !== 'waiting_expert') return;
    await this.db.updateGenerationJob(job.id, {
      status: 'rejected',
      stage: 'expert_review',
      error: `Rejected by expert review${review.decisionNotes ? `: ${review.decisionNotes}` : ''}`.slice(0, 1000),
      completedAt: new Date().toISOString()
    });
  }

  async resume(review) {
    if (!this.resumeJob) return { resumed: false, reason: 'no generation runner' };
    try {
      // Corrections rewrite the script from scratch (the expert's notes reach the script writer); an approval goes on.
      await this.resumeJob(review.jobId, review.status === 'revision_requested' ? { stage: 'script' } : {});
      return { resumed: true };
    } catch (error) {
      return { resumed: false, reason: error.message.slice(0, 200), busy: error.status === 429 };
    }
  }

  // A pending review assessed again under the current rules (a new threshold or prompt): approved automatically when no
  // passage needs an expert any more, otherwise its file and alert are replaced with the passages that still do. Claude
  // already found the subject specialised, so Jev's first sort only decides when asked to (triage: true).
  async reassess(reviewId, { triage = false } = {}) {
    const review = await this.db.getExpertReview(reviewId);
    if (!review) throw this.failure(404, 'Expert review not found');
    if (review.status !== 'pending') throw this.failure(409, `This expert review is already ${review.status.replace(/_/g, ' ')}`);
    const assessment = await this.assess({ topic: review.topic }, review.script || {}, { triage });
    if (assessment.failed || assessment.unavailable) throw this.failure(503, 'The assessment could not run; the review is unchanged');
    // Corrections an expert asked for still go back to that expert.
    const required = mode() === 'always' || assessment.required || review.revision > 1;
    const updated = await this.db.updateExpertReview(review.id, {
      domain: assessment.domain || review.domain,
      assessment: {
        ...assessment,
        required,
        expertProfile: assessment.expertProfile || review.assessment?.expertProfile || '',
        // What came from the previous round, not from the assessment.
        previousCorrections: review.assessment?.previousCorrections || null,
        unchanged: review.assessment?.unchanged || false
      }
    });
    if (!required) {
      const passed = assessment.validated.map(item => `« ${clip(item.excerpt, 80)} » ${score(item.confidence)}/10`).join(' ; ');
      const decided = await this.decide(review.id, assessment.triage ? {
        decision: 'approve',
        reviewer: `${AUTOMATIC_REVIEWER} (Jev)`,
        notes: assessment.reason
      } : {
        decision: 'approve',
        reviewer: AUTOMATIC_REVIEWER,
        notes: `Aucun passage à ${score(assessment.confidenceThreshold)}/10 de confiance ou moins${passed ? ` : ${passed}` : ''}.`
      });
      return { ...decided, autoValidated: true };
    }
    const scriptPath = await this.writeScriptFile(updated).catch(() => updated.scriptPath);
    await this.deliver(await this.db.updateExpertReview(review.id, { scriptPath, notifiedAt: null, notifyError: null }));
    const current = await this.db.getExpertReview(review.id);
    return {
      review: current,
      autoValidated: false,
      resumed: false,
      message: `${assessment.passages.length} passage(s) still need an expert; ${current.notifiedAt ? 'the alert was sent again' : 'the alert will be resent on the next scheduler tick'}.`
    };
  }

  // The corrections the script writer must apply when the job's last review asked for some.
  async revisionRequest(jobId) {
    const latest = (await this.db.listExpertReviews({ jobId, limit: 1 }))[0];
    if (latest?.status !== 'revision_requested') return null;
    return {
      notes: latest.decisionNotes,
      reviewer: latest.decidedBy,
      domain: latest.domain,
      expertProfile: latest.assessment?.expertProfile || '',
      previousDraft: latest.script
    };
  }

  // Scheduler tick: resend alerts that never reached the webhook, and resume jobs whose decision could not be acted on
  // when it was taken (generation busy, server restarted).
  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      const jobs = await this.db.listGenerationJobsByStatus('waiting_expert');
      for (const job of jobs) {
        const review = (await this.db.listExpertReviews({ jobId: job.id, limit: 1 }))[0];
        if (!review) continue;
        if (review.status === 'pending') {
          if (!review.notifiedAt && webhookUrl()) await this.deliver(review);
        } else if (review.status === 'rejected') {
          await this.closeRejected(review);
        } else {
          const result = await this.resume(review);
          if (result.resumed) this.logger.info(`Resumed job ${job.id} after expert review ${review.id}`);
          else if (result.busy) break;
          else this.logger.warn(`Could not resume job ${job.id} after expert review ${review.id}: ${result.reason}`);
        }
      }
    })().catch(error => this.logger.error('Expert review tick failed:', error))
      .finally(() => { this.ticking = null; });
    return this.ticking;
  }

  failure(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
  }
}

module.exports = { ExpertReviewService, draftOf, scriptHash, confidenceThreshold, triageThreshold, isAutomaticDecision, DEFAULT_DOMAINS };
