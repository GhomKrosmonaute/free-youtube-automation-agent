const fs = require('fs').promises;
const path = require('path');
const { google } = require('googleapis');
const inquirer = require('inquirer');
const chalk = require('chalk');
const { Logger } = require('./logger');
const { PROVIDERS, GEMINI_MODELS, GEMINI_DEFAULT_MODEL } = require('./ai-text-service');

class CredentialManager {
  constructor() {
    this.logger = new Logger('CredentialManager');
    this.credentialsPath = path.join(__dirname, '..', 'config', 'credentials.json');
    this.tokensPath = path.join(__dirname, '..', 'config', 'tokens.json');
    this.credentials = {};
    this.tokens = {};
  }

  async initialize() {
    try {
      await this.loadCredentials();
      await this.loadTokens();
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize credentials:', error);
      return false;
    }
  }

  async loadCredentials() {
    try {
      const data = await fs.readFile(this.credentialsPath, 'utf8');
      this.credentials = JSON.parse(data);
    } catch (error) {
      this.credentials = {};
    }
  }

  async loadTokens() {
    try {
      const data = await fs.readFile(this.tokensPath, 'utf8');
      this.tokens = JSON.parse(data);
    } catch (error) {
      this.tokens = {};
    }
  }

  async saveCredentials() {
    await fs.mkdir(path.dirname(this.credentialsPath), { recursive: true });
    await fs.writeFile(this.credentialsPath, JSON.stringify(this.credentials, null, 2));
  }

  async saveTokens() {
    await fs.mkdir(path.dirname(this.tokensPath), { recursive: true });
    await fs.writeFile(this.tokensPath, JSON.stringify(this.tokens, null, 2));
  }

  // Rewrites one platform's tokens on top of what is on disk, so a refresh never drops another platform's login.
  async saveTokenFor(platform, value) {
    let onDisk = {};
    try {
      onDisk = JSON.parse(await fs.readFile(this.tokensPath, 'utf8'));
    } catch (_error) {
      onDisk = {};
    }
    onDisk[platform] = value;
    this.tokens = { ...this.tokens, ...onDisk };
    await fs.mkdir(path.dirname(this.tokensPath), { recursive: true });
    await fs.writeFile(this.tokensPath, JSON.stringify(onDisk, null, 2));
  }

  // YouTube API Authentication
  async setupYouTubeCredentials() {
    console.log(chalk.cyan('\n🎬 YouTube API Setup'));
    console.log(chalk.gray('You need to create a YouTube Data API project in Google Cloud Console'));
    console.log(chalk.gray('Visit: https://console.cloud.google.com/'));
    
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'clientId',
        message: 'Enter your YouTube API Client ID:',
        validate: input => input.length > 0 || 'Client ID is required'
      },
      {
        type: 'password',
        name: 'clientSecret',
        message: 'Enter your YouTube API Client Secret:',
        validate: input => input.length > 0 || 'Client Secret is required'
      },
      {
        type: 'input',
        name: 'redirectUri',
        message: 'Enter your redirect URI:',
        default: 'http://localhost:8080/oauth2callback'
      }
    ]);

    this.credentials.youtube = {
      client_id: answers.clientId,
      client_secret: answers.clientSecret,
      redirect_uris: [answers.redirectUri]
    };

    await this.saveCredentials();
    
    // Authenticate and get tokens
    await this.authenticateYouTube();
    
    console.log(chalk.green('✅ YouTube credentials configured successfully!'));
  }

  async authenticateYouTube() {
    const oauth2Client = new google.auth.OAuth2(
      this.credentials.youtube.client_id,
      this.credentials.youtube.client_secret,
      this.credentials.youtube.redirect_uris[0]
    );

    const scopes = [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube',
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
      'https://www.googleapis.com/auth/youtube.force-ssl'
    ];

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
    });

    console.log(chalk.cyan('\n🔗 Please visit this URL to authorize the application:'));
    console.log(chalk.blue(authUrl));

    const { code } = await inquirer.prompt([
      {
        type: 'input',
        name: 'code',
        message: 'Enter the authorization code:',
        validate: input => input.length > 0 || 'Authorization code is required'
      }
    ]);

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    this.tokens.youtube = tokens;
    await this.saveTokens();

    console.log(chalk.green('✅ YouTube authentication completed!'));
  }

  getYouTubeAuth() {
    if (!this.credentials.youtube || !this.tokens.youtube) {
      throw new Error('YouTube credentials not configured');
    }

    const oauth2Client = new google.auth.OAuth2(
      this.credentials.youtube.client_id,
      this.credentials.youtube.client_secret,
      this.credentials.youtube.redirect_uris[0]
    );

    oauth2Client.setCredentials(this.tokens.youtube);
    return oauth2Client;
  }

  getYouTubeClient() {
    const auth = this.getYouTubeAuth();
    return google.youtube({ version: 'v3', auth });
  }

  hasYouTubeScope(scope) {
    const granted = String(this.tokens?.youtube?.scope || '');
    return granted.split(/\s+/).includes(scope);
  }

  // TikTok Content Posting API (Shorts copies). Desktop Login Kit: loopback redirect URI and PKCE.
  async setupTikTokCredentials() {
    console.log(chalk.cyan('\n🎵 TikTok Content Posting API Setup'));
    console.log(chalk.gray('Create an app at https://developers.tiktok.com/ with Login Kit (Desktop) and the Content Posting API'));

    const current = this.credentials.tiktok || {};
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'clientKey',
        message: 'Enter your TikTok client key:',
        default: current.client_key,
        validate: input => input.length > 0 || 'Client key is required'
      },
      {
        type: 'password',
        name: 'clientSecret',
        message: 'Enter your TikTok client secret:',
        validate: input => input.length > 0 || 'Client secret is required'
      },
      {
        type: 'input',
        name: 'redirectUri',
        message: 'Redirect URI registered in the app:',
        default: current.redirect_uri || 'http://127.0.0.1:8765/tiktok/callback/'
      },
      {
        type: 'input',
        name: 'username',
        message: 'TikTok @username (optional, used to build post links):',
        default: current.username || ''
      }
    ]);

    this.credentials.tiktok = {
      client_key: answers.clientKey.trim(),
      client_secret: answers.clientSecret.trim(),
      redirect_uri: answers.redirectUri.trim(),
      username: answers.username.trim().replace(/^@/, '') || undefined
    };
    await this.saveCredentials();
    await this.authenticateTikTok();
    console.log(chalk.green('✅ TikTok credentials configured successfully!'));
  }

  async authenticateTikTok() {
    const crypto = require('crypto');
    const { pkcePair, authorizeUrl, exchangeCode, DEFAULT_SCOPES } = require('./social-publishers/tiktok');
    const credentials = this.credentials.tiktok;
    const scopes = String(process.env.TIKTOK_SCOPES || DEFAULT_SCOPES.join(',')).split(',').map(scope => scope.trim()).filter(Boolean);
    const state = crypto.randomBytes(16).toString('hex');
    const { verifier, challenge } = pkcePair();
    const url = authorizeUrl({ clientKey: credentials.client_key, redirectUri: credentials.redirect_uri, scopes, state, codeChallenge: challenge });

    console.log(chalk.cyan('\n🔗 Open this URL and authorize the app with the channel\'s TikTok account:'));
    console.log(chalk.blue(url));

    const redirect = new URL(credentials.redirect_uri);
    const loopback = redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname) && redirect.port;
    const received = loopback
      ? await this.waitForLoopbackCode(redirect, state)
      : await this.promptForCode(state);

    const tokens = await exchangeCode({ credentials, code: received, codeVerifier: verifier });
    await this.saveTokenFor('tiktok', tokens);
    console.log(chalk.green(`✅ TikTok authentication completed (scopes: ${tokens.scope || scopes.join(',')})`));
  }

  // Serves the redirect URI on the loopback interface until TikTok sends the code back (5 minutes at most).
  waitForLoopbackCode(redirect, state) {
    const http = require('http');
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, `${redirect.protocol}//${redirect.host}`);
        if (url.pathname.replace(/\/$/, '') !== redirect.pathname.replace(/\/$/, '')) {
          res.writeHead(404);
          res.end();
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error_description') || url.searchParams.get('error');
        const valid = code && url.searchParams.get('state') === state;
        res.writeHead(valid ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(valid ? '<p>TikTok autorisé. Tu peux fermer cette fenêtre.</p>' : `<p>Échec de l'autorisation TikTok : ${error || 'réponse invalide'}</p>`);
        clearTimeout(timer);
        server.close();
        if (valid) resolve(code);
        else reject(new Error(`TikTok authorization failed: ${error || 'state mismatch or missing code'}`));
      });
      const timer = setTimeout(() => {
        server.close();
        reject(new Error('TikTok authorization timed out'));
      }, 5 * 60 * 1000);
      server.listen(Number(redirect.port), redirect.hostname);
      console.log(chalk.gray(`Waiting for TikTok on ${redirect.origin}${redirect.pathname} ...`));
    });
  }

  async promptForCode(state) {
    const { answer } = await inquirer.prompt([{
      type: 'input',
      name: 'answer',
      message: 'Paste the full URL you were redirected to (or just the code):',
      validate: input => input.length > 0 || 'The redirected URL or the code is required'
    }]);
    if (!/^https?:\/\//i.test(answer.trim())) return decodeURIComponent(answer.trim());
    const url = new URL(answer.trim());
    if (url.searchParams.get('state') && url.searchParams.get('state') !== state) throw new Error('TikTok authorization state mismatch');
    const code = url.searchParams.get('code');
    if (!code) throw new Error('No authorization code in the redirected URL');
    return code;
  }

  // Instagram Reels via the Instagram API with Instagram Login (Business or Creator account, no Facebook Page).
  async setupInstagramCredentials() {
    const axios = require('axios');
    const { GRAPH_BASE, GRAPH_ROOT, ASSUMED_LIFETIME_MS } = require('./social-publishers/instagram');
    console.log(chalk.cyan('\n📸 Instagram Reels Setup'));
    console.log(chalk.gray('Meta app > Instagram > API setup with Instagram login > Generate access tokens for the channel account'));

    const current = this.credentials.instagram || {};
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'appId',
        message: 'Instagram app ID (optional):',
        default: current.app_id || ''
      },
      {
        type: 'password',
        name: 'appSecret',
        message: 'Instagram app secret (optional, turns a short-lived token into a 60-day one):'
      },
      {
        type: 'password',
        name: 'accessToken',
        message: 'Paste the access token generated for the account:',
        validate: input => input.length > 0 || 'Access token is required'
      }
    ]);

    let accessToken = answers.accessToken.trim();
    let expiresAt = Date.now() + ASSUMED_LIFETIME_MS;
    const appSecret = answers.appSecret.trim() || current.app_secret;
    if (appSecret) {
      try {
        const { data } = await axios.get(`${GRAPH_ROOT}/access_token`, {
          params: { grant_type: 'ig_exchange_token', client_secret: appSecret, access_token: accessToken }
        });
        if (data?.access_token) {
          accessToken = data.access_token;
          expiresAt = Date.now() + Number(data.expires_in || 60 * 24 * 3600) * 1000;
        }
      } catch (_error) {
        // Tokens generated in the dashboard are already long-lived: keep the pasted one.
        console.log(chalk.gray('Token kept as pasted (already long-lived).'));
      }
    }

    let profile;
    try {
      ({ data: profile } = await axios.get(`${GRAPH_BASE}/me`, { params: { fields: 'user_id,username', access_token: accessToken } }));
    } catch (error) {
      throw new Error(`Instagram rejected the token: ${error.response?.data?.error?.message || error.message}`);
    }
    if (!profile?.user_id) throw new Error('Instagram returned no account id for this token');

    this.credentials.instagram = { app_id: answers.appId.trim() || undefined, app_secret: appSecret || undefined };
    await this.saveCredentials();
    await this.saveTokenFor('instagram', {
      access_token: accessToken,
      user_id: String(profile.user_id),
      username: profile.username || null,
      expires_at: expiresAt
    });
    console.log(chalk.green(`✅ Instagram configured for @${profile.username || profile.user_id}`));
  }

  // OpenAI API Setup
  async setupOpenAICredentials() {
    console.log(chalk.cyan('\n🤖 OpenAI API Setup'));
    console.log(chalk.gray('Get your API key from: https://platform.openai.com/api-keys'));
    
    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your OpenAI API Key:',
        validate: input => input.startsWith('sk-') || 'Invalid OpenAI API key format'
      },
      {
        type: 'list',
        name: 'model',
        message: 'Select your preferred model:',
        choices: [...PROVIDERS.openai.models],
        default: PROVIDERS.openai.defaultModel
      }
    ]);

    this.credentials.openai = {
      apiKey: answers.apiKey,
      model: answers.model
    };

    await this.saveCredentials();
    console.log(chalk.green('✅ OpenAI credentials configured successfully!'));
  }

  // Google Gemini API Setup
  async setupGeminiCredentials() {
    console.log(chalk.cyan('\n💎 Google Gemini API Setup'));
    console.log(chalk.gray('Get your API key from: https://aistudio.google.com/apikey'));

    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your Gemini API Key:',
        validate: input => input.length > 0 || 'API key is required'
      },
      {
        type: 'list',
        name: 'model',
        message: 'Select your preferred Gemini model:',
        choices: [...GEMINI_MODELS],
        default: GEMINI_DEFAULT_MODEL
      }
    ]);

    this.credentials.gemini = {
      apiKey: answers.apiKey,
      model: answers.model
    };

    await this.saveCredentials();
    console.log(chalk.green('✅ Gemini credentials configured successfully!'));
  }

  // OpenRouter Setup
  async setupOpenRouterCredentials() {
    console.log(chalk.cyan('\nOpenRouter Setup'));
    console.log(chalk.gray('Get your API key from: https://openrouter.ai/keys'));
    console.log(chalk.gray('One key gives access to 400+ models (OpenAI, Claude, Gemini, Kimi, GLM, etc.)'));

    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your OpenRouter API Key:',
        validate: input => input.startsWith('sk-or-') || 'Invalid OpenRouter key format (starts with sk-or-)'
      },
      {
        type: 'list',
        name: 'model',
        message: 'Select default model:',
        choices: [...PROVIDERS.openrouter.models],
        default: PROVIDERS.openrouter.defaultModel
      }
    ]);

    this.credentials.aiProvider = {
      provider: 'openrouter',
      apiKey: answers.apiKey,
      model: answers.model
    };

    await this.saveCredentials();
    console.log(chalk.green('OpenRouter configured successfully!'));
  }

  // Kimi (Moonshot AI) Setup
  async setupKimiCredentials() {
    console.log(chalk.cyan('\nKimi (Moonshot AI) Setup'));
    console.log(chalk.gray('Get your API key from: https://platform.kimi.ai'));

    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your Moonshot API Key:',
        validate: input => input.length > 0 || 'API key is required'
      },
      {
        type: 'list',
        name: 'model',
        message: 'Select model:',
        choices: [...PROVIDERS.kimi.models],
        default: PROVIDERS.kimi.defaultModel
      }
    ]);

    this.credentials.aiProvider = {
      provider: 'kimi',
      apiKey: answers.apiKey,
      model: answers.model
    };

    await this.saveCredentials();
    console.log(chalk.green('Kimi credentials configured successfully!'));
  }

  // MiMo (Xiaomi) Setup
  async setupMiMoCredentials() {
    console.log(chalk.cyan('\nMiMo (Xiaomi) Setup'));
    console.log(chalk.gray('Get your API key from: https://mimo.mi.com'));

    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your MiMo API Key:',
        validate: input => input.length > 0 || 'API key is required'
      },
      {
        type: 'list',
        name: 'model',
        message: 'Select model:',
        choices: [...PROVIDERS.mimo.models],
        default: PROVIDERS.mimo.defaultModel
      }
    ]);

    this.credentials.aiProvider = {
      provider: 'mimo',
      apiKey: answers.apiKey,
      model: answers.model
    };

    await this.saveCredentials();
    console.log(chalk.green('MiMo credentials configured successfully!'));
  }

  // GLM (Zhipu AI) Setup
  async setupGLMCredentials() {
    console.log(chalk.cyan('\nGLM (Zhipu AI) Setup'));
    console.log(chalk.gray('Get your API key from: https://z.ai'));

    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your GLM API Key:',
        validate: input => input.length > 0 || 'API key is required'
      },
      {
        type: 'list',
        name: 'model',
        message: 'Select model:',
        choices: [...PROVIDERS.glm.models],
        default: PROVIDERS.glm.defaultModel
      }
    ]);

    this.credentials.aiProvider = {
      provider: 'glm',
      apiKey: answers.apiKey,
      model: answers.model
    };

    await this.saveCredentials();
    console.log(chalk.green('GLM credentials configured successfully!'));
  }

  // Azure Speech Services (TTS)
  async setupAzureSpeechCredentials() {
    console.log(chalk.cyan('\n🎙️  Azure Speech Services Setup'));
    console.log(chalk.gray('Create a Speech service in Azure Portal'));
    
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'subscriptionKey',
        message: 'Enter your Azure Speech subscription key:',
        validate: input => input.length > 0 || 'Subscription key is required'
      },
      {
        type: 'input',
        name: 'region',
        message: 'Enter your Azure region:',
        default: 'eastus'
      },
      {
        type: 'list',
        name: 'voice',
        message: 'Select preferred voice:',
        choices: [
          'en-US-JennyNeural',
          'en-US-GuyNeural',
          'en-US-AriaNeural',
          'en-US-DavisNeural',
          'en-US-AmberNeural'
        ],
        default: 'en-US-JennyNeural'
      }
    ]);

    this.credentials.azureSpeech = {
      subscriptionKey: answers.subscriptionKey,
      region: answers.region,
      voice: answers.voice
    };

    await this.saveCredentials();
    console.log(chalk.green('✅ Azure Speech credentials configured successfully!'));
  }

  // Channel Configuration
  async setupChannelConfig() {
    console.log(chalk.cyan('\n📺 Channel Configuration'));
    
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'channelName',
        message: 'Enter your channel name:',
        validate: input => input.length > 0 || 'Channel name is required'
      },
      {
        type: 'input',
        name: 'channelDescription',
        message: 'Enter channel description:',
        default: 'Automated content channel'
      },
      {
        type: 'input',
        name: 'defaultCategory',
        message: 'Enter default video category ID (22 = People & Blogs):',
        default: '22'
      },
      {
        type: 'list',
        name: 'defaultPrivacy',
        message: 'Select default privacy setting:',
        choices: ['public', 'unlisted', 'private'],
        default: 'private'
      },
      {
        type: 'input',
        name: 'websiteUrl',
        message: 'Enter your website URL (optional):'
      },
      {
        type: 'input',
        name: 'businessEmail',
        message: 'Enter business email (optional):'
      }
    ]);

    this.credentials.channel = answers;
    
    // Set environment variables for the application
    this.setEnvIfPresent('CHANNEL_NAME', answers.channelName);
    this.setEnvIfPresent('DEFAULT_PRIVACY_STATUS', answers.defaultPrivacy);
    this.setEnvIfPresent('WEBSITE_URL', answers.websiteUrl);
    this.setEnvIfPresent('BUSINESS_EMAIL', answers.businessEmail);

    await this.saveCredentials();
    console.log(chalk.green('✅ Channel configuration saved successfully!'));
  }

  // Content Configuration
  async setupContentConfig() {
    console.log(chalk.cyan('\n📝 Content Configuration'));
    
    const answers = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'contentTypes',
        message: 'Select content types to generate:',
        choices: [
          { name: 'Tutorials', value: 'tutorial', checked: true },
          { name: 'Explainers', value: 'explainer', checked: true },
          { name: 'List Videos', value: 'list', checked: true },
          { name: 'Reviews', value: 'review', checked: false },
          { name: 'Stories', value: 'story', checked: false }
        ],
        validate: input => input.length > 0 || 'Select at least one content type'
      },
      {
        type: 'input',
        name: 'competitorChannels',
        message: 'Enter competitor channel IDs (comma-separated):',
        filter: input => input.split(',').map(id => id.trim()).filter(id => id)
      },
      {
        type: 'input',
        name: 'targetAudience',
        message: 'Describe your target audience:',
        default: 'General audience interested in educational content'
      },
      {
        type: 'list',
        name: 'postingFrequency',
        message: 'Select posting frequency:',
        choices: [
          { name: 'Daily', value: 'daily' },
          { name: 'Every other day', value: 'every-2-days' },
          { name: '3 times per week', value: '3-per-week' },
          { name: 'Weekly', value: 'weekly' }
        ],
        default: 'daily'
      },
      {
        type: 'input',
        name: 'preferredPostTime',
        message: 'Preferred posting time (24h format, e.g., 14:00):',
        default: '14:00'
      }
    ]);

    this.credentials.content = answers;
    
    // Set environment variables
    this.setEnvIfPresent('COMPETITOR_CHANNELS', answers.competitorChannels.join(','));
    this.setEnvIfPresent('DEFAULT_AUTHOR', this.credentials.channel?.channelName || 'Content Creator');
    this.setEnvIfPresent('TARGET_AUDIENCE', answers.targetAudience);

    await this.saveCredentials();
    console.log(chalk.green('✅ Content configuration saved successfully!'));
  }

  setEnvIfPresent(key, value) {
    if (value === undefined || value === null || value === '') {
      return;
    }

    process.env[key] = String(value);
  }
  // Validation methods
  hasAITextProvider() {
    if (this.credentials.openai?.apiKey || this.credentials.gemini?.apiKey || this.credentials.aiProvider?.apiKey) {
      return true;
    }

    // Environment-variable based configuration (see utils/ai-text-service.js)
    if (String(process.env.TEXT_PROVIDER || '').toLowerCase() === 'claude-code') return true;
    const envKeys = [...Object.values(PROVIDERS).map(p => p.envKey), 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY'];
    return envKeys.some(key => process.env[key]);
  }

  getMissingCredentials() {
    const missing = [];

    if (!this.credentials.youtube) {
      missing.push('youtube');
    }

    if (!this.hasAITextProvider()) {
      missing.push('an AI provider (Claude, OpenAI, Gemini, OpenRouter, Kimi, MiMo, GLM, or local Ollama)');
    }

    return missing;
  }

  async validateAll() {
    try {
      await this.loadCredentials();
      await this.loadTokens();
    } catch (error) {
      // Files might not exist yet
    }

    const missing = this.getMissingCredentials();

    if (missing.length > 0) {
      console.log(chalk.yellow(`\n⚠️  Missing credentials for: ${missing.join(', ')}`));
      console.log(chalk.gray('Any one AI provider is enough — run: npm run credentials:setup'));
      return false;
    }

    // Validate YouTube tokens
    if (!this.tokens.youtube) {
      console.log(chalk.yellow('\n⚠️  YouTube authentication required'));
      return false;
    }

    return true;
  }

  async testConnections() {
    console.log(chalk.cyan('\n🔍 Testing API connections...'));
    
    const results = {
      youtube: false,
      openai: false,
      azureSpeech: false
    };

    // Test YouTube API
    try {
      const youtube = this.getYouTubeClient();
      await youtube.channels.list({
        part: 'snippet',
        mine: true
      });
      results.youtube = true;
      console.log(chalk.green('✅ YouTube API connection successful'));
    } catch (error) {
      console.log(chalk.red('❌ YouTube API connection failed'));
      this.logger.error('YouTube API test failed:', error);
    }

    // Test OpenAI API
    if (this.credentials.openai) {
      try {
        const OpenAI = require('openai');
        const openai = new OpenAI({ apiKey: this.credentials.openai.apiKey });

        await openai.models.list();
        results.openai = true;
        console.log(chalk.green('✅ OpenAI API connection successful'));
      } catch (error) {
        console.log(chalk.red('❌ OpenAI API connection failed'));
        this.logger.error('OpenAI API test failed:', error);
      }
    }

    return results;
  }

  // Setup wizard
  async runSetupWizard() {
    console.log(chalk.cyan.bold('\n🚀 YouTube Automation Agent Setup Wizard'));
    console.log(chalk.gray('Let\'s configure your credentials and settings...\n'));

    const setupSteps = [
      { name: '🎬 YouTube API', action: () => this.setupYouTubeCredentials() },
      { name: '🤖 AI Service (OpenAI/Gemini)', action: () => this.setupAIService() },
      { name: '🎙️  Text-to-Speech Service', action: () => this.setupTTSService() },
      { name: '📺 Channel Configuration', action: () => this.setupChannelConfig() },
      { name: '📝 Content Configuration', action: () => this.setupContentConfig() }
    ];

    for (const step of setupSteps) {
      console.log(chalk.cyan(`\n${step.name}`));
      await step.action();
    }

    console.log(chalk.green.bold('\n🎉 Setup completed successfully!'));
    console.log(chalk.cyan('You can now run: npm start'));
    
    // Test connections
    await this.testConnections();
  }

  async setupAIService() {
    const { service } = await inquirer.prompt([
      {
        type: 'list',
        name: 'service',
        message: 'Select your preferred AI service:',
        choices: [
          { name: 'OpenAI (GPT-5.6)', value: 'openai' },
          { name: 'Google Gemini (Gemini 3.7)', value: 'gemini' },
          { name: 'OpenRouter (400+ models, one API key)', value: 'openrouter' },
          { name: 'Kimi (Moonshot AI — K3)', value: 'kimi' },
          { name: 'MiMo (Xiaomi — V2.5 Pro)', value: 'mimo' },
          { name: 'GLM (Zhipu AI — GLM-5.3)', value: 'glm' },
        ]
      }
    ]);

    switch (service) {
      case 'openai': return await this.setupOpenAICredentials();
      case 'gemini': return await this.setupGeminiCredentials();
      case 'openrouter': return await this.setupOpenRouterCredentials();
      case 'kimi': return await this.setupKimiCredentials();
      case 'mimo': return await this.setupMiMoCredentials();
      case 'glm': return await this.setupGLMCredentials();
    }
  }

  async setupTTSService() {
    const { service } = await inquirer.prompt([
      {
        type: 'list',
        name: 'service',
        message: 'Select your preferred Text-to-Speech service:',
        choices: [
          { name: 'OpenAI TTS (gpt-4o-mini-tts, uses your OpenAI key)', value: 'openai-tts' },
          { name: 'ElevenLabs (highest quality)', value: 'elevenlabs' },
          { name: 'Azure Speech Services', value: 'azure' },
          { name: 'Skip TTS Setup', value: 'skip' }
        ]
      }
    ]);

    if (service === 'openai-tts') {
      console.log(chalk.green('✅ OpenAI TTS will use your existing OpenAI API key'));
    } else if (service === 'elevenlabs') {
      await this.setupElevenLabsCredentials();
    } else if (service === 'azure') {
      await this.setupAzureSpeechCredentials();
    }
  }

  async setupElevenLabsCredentials() {
    console.log(chalk.cyan('\n🎙️  ElevenLabs Setup'));
    console.log(chalk.gray('Get your API key from: https://elevenlabs.io'));

    const answers = await inquirer.prompt([
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your ElevenLabs API Key:',
        validate: input => input.length > 0 || 'API key is required'
      },
      {
        type: 'input',
        name: 'voiceId',
        message: 'Enter your preferred Voice ID:',
        validate: input => input.length > 0 || 'Voice ID is required'
      }
    ]);

    this.credentials.elevenLabs = {
      apiKey: answers.apiKey,
      voiceId: answers.voiceId
    };

    await this.saveCredentials();
    console.log(chalk.green('✅ ElevenLabs credentials configured successfully!'));
  }
}

// CLI interface for credential setup
if (require.main === module) {
  const credentialManager = new CredentialManager();
  
  const args = process.argv.slice(2);
  const target = args[args.indexOf('setup') + 1];
  const platformSetups = {
    tiktok: () => credentialManager.setupTikTokCredentials(),
    instagram: () => credentialManager.setupInstagramCredentials()
  };
  if (args.includes('setup') && platformSetups[target]) {
    credentialManager.initialize().then(platformSetups[target]).catch(console.error);
  } else if (args.includes('setup')) {
    credentialManager.runSetupWizard().catch(console.error);
  } else {
    console.log('Usage: node credential-manager.js setup [tiktok|instagram]');
  }
}

module.exports = { CredentialManager };
