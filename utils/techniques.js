// The techniques of the react profile (utils/react-profile.js): the channel can teach one in a "lesson" video and tag
// every examined claim with the ones it relies on. A closed list, so the public site can group by it. Each technique:
// { id, name, definition, question (the working topic of a lesson on it), signs: [how to recognise it] }. None
// without a profile, and none in standard mode.
const { reactProfile } = require('./react-profile');

function techniques() {
  const list = reactProfile().techniques;
  return Array.isArray(list) ? list.filter(item => item?.id && item.name) : [];
}

function getTechnique(id) {
  const wanted = String(id || '').trim();
  return techniques().find(technique => technique.id === wanted) || null;
}

// Known ids only, in order, without duplicates.
function validTechniqueIds(ids) {
  const known = new Set(techniques().map(technique => technique.id));
  return [...new Set((Array.isArray(ids) ? ids : []).map(id => String(id || '').trim()).filter(id => known.has(id)))];
}

// The list as a prompt reads it: "id: name — definition".
function techniqueCatalog() {
  return techniques().map(technique => `${technique.id}: ${technique.name} — ${technique.definition}`).join('\n');
}

module.exports = { techniques, getTechnique, validTechniqueIds, techniqueCatalog };
