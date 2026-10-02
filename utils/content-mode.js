// The editorial format of the channel (CONTENT_MODE):
// - "standard" (the default): videos explain their subject from start to finish, with one look throughout.
// - "react": the channel reacts to what watched channels publish and to what circulates (utils/react-profile.js says
//   how). A react profile can split a video in two parts, an opening and the main part, each with its own look and
//   music.
const MODES = ['standard', 'react'];

function contentMode() {
  const mode = String(process.env.CONTENT_MODE || '').trim().toLowerCase();
  return MODES.includes(mode) ? mode : 'standard';
}

function isReactMode() {
  return contentMode() === 'react';
}

// The part of a video a section belongs to: "opening" (the first part of a two-part video) or "main".
function registerOf(value) {
  return value === 'opening' ? 'opening' : 'main';
}

function isOpening(value) {
  return registerOf(value) === 'opening';
}

module.exports = { contentMode, isReactMode, registerOf, isOpening, MODES };
