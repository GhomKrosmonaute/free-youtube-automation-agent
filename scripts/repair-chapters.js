// Adds YouTube chapters to the descriptions of long videos already published, and changes nothing else. The live
// description is read back from YouTube; any chapter list it holds (including the one-line form left by the old
// upload path that dropped line breaks) is replaced by chapters timed on the measured scenes and titled from what
// each one says. Only the description is sent back. A video whose scenes do not add up to its YouTube length is
// skipped. Dry run by default.
//   node scripts/repair-chapters.js                     # show what would change, every published long video
//   node scripts/repair-chapters.js --apply             # update them on YouTube
//   node scripts/repair-chapters.js --apply <youtubeId> # only these videos
//   --retitle also rewrites chapter lists YouTube already shows (titles read from the narration)
require('dotenv').config();
const { Database } = require('../database/db');
const { CredentialManager } = require('../utils/credential-manager');
const { AITextService } = require('../utils/ai-text-service');
const { chapterSpans, titleChapters, formatChapterBlock, replaceChapterBlock, validateChapters, parseChapters } = require('../utils/chapters');
const { scriptScenes } = require('../utils/scene-repair-service');
const { MAX_DESCRIPTION_LENGTH } = require('../utils/youtube-metadata-validator');

// "PT11M38S" → 698
function isoSeconds(duration) {
  const match = String(duration || '').match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  return match ? Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0) : NaN;
}

function diff(before, after) {
  const old = new Set(before.split('\n'));
  const now = new Set(after.split('\n'));
  return [
    ...before.split('\n').filter(line => !now.has(line)).map(line => `  - ${line.length > 160 ? `${line.slice(0, 160)}…` : line}`),
    ...after.split('\n').filter(line => !old.has(line)).map(line => `  + ${line}`)
  ].join('\n');
}

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const only = new Set(args.filter(arg => !arg.startsWith('--')));
  const db = new Database();
  await db.initialize();
  const credentials = new CredentialManager();
  await credentials.initialize();
  const youtube = credentials.getYouTubeClient();
  const ai = new AITextService(credentials.credentials || {});

  const rows = await db.getAllRows("SELECT * FROM publish_schedule WHERE status = 'published' AND youtube_id IS NOT NULL ORDER BY publish_time");
  const videos = rows.map(row => ({ ...row, metadata: JSON.parse(row.metadata || '{}') }))
    .filter(row => row.metadata.contentType !== 'short' && (!only.size || only.has(row.youtube_id)));
  let changed = 0;
  for (const entry of videos) {
    const label = `${entry.youtube_id} « ${entry.title} »`;
    const bundle = await db.getProductionBundle(entry.production_id);
    const scenes = bundle?.scenes || [];
    if (!scenes.length) {
      console.log(`SKIP ${label}: no scene manifest to time chapters on`);
      continue;
    }
    const { data } = await youtube.videos.list({ part: ['snippet', 'contentDetails'], id: [entry.youtube_id] });
    const video = data.items?.[0];
    if (!video) {
      console.log(`SKIP ${label}: not found on YouTube`);
      continue;
    }
    const youtubeSeconds = isoSeconds(video.contentDetails?.duration);
    const sceneSeconds = scenes.reduce((sum, scene) => sum + (Number(scene.duration) || 0), 0);
    if (!(Math.abs(youtubeSeconds - sceneSeconds) <= 1.5)) {
      console.log(`SKIP ${label}: the scenes last ${sceneSeconds.toFixed(1)}s but the video ${youtubeSeconds}s`);
      continue;
    }

    const registers = scriptScenes(bundle.script || {}).map(blueprint => blueprint.register);
    const spans = chapterSpans(scenes, { registers });
    const key = span => span.sceneIds.join(',');
    const known = new Map((bundle.seo?.chapters || []).filter(chapter => Array.isArray(chapter.sceneIds)).map(chapter => [key(chapter), chapter.title]));
    const titles = spans.every(span => known.has(key(span))) ? spans.map(span => known.get(key(span))) : await titleChapters(spans, ai);
    const chapters = spans.map((span, index) => ({
      start: Number(span.start.toFixed(2)), end: Number(span.end.toFixed(2)), title: titles[index], sceneIds: span.sceneIds
    }));
    const block = formatChapterBlock(chapters, { totalDuration: sceneSeconds });
    if (!block) {
      console.log(`SKIP ${label}: ${validateChapters(chapters, sceneSeconds).join('; ')}`);
      continue;
    }
    const current = String(video.snippet.description || '');
    // A video whose chapters YouTube already shows keeps them as they are, unless --retitle is given.
    if (!args.includes('--retitle') && !validateChapters(parseChapters(current), sceneSeconds).length) {
      console.log(`OK   ${label}: YouTube already shows its chapters`);
      continue;
    }
    const next = replaceChapterBlock(current, block);
    if (next === current) {
      console.log(`OK   ${label}: chapters already in place`);
      continue;
    }
    if (next.length > MAX_DESCRIPTION_LENGTH || validateChapters(parseChapters(next), sceneSeconds).length) {
      console.log(`SKIP ${label}: the new description would be too long or its chapters unreadable`);
      continue;
    }
    console.log(`${apply ? 'EDIT' : 'WOULD EDIT'} ${label}\n${diff(current, next)}\n`);
    if (!apply) continue;
    const { title, tags, categoryId, defaultLanguage, defaultAudioLanguage } = video.snippet;
    await youtube.videos.update({
      part: ['snippet'],
      requestBody: {
        id: entry.youtube_id,
        snippet: {
          title, description: next, categoryId,
          ...(tags ? { tags } : {}),
          ...(defaultLanguage ? { defaultLanguage } : {}),
          ...(defaultAudioLanguage ? { defaultAudioLanguage } : {})
        }
      }
    });
    // Remember the titles so the chapters stay the same if this production is ever touched again.
    await db.saveProductionSnapshot({ ...bundle, seo: { ...bundle.seo, chapters } });
    changed++;
  }
  console.log(apply ? `${changed} description(s) updated.` : 'Dry run: nothing was sent to YouTube (add --apply).');
  await db.close();
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
