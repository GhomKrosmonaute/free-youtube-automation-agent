#!/usr/bin/env node
// Lists the voices of the configured TTS provider (TTS_PROVIDER=azure or elevenlabs), or narrates a short
// French sample with one of them so it can be judged by ear before setting AZURE_SPEECH_VOICE / ELEVENLABS_VOICE_ID.
// Usage: npm run voices              -> list the voices
//        npm run voices -- <voice>   -> write data/audio/samples/<voice>.mp3 (~300 characters)
require('dotenv').config();
const path = require('path');
const azure = require('../../utils/azure-tts');
const elevenLabs = require('../../utils/elevenlabs-tts');

const SAMPLE = 'Une éclipse totale ne dure que quelques minutes. Pendant ce court instant, la Lune cache exactement le Soleil, '
  + 'et le ciel s\'assombrit en plein jour. Ce hasard de dimensions ne se reproduit sur aucune autre planète du système solaire.';

(async () => {
  const provider = String(process.env.TTS_PROVIDER || '').toLowerCase();
  if (!['azure', 'elevenlabs'].includes(provider)) throw new Error('Set TTS_PROVIDER=azure or TTS_PROVIDER=elevenlabs in .env first');
  const voice = process.argv[2];
  if (!voice) {
    if (provider === 'azure') {
      const voices = await azure.listVoices();
      for (const item of voices) console.log(`${item.shortName}  ${item.localName}  (${item.gender === 1 ? 'femme' : item.gender === 2 ? 'homme' : 'neutre'})`);
      console.log(`\n${voices.length} voix fr-FR. Écoute-en une avec : npm run voices -- <nom>, puis mets-la dans AZURE_SPEECH_VOICE.`);
    } else {
      const voices = await elevenLabs.listVoices();
      for (const item of voices) {
        const labels = Object.values(item.labels || {}).filter(Boolean).join(', ');
        console.log(`${item.voice_id}  ${item.name}${labels ? `  (${labels})` : ''}`);
      }
      console.log(`\n${voices.length} voix. Ajoute une voix française de narration depuis la Voice Library d'ElevenLabs si besoin,`);
      console.log('puis écoute-la avec : npm run voices -- <voice_id>');
    }
    return;
  }
  const out = path.join(__dirname, '..', '..', 'data', 'audio', 'samples', `${voice.replace(/[^\w.-]+/g, '_')}.mp3`);
  const result = provider === 'azure'
    ? await azure.synthesize(SAMPLE, out, { voice })
    : await elevenLabs.synthesize(SAMPLE, out, { voiceId: voice });
  console.log(`Échantillon : ${out} (${result.model}, ${result.characters} caractères)`);
})().catch(error => { console.error(error.message); process.exit(1); });
