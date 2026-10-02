// React profile: what a channel in react mode (CONTENT_MODE=react) reacts to and how. Copy this file to
// config/react-profile.js (or point REACT_PROFILE at your own) and fill in what your channel needs; every field is
// optional, and an empty field keeps the generic behaviour. Texts are read by the models in English; your videos are
// written in CONTENT_LANGUAGE.
module.exports = {
  // What the channel reacts to, among the new videos of the channels it watches (npm run reactive -- watch @handle).
  watch: {
    // The kind of claim or content a new video must defend or promote to get an answer, e.g. "a claim about <your
    // subject>". Generic: a claim or an argument within the channel's content pillars.
    kind: null,
    // What such a video does, for the yes/no question.
    examples: null,
    // Sentences that are not claims to quote.
    notPassage: null,
    // How the working title of an answer is worded.
    topicRule: null,
    // Three levels of what is at stake for a viewer who believes the claim (urgency of the answer), lowest first.
    stakes: null
  },

  // How the scripts are written.
  script: {
    // true: every video has two parts, an "opening" then the "main" part, each with its own look and music.
    twoPart: false,
    // The narrative structure of a long video (prompt text), in place of the generic one.
    structure: null,
    // The rule for titles, thumbnails, and the chapters of the opening part.
    titleRule: null,
    thumbnailRule: null,
    openingChapterRule: null,
    // Extra narration rules, one sentence each.
    rules: [],
    // The rule for the brand voice, in place of the generic one.
    voiceRule: null
  },

  // Reactions (vertical Shorts answering a watched video).
  answer: {
    // How the answer treats the author and the audience of the video it answers.
    respect: null,
    // ({ part, parts }) => the narrative structure of a reaction Short (prompt text).
    shortStructure: null
  },

  // The claim each video examines and the verdict it reaches. Without verdicts, videos state no claim and no verdict.
  claims: {
    // { id: { label: 'shown on the site', definition: 'for the model', holds: true when the claim stands } }
    verdicts: null,
    // The verdict id given when the model returns an unknown one.
    unknownVerdict: null
  },

  // Techniques the channel teaches (lesson videos) and tags claims with:
  // [{ id, name, definition, question: 'the working topic of a lesson on it', signs: ['how to recognise it'] }]
  techniques: [],

  // Lesson videos: one in `every` teaches one technique (needs techniques).
  lesson: {
    every: 0,
    titleRule: null,
    seoTitleRule: null,
    // technique => the narrative structure of a lesson (prompt text).
    structure: null,
    // due => the planner's instruction when a lesson is due.
    plannerRule: null,
    rationale: null
  },

  // How the planner words topics, and the YouTube title and description rules.
  planner: { topicRule: null },
  seo: { titleRule: null, descriptionRule: null },

  // Shorts cut out of every video.
  shorts: {
    // What "opening" and "main" mean, for the editor (two-part videos).
    partsNote: null,
    // What a Short must carry from the main part.
    mainPartRule: null,
    // Extra rules for the Short's title and description.
    titleRule: null,
    descriptionRule: null
  },

  // Measured topic gaps (npm run gaps, every night in react mode): claims many people watch being supported and few
  // watch being answered. These fields focus the search: the channel's angle, examples of precise claims, which ones to
  // prefer, and how their search query is worded.
  gaps: {
    channel: null,
    examples: null,
    preference: null,
    queryRule: null
  },

  // The weekly web search for channels to watch: { id: 'what a channel of this category publishes' }. None: no search.
  discovery: {
    categories: {},
    // Channels to leave out.
    exclude: null
  },

  // The stances a comment can take on what the video examines, measured by Jev (persuasion). None: no measure.
  audience: {
    // { id: 'what a comment of this stance says' }
    stances: {},
    // The stance the channel wants to see, the stances that engage with the subject, the stances of the audience to
    // reach, and short labels for the dashboard.
    goal: null,
    goalLabel: null,
    engaged: [],
    reach: [],
    labels: {}
  },

  // The look: palettes (blood, ash, abyss, parchment), illustration styles, the music folder of each part of a two-part
  // video (data/music/<folder>), and how the music follows the two parts.
  look: {
    palette: null,
    openingPalette: null,
    imageStyle: null,
    openingImageStyle: null,
    music: { opening: null, main: null },
    musicNote: null
  },

  // The wording of the public site's technique pages and of its quick-answers paragraph.
  site: {
    techniquesTitle: null,
    techniquesIntro: null,
    reactsTo: null
  }
};
