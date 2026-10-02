const path = require('path');
const { runFFmpeg, getMediaDuration } = require('../utils/ffmpeg');
const { scriptScenes } = require('../utils/scene-repair-service');
const { renderSceneClip, PALETTES, paletteFor } = require('../utils/visualizer');
const { generateLocalImage, localImageEngine } = require('../utils/image-generator');
const { composeThumbnail } = require('../utils/thumbnail-composer');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { SceneRepairService } = require('../utils/scene-repair-service');
const { VisualInsertAgent } = require('./visual-insert-agent');
const backgroundMusic = require('../utils/background-music');
const { AITextService } = require('../utils/ai-text-service');
const { srtFromScenes } = require('../utils/narration-timing');
const { renderShort, isShortForm } = require('../utils/vertical-short');
const { registerOf } = require('../utils/content-mode');

class ProductionManagementAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('ProductionManagement');
    this.pipeline = [];
    this.assets = new Map();
    this.aiVideoGenerator = new AIVideoGenerator(credentials, { db });
    this.sceneRepair = new SceneRepairService(db, this.aiVideoGenerator, { logger: this.logger });
    this.visualInserts = new VisualInsertAgent({ credentials, logger: this.logger });
  }

  async initialize() {
    this.logger.info('Initializing Production Management Agent...');
    await this.setupDirectories();
    await this.loadPipeline();
    return true;
  }

  async setupDirectories() {
    const dirs = [
      'data/production',
      'data/assets',
      'data/videos',
      'data/audio',
      'data/scripts',
      'temp/processing'
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(__dirname, '..', dir), { recursive: true });
    }
  }

  async loadPipeline() {
    try {
      const pipeline = await this.db.getProductionPipeline();
      this.pipeline = pipeline || [];
    } catch (error) {
      this.logger.warn('No existing pipeline found, starting fresh');
    }
  }

  async processContent(contentData) {
    try {
      this.logger.info('Processing content for production...');
      
      const { strategy, script, thumbnail, seo, jobId = null } = contentData;
      
      // Create production entry
      const productionId = this.generateProductionId();
      
      const productionData = {
        id: productionId,
        strategy,
        script,
        thumbnail,
        seo,
        status: 'processing',
        assets: {
          script: await this.processScript(script),
          thumbnail: await this.processThumbnail(thumbnail, script),
          audio: null, // Will be generated later
          video: null, // Will be generated later
          captions: null // Will be generated later
        },
        timeline: {
          created: new Date().toISOString(),
          scriptReady: new Date().toISOString(),
          thumbnailReady: new Date().toISOString(),
          audioGenerated: null,
          videoGenerated: null,
          captionsGenerated: null,
          readyForUpload: null
        },
        scheduledPublishTime: this.calculatePublishTime(strategy),
        priority: this.calculatePriority(strategy),
        estimatedDuration: script.duration,
        createdAt: new Date().toISOString()
      };
      productionData.jobId = jobId;
      
      // Add to pipeline
      this.pipeline.push(productionData);
      
      // Save to database
      await this.db.saveProductionData(productionData);
      
      // Generate video content
      await this.generateVideoContent(productionData);
      
      // Generate audio narration
      await this.generateAudioNarration(productionData);
      
      // Final assembly
      await this.assembleVideo(productionData);

      // Persist a scene-addressable production manifest for selective review and repair.
      const scenes = await this.sceneRepair.initializeProduction(productionData, this.aiVideoGenerator.lastVideoResult || {});

      // Closed captions on the measured scene timeline, following the voice word by word.
      await this.generateCaptions(productionData, scenes);

      // A reaction (react mode) is a vertical Short: the narrated scenes laid out for a phone. The 16:9 render is kept.
      if (isShortForm(strategy) && productionData.assets.finalVideo?.path && !productionData.assets.finalVideo.simulated) {
        const { captionsPath, ...vertical } = await this.renderShort(productionData, scenes, { db: this.db });
        productionData.assets.landscapeVideo = productionData.assets.finalVideo;
        productionData.assets.finalVideo = { ...productionData.assets.finalVideo, ...vertical };
        if (captionsPath) productionData.assets.captions = { ...productionData.assets.captions, path: captionsPath };
        this.logger.info(`Vertical Short rendered: ${vertical.duration}s (${vertical.layout})`);
      }

      // Mark as ready — or simulated, when no real video could be produced
      const simulated = Boolean(productionData.assets.finalVideo?.simulated);
      if (simulated) {
        productionData.status = 'simulated';
        this.logger.warn(`Content ${productionId} produced PLACEHOLDER assets only — it will NOT be uploaded. Check your AI provider keys and FFmpeg installation.`);
      } else {
        productionData.status = 'ready';
        productionData.timeline.readyForUpload = new Date().toISOString();
      }

      await this.db.updateProductionData(productionData);

      this.logger.info(`Content processing complete: ${productionId} (status: ${productionData.status})`);
      return productionData;
    } catch (error) {
      this.logger.error('Failed to process content:', error);
      throw error;
    }
  }

  // Injectable for tests.
  renderShort(...args) {
    return renderShort(...args);
  }

  generateProductionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const extra = Math.random().toString(36).substring(2, 15);
    return `prod_${timestamp}_${random}_${extra}`;
  }

  async processScript(script) {
    const scriptPath = path.join(__dirname, '..', 'data', 'scripts', `${Date.now()}_script.json`);
    
    // Create formatted script for TTS
    const ttsScript = this.formatScriptForTTS(script);
    
    // Save script files
    await fs.writeFile(scriptPath, JSON.stringify(script, null, 2));
    await fs.writeFile(
      scriptPath.replace('.json', '_tts.txt'), 
      ttsScript
    );
    
    return {
      originalPath: scriptPath,
      ttsPath: scriptPath.replace('.json', '_tts.txt'),
      duration: script.duration,
      sections: script.mainContent.sections.length
    };
  }

  formatScriptForTTS(script) {
    let ttsText = '';
    
    // Add hook
    if (script.hook) {
      ttsText += `${script.hook.text}\n\n`;
    }
    
    // Add introduction
    if (script.introduction) {
      ttsText += `${script.introduction.greeting}\n`;
      ttsText += `${script.introduction.topicIntro}\n`;
      ttsText += `${script.introduction.valueProposition}\n`;
      ttsText += `${script.introduction.credibility}\n\n`;
    }
    
    // Add main content
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section) => {
        // Section titles are internal labels; only the spoken content is narrated.
        if (Array.isArray(section.content)) {
          section.content.forEach(line => {
            // Lines holding [template placeholders] are never narrated.
            if (typeof line !== 'string' || /\[[^\]]*\]/.test(line)) return;
            const spoken = line.replace(/\s{2,}/g, ' ').trim();
            if (spoken) ttsText += `${spoken}\n\n`;
          });
        } else if (section.steps) {
          section.steps.forEach(step => {
            ttsText += `${step.title}. ${step.description}\n`;
            ttsText += `${step.tip}\n`;
          });
        } else if (section.items) {
          section.items.forEach(item => {
            ttsText += `Number ${item.number}: ${item.title}. ${item.description}\n`;
          });
        } else if (typeof section.content === 'string') {
          ttsText += `${section.content}\n`;
        }
        
        ttsText += '\n';
      });
    }
    
    // Add conclusion
    if (script.conclusion) {
      script.conclusion.recap.forEach(line => {
        if (typeof line === 'string') {
          ttsText += `${line}\n`;
        }
      });
      ttsText += `\n${script.conclusion.finalThought}\n\n`;
    }
    
    // Add CTA
    if (script.callToAction) {
      for (const line of [script.callToAction.subscribe, script.callToAction.like, script.callToAction.comment]) {
        if (line) ttsText += `${line}\n`;
      }
    }
    
    return ttsText;
  }

  async processThumbnail(thumbnail, script) {
    try {
      // Try to generate AI thumbnail first
      const thumbnailScript = thumbnail.script || script || { title: thumbnail.title || 'Untitled Video' };
      const aiThumbnail = await this.aiVideoGenerator.generateThumbnail(thumbnailScript, 'ethereal');
      
      return {
        path: aiThumbnail.path,
        originalPath: thumbnail.path,
        dimensions: aiThumbnail.dimensions,
        fileSize: aiThumbnail.fileSize,
        generatedWith: 'AI'
      };
    } catch (error) {
      this.logger.error('AI thumbnail generation failed:', error);
      
      // Fallback to original processing
      const productionThumbnailPath = path.join(
        __dirname, '..', 'data', 'assets', 
        `thumbnail_${Date.now()}.jpg`
      );
      
      if (thumbnail.path && await fs.access(thumbnail.path).then(() => true).catch(() => false)) {
        const originalBuffer = await fs.readFile(thumbnail.path);
        await fs.writeFile(productionThumbnailPath, originalBuffer);
      } else {
        // Create placeholder
        await fs.writeFile(productionThumbnailPath + '.placeholder', 'Thumbnail placeholder');
      }
      
      return {
        path: productionThumbnailPath,
        originalPath: thumbnail.path,
        dimensions: thumbnail.dimensions || { width: 1792, height: 1024 },
        fileSize: thumbnail.fileSize || 0
      };
    }
  }

  calculatePublishTime(strategy) {
    // Continuous mode: publish as soon as the video clears its gates.
    if (String(process.env.PUBLISH_IMMEDIATELY || '').toLowerCase() === 'true') {
      return new Date(Date.now() + 2 * 60 * 1000).toISOString();
    }
    // Use strategy's recommended time or calculate optimal time
    if (strategy.bestPublishTime) {
      return strategy.bestPublishTime;
    }
    
    // Default: next optimal publishing window
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    tomorrow.setHours(14, 0, 0, 0); // 2 PM default
    
    return tomorrow.toISOString();
  }

  calculatePriority(strategy) {
    let priority = 50; // Base priority
    
    // Adjust based on estimated views
    if (strategy.estimatedViews > 100000) priority += 30;
    else if (strategy.estimatedViews > 50000) priority += 20;
    else if (strategy.estimatedViews > 10000) priority += 10;
    
    // Adjust based on trend score
    if (strategy.competitorAnalysis && strategy.competitorAnalysis.length > 0) {
      priority += 10;
    }
    
    // Time sensitivity
    const hoursUntilPublish = (new Date(strategy.bestPublishTime) - new Date()) / (1000 * 60 * 60);
    if (hoursUntilPublish < 24) priority += 20;
    else if (hoursUntilPublish < 48) priority += 10;
    
    return Math.min(100, priority);
  }

  async generateVideoContent(productionData) {
    this.logger.info('Generating AI video content...');
    
    try {
      const { script } = productionData;
      
      // Generate visual assets using DALL-E
      const visualPrompts = this.createVisualPromptsFromScript(script);
      const visualAssets = [];
      const profile = await this.db.getChannelProfile?.() || {};
      const visualStyle = profile.visual_style || 'ethereal';
      
      for (const prompt of visualPrompts) {
        const assets = await this.aiVideoGenerator.generateVisualAssets(prompt, visualStyle, 1);
        visualAssets.push(...assets);
      }
      
      productionData.assets.video = {
        visualAssets: visualAssets,
        duration: productionData.estimatedDuration,
        format: 'mp4',
        resolution: '1920x1080',
        fps: 30,
        generatedWith: 'AI'
      };
      
      productionData.timeline.videoGenerated = new Date().toISOString();
      
      return visualAssets;
    } catch (error) {
      this.logger.error('AI video content generation failed:', error);
      // Fallback to placeholder
      return await this.createVideoElements(productionData);
    }
  }

  async createVideoElements(productionData) {
    const { script } = productionData;
    const elements = [];
    
    // Title slide
    elements.push({
      type: 'title_slide',
      content: script.title,
      duration: 3,
      style: 'modern',
      animation: 'fade_in'
    });
    
    // Content sections
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach((section) => {
        // Section title
        elements.push({
          type: 'section_title',
          content: section.title,
          duration: 2,
          style: 'minimal',
          animation: 'slide_in'
        });
        
        // Content visuals
        if (section.type === 'list_items' && section.items) {
          section.items.forEach(item => {
            elements.push({
              type: 'list_item',
              content: {
                number: item.number,
                title: item.title,
                description: item.description
              },
              duration: 15,
              style: 'countdown',
              animation: 'zoom_in'
            });
          });
        } else if (section.type === 'solution_steps' && section.steps) {
          section.steps.forEach(step => {
            elements.push({
              type: 'step',
              content: {
                number: step.number,
                title: step.title,
                description: step.description
              },
              duration: 20,
              style: 'tutorial',
              animation: 'step_by_step'
            });
          });
        } else {
          // Generic content slide
          elements.push({
            type: 'content_slide',
            content: section.title,
            duration: section.duration || 30,
            style: 'informative',
            animation: 'fade_transition'
          });
        }
      });
    }
    
    // Conclusion slide
    elements.push({
      type: 'conclusion',
      content: 'Key Takeaways',
      duration: 5,
      style: 'summary',
      animation: 'reveal'
    });
    
    // Subscribe reminder
    elements.push({
      type: 'subscribe_reminder',
      content: 'Subscribe for More!',
      duration: 3,
      style: 'call_to_action',
      animation: 'bounce'
    });
    
    return elements;
  }

  async generateAudioNarration(productionData) {
    this.logger.info('Generating AI audio narration...');
    
    try {
      const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
      
      // Narrate scene by scene so every scene owns an exactly aligned audio segment, then
      // concatenate the segments into the master track. Falls back to one whole-script call.
      let generatedPath;
      let evidence = {};
      let segments = [];
      try {
        segments = await this.generateSceneNarration(productionData);
        generatedPath = await this.concatenateNarration(productionData.id, segments, audioPath);
        evidence = this.aiVideoGenerator.lastNarrationResult || {};
      } catch (sceneError) {
        this.logger.warn(`Per-scene narration failed, narrating the whole script instead: ${sceneError.message}`);
        segments = [];
        const ttsText = await fs.readFile(productionData.assets.script.ttsPath, 'utf8');
        generatedPath = await this.aiVideoGenerator.generateTTSAudio(ttsText, audioPath);
        evidence = this.aiVideoGenerator.lastNarrationResult || {};
      }
      const usable = await this.aiVideoGenerator.isUsableAudioFile(generatedPath);
      const measuredSeconds = segments.length
        ? segments.reduce((sum, segment) => sum + segment.duration, 0)
        : (usable ? await getMediaDuration(generatedPath).catch(() => null) : null);

      productionData.assets.audio = {
        path: generatedPath,
        duration: measuredSeconds ? this.formatSeconds(measuredSeconds) : productionData.estimatedDuration,
        durationSeconds: measuredSeconds || null,
        segments,
        format: 'mp3',
        generatedWith: 'AI',
        quality: usable ? 'high' : null,
        status: usable ? 'ready' : 'unavailable',
        simulated: !usable,
        provider: evidence.provider || null,
        model: evidence.model || null,
        externalTaskId: evidence.externalTaskId || null,
        generatedAt: evidence.generatedAt || new Date().toISOString(),
        cost: evidence.cost || {},
        error: usable ? null : 'No live narration provider returned usable audio',
        intentionalSilence: false
      };

      if (usable) productionData.timeline.audioGenerated = new Date().toISOString();
      return generatedPath;
    } catch (error) {
      this.logger.error('AI audio generation failed:', error);
      return await this.simulateAudioGeneration(productionData, error);
    }
  }

  async generateSceneNarration(productionData) {
    const scenes = scriptScenes(productionData.script || {});
    if (scenes.length < 2) throw new Error('Script has no scene breakdown');
    const directory = path.join(__dirname, '..', 'data', 'audio', 'scenes', productionData.id);
    await fs.mkdir(directory, { recursive: true });
    const segments = [];
    for (const [position, scene] of scenes.entries()) {
      const segmentPath = path.join(directory, `${String(position).padStart(3, '0')}_r1.mp3`);
      const text = String(scene.scriptText || '').trim();
      if (!text) {
        await runFFmpeg(['-y', '-f', 'lavfi', '-t', '1', '-i', 'anullsrc=r=44100:cl=stereo', '-c:a', 'libmp3lame', segmentPath]);
      } else {
        const generated = await this.aiVideoGenerator.generateTTSAudio(text, segmentPath, {
          previousText: String(scenes[position - 1]?.scriptText || ''),
          nextText: String(scenes[position + 1]?.scriptText || '')
        });
        if (!await this.aiVideoGenerator.isUsableAudioFile(generated)) throw new Error(`No usable narration for scene "${scene.label}"`);
      }
      const duration = Number(await getMediaDuration(segmentPath));
      if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not measure narration for scene "${scene.label}"`);
      segments.push({ position, label: scene.label, text, prompt: scene.prompt || '', register: registerOf(scene.register), path: segmentPath, duration: Number(duration.toFixed(2)), ...(scene.illustration ? { illustration: scene.illustration } : {}) });
      this.logger.info(`Narrated scene ${position + 1}/${scenes.length} "${scene.label}" (${duration.toFixed(1)}s)`);
    }
    return segments;
  }

  async concatenateNarration(productionId, segments, outputPath) {
    const listPath = path.join(path.dirname(segments[0].path), 'concat.txt');
    await fs.writeFile(listPath, segments.map(segment => `file '${segment.path.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '160k', outputPath]);
    await fs.unlink(listPath).catch(() => {});
    return outputPath;
  }

  formatSeconds(seconds) {
    const total = Math.round(Number(seconds) || 0);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  async generateCaptions(productionData, scenes) {
    this.logger.info('Generating captions...');
    
    const captionsPath = path.join(__dirname, '..', 'data', 'captions', `${productionData.id}_captions.srt`);
    await fs.mkdir(path.dirname(captionsPath), { recursive: true });
    await fs.writeFile(captionsPath, await srtFromScenes(scenes || []));
    
    productionData.assets.captions = {
      path: captionsPath,
      format: 'srt',
      language: process.env.CONTENT_LANGUAGE || 'en',
      autoGenerated: true,
      sceneAware: true
    };
    
    productionData.timeline.captionsGenerated = new Date().toISOString();
    
    return captionsPath;
  }

  async assembleVideo(productionData) {
    this.logger.info('Assembling final AI-generated video...');
    
    try {
      const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
      const narrationReady = await this.aiVideoGenerator.isUsableAudioFile(productionData.assets.audio?.path);
      if (!narrationReady && productionData.assets.audio?.intentionalSilence !== true) {
        this.logger.warn('Final assembly is blocked until narration succeeds or the operator explicitly confirms an intentional silent video.');
        return await this.simulateVideoAssembly(productionData, 'Narration is missing');
      }

      // Audio-reactive visualizer: one FFmpeg clip per narrated scene, then concatenated. Free, fast, no AI media model.
      const visualMode = String(process.env.VISUAL_MODE || 'illustrated').toLowerCase();
      const segments = productionData.assets.audio?.segments || [];
      if (['visualizer', 'illustrated'].includes(visualMode) && segments.length) {
        const clips = await this.renderVisualizerClips(productionData, segments);
        const soundtrack = await this.prepareSoundtrack(productionData, segments);
        await this.concatenateClips(clips, soundtrack || productionData.assets.audio.path, finalVideoPath);
        if (soundtrack) await fs.unlink(soundtrack).catch(() => {});
        this.aiVideoGenerator.lastVideoResult = {
          requestedProvider: 'visualizer', actualProvider: 'visualizer', model: 'ffmpeg-showwaves', mode: 'visualizer',
          generatedSeconds: 0, tasks: [],
          scenes: clips.map(clip => ({ index: clip.index, label: clip.label, prompt: '', duration: clip.duration, path: clip.path, taskId: null, provider: 'visualizer', model: 'ffmpeg-showwaves' }))
        };
        const stats = await fs.stat(finalVideoPath);
        productionData.assets.finalVideo = {
          path: finalVideoPath, fileSize: stats.size,
          duration: productionData.assets.audio.duration || productionData.estimatedDuration,
          generatedWith: 'ffmpeg-visualizer', resolution: '1920x1080', format: 'mp4',
          provider: this.aiVideoGenerator.lastVideoResult
        };
        productionData.containsSyntheticMedia = false;
        // Real thumbnail: a dedicated illustration (subject on the right, room for the headline on the left)
        // in the register of the opening, falling back to the first scene illustration.
        const illustrated = segments.find(segment => segment.imagePath);
        if (illustrated) {
          try {
            const thumbnailPath = path.join(__dirname, '..', 'data', 'thumbnails', `${productionData.id}_thumbnail.jpg`);
            const register = registerOf(segments[0]?.register);
            const imagePath = await this.generateThumbnailIllustration(productionData, register) || illustrated.imagePath;
            await composeThumbnail({
              imagePath, title: productionData.script?.title || '', text: productionData.script?.thumbnailText || '',
              outputPath: thumbnailPath, accent: PALETTES[paletteFor(register, process.env.VISUAL_PALETTE)]?.accent
            });
            const thumbStats = await fs.stat(thumbnailPath);
            productionData.assets.thumbnail = {
              ...(productionData.assets.thumbnail || {}), path: thumbnailPath, originalPath: imagePath,
              dimensions: { width: 1280, height: 720 }, fileSize: thumbStats.size, generatedWith: 'illustration+ffmpeg', simulated: false
            };
          } catch (error) {
            this.logger.warn(`Thumbnail composition failed: ${error.message.slice(0, 200)}`);
          }
        }
        this.logger.info(`Visualizer video assembled from ${clips.length} scene clips`);
        return finalVideoPath;
      }

      // Use AI Video Generator to create the final video
      const producedPath = await this.aiVideoGenerator.generateVideo(
        productionData.script,
        productionData.assets.video.visualAssets || [],
        productionData.assets.audio.path,
        finalVideoPath,
        {
          jobId: productionData.jobId,
          productionId: productionData.id,
          estimatedDuration: productionData.estimatedDuration
        }
      );

      // The generator falls back to a placeholder .info file when it cannot render
      if (!producedPath || path.extname(producedPath).toLowerCase() !== '.mp4') {
        return await this.simulateVideoAssembly(productionData);
      }

      // Get file stats
      const stats = await fs.stat(finalVideoPath);
      
      productionData.assets.finalVideo = {
        path: finalVideoPath,
        fileSize: stats.size,
        duration: productionData.estimatedDuration,
        generatedWith: 'AI',
        resolution: '1920x1080',
        format: 'mp4',
        provider: this.aiVideoGenerator.lastVideoResult || { actualProvider: 'slideshow', model: 'local-ffmpeg' }
      };
      productionData.containsSyntheticMedia = Boolean(
        this.aiVideoGenerator.lastVideoResult?.actualProvider &&
        !['slideshow', 'simulation', 'visualizer'].includes(this.aiVideoGenerator.lastVideoResult.actualProvider)
      );
      
      this.logger.info('AI video assembly complete');
      return finalVideoPath;
    } catch (error) {
      this.logger.error('AI video assembly failed:', error);
      // Fallback to simulation
      return await this.simulateVideoAssembly(productionData);
    }
  }

  async renderVisualizerClips(productionData, segments) {
    const directory = path.join(__dirname, '..', 'data', 'assets', 'scenes', productionData.id);
    await fs.mkdir(directory, { recursive: true });
    const clips = [];
    const inserts = await this.prepareVisualInserts(productionData, segments, directory);
    const illustrate = String(process.env.VISUAL_MODE || 'illustrated').toLowerCase() === 'illustrated' && localImageEngine();
    let previousImage = null;
    for (const segment of segments) {
      const clipPath = path.join(directory, `${String(segment.position).padStart(3, '0')}_r1.mp4`);
      let imagePath = null;
      if (illustrate && segment.illustration === 'previous' && previousImage) {
        imagePath = previousImage;
      } else if (illustrate) {
        const candidate = path.join(directory, `${String(segment.position).padStart(3, '0')}_illustration.png`);
        const prompt = segment.prompt || `${productionData.script?.title || ''}. ${segment.label || ''}`;
        try {
          imagePath = await generateLocalImage({ prompt, outputPath: candidate, logger: this.logger, register: segment.register });
        } catch (error) {
          this.logger.warn(`Illustration failed for scene "${segment.label}", using the spectrum look: ${error.message.slice(0, 200)}`);
        }
      }
      await renderSceneClip({
        audioPath: segment.path, outputPath: clipPath, imagePath,
        title: productionData.script?.title || '', label: segment.label || '', text: segment.text || '',
        durationSeconds: segment.duration, palette: process.env.VISUAL_PALETTE,
        register: segment.register, showTitle: segment.position === 0, inserts: inserts.get(segment.position) || []
      });
      if (imagePath) {
        segment.imagePath = imagePath;
        previousImage = imagePath;
      }
      clips.push({ index: segment.position, label: segment.label, path: clipPath, duration: segment.duration });
      this.logger.info(`Rendered visualizer clip ${segment.position + 1}/${segments.length} "${segment.label}"`);
    }
    return clips;
  }

  // Cards over the scenes (scripture, equations, portraits, documents...), timed on the narration. Optional: if the
  // agent fails, the scenes are rendered without cards. Credits are kept for the video description.
  async prepareVisualInserts(productionData, segments, directory) {
    if (!VisualInsertAgent.enabled()) return new Map();
    try {
      const result = await this.visualInserts.prepare({
        script: productionData.script || {},
        segments,
        outputDir: path.join(directory, 'inserts'),
        cacheDir: path.join(__dirname, '..', 'data', 'assets', 'insert-cache')
      });
      productionData.assets.inserts = { items: result.items, credits: result.credits };
      for (const segment of segments) {
        if (result.byScene.has(segment.position)) segment.inserts = result.byScene.get(segment.position);
      }
      return result.byScene;
    } catch (error) {
      this.logger.warn(`Visual inserts skipped: ${error.message.slice(0, 200)}`);
      return new Map();
    }
  }

  // Narration with ambient music under it (utils/background-music.js). Without tracks in data/music, or if the mix
  // fails, the video keeps the bare narration.
  async prepareSoundtrack(productionData, segments) {
    if (!backgroundMusic.enabled()) return null;
    try {
      await this.chooseMusicAmbiances(productionData, segments);
      const result = await backgroundMusic.mixSoundtrack({
        narrationPath: productionData.assets.audio.path,
        segments,
        outputPath: path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_soundtrack.flac`),
        key: productionData.id
      });
      if (!result) {
        this.logger.info(`No background music: add tracks to ${backgroundMusic.musicDir()}`);
        return null;
      }
      productionData.assets.music = { tracks: result.tracks, credits: result.credits };
      this.logger.info(`Background music: ${result.tracks.map(track => `${track.file} (${track.ambiance})`).join(', ')}`);
      return result.path;
    } catch (error) {
      this.logger.warn(`Background music skipped: ${error.message.slice(0, 200)}`);
      return null;
    }
  }

  // With folders beyond the default ones in data/music, the model gives each scene an ambiance that fits what it says
  // (and, in a two-part video, each part). On failure every scene keeps its part's default music.
  async chooseMusicAmbiances(productionData, segments) {
    const names = await backgroundMusic.ambiances();
    if (!names.some(name => !Object.values(backgroundMusic.defaults()).includes(name))) return;
    try {
      this.aiText = this.aiText || new AITextService(this.credentials?.credentials || this.credentials || {});
      const choices = await backgroundMusic.chooseAmbiances({ aiText: this.aiText, script: productionData.script || {}, segments, names });
      for (const segment of segments) segment.ambiance = choices.get(segment.position);
    } catch (error) {
      this.logger.warn(`Music ambiances skipped, each phase keeps its default music: ${error.message.slice(0, 200)}`);
    }
  }

  async generateThumbnailIllustration(productionData, register) {
    if (!localImageEngine()) return null;
    const script = productionData.script || {};
    const subject = script.thumbnailImagePrompt || script.hookImagePrompt || script.title || '';
    if (!subject) return null;
    const outputPath = path.join(__dirname, '..', 'data', 'assets', 'scenes', productionData.id, 'thumbnail_illustration.png');
    try {
      return await generateLocalImage({
        prompt: `${subject}. The main subject is large and close, placed in the right third of the frame; the left half is calm, dark, empty negative space`,
        outputPath, register, logger: this.logger
      });
    } catch (error) {
      this.logger.warn(`Thumbnail illustration failed, reusing a scene illustration: ${error.message.slice(0, 200)}`);
      return null;
    }
  }

  async concatenateClips(clips, masterAudioPath, outputPath) {
    const listPath = path.join(path.dirname(clips[0].path), 'concat.txt');
    await fs.writeFile(listPath, clips.map(clip => `file '${clip.path.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await runFFmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-i', masterAudioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', outputPath]);
    await fs.unlink(listPath).catch(() => {});
    return outputPath;
  }

  async getPipelineStatus() {
    return this.pipeline.map(item => ({
      id: item.id,
      title: item.script?.title || 'Untitled',
      status: item.status,
      priority: item.priority,
      scheduledPublishTime: item.scheduledPublishTime,
      progress: this.calculateProgress(item)
    }));
  }

  calculateProgress(productionData) {
    const milestones = [
      'scriptReady',
      'thumbnailReady',
      'audioGenerated',
      'videoGenerated',
      'captionsGenerated',
      'readyForUpload'
    ];
    
    const completed = milestones.filter(milestone => 
      productionData.timeline[milestone] !== null
    ).length;
    
    return Math.round((completed / milestones.length) * 100);
  }

  async getNextReadyContent() {
    const ready = this.pipeline
      .filter(item => item.status === 'ready')
      .sort((a, b) => b.priority - a.priority);
    
    return ready[0] || null;
  }

  // Helper method to create visual prompts from script content
  createVisualPromptsFromScript(script) {
    const prompts = [];
    
    // Title prompt
    prompts.push(`${script.title}, clear visual storytelling`);
    
    // Content-based prompts
    if (script.mainContent && script.mainContent.sections) {
      script.mainContent.sections.forEach(section => {
        if (section.title) {
          prompts.push(`${section.title}, relevant explanatory visual`);
        }
      });
    }
    
    // Ensure we have at least 3 prompts
    while (prompts.length < 3) {
      prompts.push(`${script.title || 'Video topic'}, supporting explanatory visual`);
    }
    
    return prompts.slice(0, 5); // Limit to 5 for cost control
  }

  // Fallback simulation methods
  async simulateAudioGeneration(productionData, failure = null) {
    const audioPath = path.join(__dirname, '..', 'data', 'audio', `${productionData.id}_narration.mp3`);
    
    await fs.writeFile(audioPath + '.info', JSON.stringify({
      message: 'AI TTS audio would be generated here',
      timestamp: new Date().toISOString()
    }, null, 2));
    
    productionData.assets.audio = {
      path: audioPath + '.info',
      duration: productionData.estimatedDuration,
      format: 'mp3',
      status: 'unavailable',
      simulated: true,
      provider: this.aiVideoGenerator.lastNarrationResult?.provider || 'simulation',
      model: this.aiVideoGenerator.lastNarrationResult?.model || null,
      externalTaskId: this.aiVideoGenerator.lastNarrationResult?.externalTaskId || null,
      generatedAt: this.aiVideoGenerator.lastNarrationResult?.generatedAt || new Date().toISOString(),
      cost: this.aiVideoGenerator.lastNarrationResult?.cost || { billed: false },
      error: failure?.message || this.aiVideoGenerator.lastNarrationResult?.error || 'No live narration provider is configured',
      intentionalSilence: false
    };
    
    return audioPath + '.info';
  }

  async simulateVideoAssembly(productionData, reason = null) {
    const finalVideoPath = path.join(__dirname, '..', 'data', 'videos', `${productionData.id}_final.mp4`);
    
    const assemblyInstructions = {
      message: 'AI video would be assembled here',
      blockedReason: reason,
      assets: productionData.assets,
      timestamp: new Date().toISOString()
    };
    
    await fs.writeFile(
      finalVideoPath + '.assembly.json',
      JSON.stringify(assemblyInstructions, null, 2)
    );
    
    productionData.assets.finalVideo = {
      path: finalVideoPath + '.assembly.json',
      fileSize: 0,
      duration: productionData.estimatedDuration,
      simulated: true,
      blockedReason: reason
    };
    
    return finalVideoPath + '.assembly.json';
  }
}

module.exports = { ProductionManagementAgent };
