const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const claudeCode = require('./claude-code-provider');
const aiUsage = require('./ai-usage');
const { Logger } = require('./logger');

const GEMINI_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash-lite',
];
const GEMINI_DEFAULT_MODEL = GEMINI_MODELS[0];

const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6',
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    envKey: 'OPENAI_API_KEY',
  },
  openrouter: {
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-5.6-sol',
    models: ['openai/gpt-5.6-sol', 'anthropic/claude-fable-5', 'google/gemini-3.7-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3'],
    envKey: 'OPENROUTER_API_KEY',
  },
  kimi: {
    name: 'Kimi (Moonshot AI)',
    baseURL: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k3',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    envKey: 'MOONSHOT_API_KEY',
  },
  mimo: {
    name: 'MiMo (Xiaomi)',
    baseURL: 'https://api.xiaomimimo.com/v1',
    defaultModel: 'mimo-v2.5-pro',
    models: ['mimo-v2.5-pro', 'mimo-v2.5'],
    envKey: 'MIMO_API_KEY',
  },
  glm: {
    name: 'GLM (Zhipu AI)',
    baseURL: 'https://api.z.ai/api/paas/v4/',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3', 'glm-5.2', 'glm-5.1'],
    envKey: 'GLM_API_KEY',
  },
  ollama: {
    // Local, free, offline. Ollama exposes an OpenAI-compatible endpoint; any non-empty key works.
    name: 'Ollama (local)',
    baseURL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1',
    defaultModel: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
    models: [...new Set([process.env.OLLAMA_MODEL || 'qwen2.5:7b', 'qwen2.5:7b', 'mistral-nemo', 'llama3.1:8b'])],
    envKey: 'OLLAMA_API_KEY',
  },
};

const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';
const CONTENT_LANGUAGE = process.env.CONTENT_LANGUAGE || 'en';
const LANGUAGE_NAMES = { fr: 'French (français)', en: 'English', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese' };
const CONTENT_LANGUAGE_NAME = LANGUAGE_NAMES[CONTENT_LANGUAGE] || CONTENT_LANGUAGE;
const SYSTEM_PROMPT = `You write for a YouTube channel whose language is ${CONTENT_LANGUAGE_NAME} (ISO "${CONTENT_LANGUAGE}"). Every natural-language value you produce (titles, topics, angles, scripts, descriptions, tags, keywords) must be written in ${CONTENT_LANGUAGE_NAME}. JSON keys stay exactly as requested, in English. When JSON is requested, return only the JSON with no preamble, no markdown fences and no commentary.`;

class AITextService {
  constructor(credentials = {}) {
    this.logger = new Logger('AITextService');
    this.client = null;
    this.gemini = null;
    this.model = null;
    this.providerName = null;

    this._init(credentials);
  }

  _init(credentials) {
    const provider = credentials.aiProvider?.provider;
    const apiKey = credentials.aiProvider?.apiKey;
    const model = credentials.aiProvider?.model;

    // Claude Code headless (subscription login, no API credits) has the highest priority when selected.
    if (claudeCode.enabled()) {
      this.claudeCode = true;
      this.model = process.env.CLAUDE_CODE_MODEL || 'opus';
      this.providerName = 'Claude Code (headless)';
      this.logger.info(`Claude Code headless initialized (model: ${this.model})`);
      return;
    }

    // Claude (Anthropic) takes priority over every other provider when configured.
    if (provider === 'anthropic' || process.env.ANTHROPIC_API_KEY) {
      return this._initAnthropic(
        provider === 'anthropic' ? apiKey : process.env.ANTHROPIC_API_KEY,
        (provider === 'anthropic' ? model : null) || process.env.ANTHROPIC_MODEL
      );
    }

    if (provider && PROVIDERS[provider] && apiKey) {
      return this._initOpenAICompatible(PROVIDERS[provider], apiKey, model);
    }

    for (const [, preset] of Object.entries(PROVIDERS)) {
      const key = process.env[preset.envKey];
      if (key) {
        return this._initOpenAICompatible(preset, key);
      }
    }

    const geminiKey = credentials.gemini?.apiKey || process.env.GEMINI_API_KEY;
    if (geminiKey) {
      return this._initGemini(geminiKey, credentials.gemini?.model);
    }

    this.logger.warn('No AI text provider configured — text generation unavailable');
  }

  _initOpenAICompatible(preset, apiKey, model) {
    this.client = new OpenAI({ apiKey, baseURL: preset.baseURL });
    this.model = model || preset.defaultModel;
    this.providerName = preset.name;
    this.logger.info(`${preset.name} initialized (model: ${this.model})`);
  }

  _initAnthropic(apiKey, model) {
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    this.model = model || ANTHROPIC_DEFAULT_MODEL;
    this.providerName = 'Claude (Anthropic)';
    this.logger.info(`Claude initialized (model: ${this.model})`);
  }

  async _generateAnthropic(prompt, maxTokens, model = null, purpose = null) {
    const finish = aiUsage.start(purpose);
    try {
      const { text, response } = await this._requestAnthropic(prompt, maxTokens, model);
      finish({
        provider: 'anthropic',
        model: response.model,
        inputTokens: response.usage?.input_tokens || 0,
        cacheCreationTokens: response.usage?.cache_creation_input_tokens || 0,
        cacheReadTokens: response.usage?.cache_read_input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
        ok: true
      });
      return text;
    } catch (error) {
      finish({ provider: 'anthropic', model: model || this.model, ok: false, error: String(error.message).slice(0, 200) });
      throw error;
    }
  }

  async _requestAnthropic(prompt, maxTokens, model) {
    // Adaptive thinking shares the output budget with the answer, so give the model ample room and stream
    // (long outputs otherwise risk HTTP timeouts). The caller's maxTokens only sets a floor.
    const params = {
      model: model || this.model,
      max_tokens: Math.max(maxTokens * 4, Number(process.env.ANTHROPIC_MAX_TOKENS || 32000)),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }]
    };
    let response;
    try {
      // Server-side refusal fallback: a policy decline re-runs on a fallback model in the same call.
      response = await this.anthropic.beta.messages.stream({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default'
      }).finalMessage();
    } catch (error) {
      if (error instanceof Anthropic.BadRequestError) {
        response = await this.anthropic.messages.stream(params).finalMessage();
      } else {
        throw error;
      }
    }
    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category ? ` (${response.stop_details.category})` : '';
      throw new Error(`Claude declined this request${category}`);
    }
    const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
    if (!text) throw new Error('Claude returned an empty response');
    if (response.stop_reason === 'max_tokens') this.logger.warn('Claude output hit max_tokens; the response may be truncated');
    return { text, response };
  }

  _initGemini(apiKey, model) {
    try {
      const { GoogleGenAI } = require('@google/genai');
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || GEMINI_DEFAULT_MODEL;
      this.providerName = 'Google Gemini';
      this.logger.info(`Gemini initialized (model: ${this.model})`);
    } catch (error) {
      this.logger.error('Failed to initialize Gemini:', error.message);
    }
  }

  // Model for light selection tasks (picking moments to illustrate, music moods): Sonnet on Claude, whichever model
  // writes the scripts; other providers keep their configured model.
  lightModel() {
    if (this.claudeCode) return 'sonnet';
    if (this.anthropic) return 'claude-sonnet-5-5';
    return this.model;
  }

  async generateText(prompt, options = {}) {
    const model = options.model || this.model;
    const maxTokens = options.maxTokens || 2048;
    const temperature = options.temperature ?? 0.7;

    // options.purpose names what the call is for in the usage measurement (npm run ai-usage).
    if (this.claudeCode) {
      return claudeCode.runClaudeCode({ prompt, system: SYSTEM_PROMPT, model: options.model || this.model, purpose: options.purpose });
    }

    if (this.anthropic) {
      return this._generateAnthropic(prompt, maxTokens, options.model, options.purpose);
    }

    if (this.gemini) {
      const config = { maxOutputTokens: maxTokens };
      if (!/^gemini-3\.(?:[5-9]|\d{2,})-/.test(model)) config.temperature = temperature;
      const response = await this.gemini.models.generateContent({
        model,
        contents: prompt,
        config,
      });
      const text = response && response.text;
      if (typeof text !== 'string' || !text.trim()) {
        throw new Error(
          `${this.providerName} returned an empty response. Check the API key and model quota — free-tier Gemini keys are rate-limited and can return empty output.`
        );
      }
      return text;
    }

    if (!this.client) {
      throw new Error('No AI text provider configured');
    }

    const params = {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature,
    };

    try {
      // Newer OpenAI models (gpt-5.x and later) reject the legacy max_tokens
      // parameter with a 400 error and require max_completion_tokens instead.
      const response = await this.client.chat.completions.create({
        ...params,
        max_completion_tokens: maxTokens,
      });
      return this._extractContent(response);
    } catch (error) {
      // Older models and some providers reject max_completion_tokens with a 400;
      // retry the same request using the legacy max_tokens spelling.
      if (
        error &&
        error.status === 400 &&
        /max(_completion)?_tokens/i.test(error.message || '')
      ) {
        const response = await this.client.chat.completions.create({
          ...params,
          max_tokens: maxTokens,
        });
        return this._extractContent(response);
      }
      throw error;
    }
  }

  _extractContent(response) {
    const content =
      response &&
      response.choices &&
      response.choices[0] &&
      response.choices[0].message
        ? response.choices[0].message.content
        : null;

    if (typeof content !== 'string' || !content.trim()) {
      // A null/empty body used to surface as cryptic "Unexpected end of JSON input"
      // in the agents' JSON parsers. Report the real cause instead.
      throw new Error(
        `${this.providerName} returned an empty response. Check the API key and model quota.`
      );
    }
    return content;
  }

  isAvailable() {
    return Boolean(this.claudeCode) || Boolean(this.anthropic) || (!!(this.client || this.gemini));
  }
}

module.exports = { AITextService, PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL };
