// React mode (CONTENT_MODE=react) reacts to what watched channels publish and to what circulates on YouTube. The
// mechanics are generic; everything that gives a channel its role comes from its react profile, a JS module at
// REACT_PROFILE (default config/react-profile.js): what it reacts to, how its videos are built, the verdicts it gives,
// the techniques it teaches, the stances it measures in comments, its look. config/react-profile.example.js documents
// every field. Without a profile, react mode answers the new videos of the channels you watch, and nothing more.
const fs = require('fs');
const path = require('path');
const { isReactMode } = require('./content-mode');

const DEFAULT_PATH = path.join(__dirname, '..', 'config', 'react-profile.js');
let cache = null;

function profilePath() {
  return process.env.REACT_PROFILE ? path.resolve(process.env.REACT_PROFILE) : DEFAULT_PATH;
}

// The profile in react mode ({} in standard mode, or without a profile file).
function reactProfile() {
  if (!isReactMode()) return {};
  const file = profilePath();
  if (cache?.file === file) return cache.profile;
  let profile = {};
  if (fs.existsSync(file)) {
    delete require.cache[require.resolve(file)];
    profile = require(file) || {};
  }
  cache = { file, profile };
  return profile;
}

// Tests and tools that change REACT_PROFILE or CONTENT_MODE read the profile again.
function resetReactProfile() {
  cache = null;
}

// The verdict scale of the claims the videos examine: { id: { label, definition, holds } } (holds: the claim stands),
// or null when the channel gives no verdict.
function verdicts() {
  const scale = reactProfile().claims?.verdicts;
  return scale && typeof scale === 'object' && Object.keys(scale).length ? scale : null;
}

// Whether a video's sections are split in two parts, an opening then the main part, each with its look and music.
function twoPartVideos() {
  return reactProfile().script?.twoPart === true;
}

// The look: palettes and illustration styles of the main part and of the opening; the music folders of each part.
function look() {
  const profile = reactProfile().look || {};
  return {
    palette: profile.palette || 'abyss',
    openingPalette: profile.openingPalette || 'parchment',
    imageStyle: profile.imageStyle || null,
    openingImageStyle: profile.openingImageStyle || null,
    music: { opening: profile.music?.opening || 'opening', main: profile.music?.main || 'main' }
  };
}

module.exports = { reactProfile, resetReactProfile, profilePath, verdicts, twoPartVideos, look };
