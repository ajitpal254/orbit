// Mood glow — server mirror of frontend/src/mood.js. Same three
// states, same default; the two files must agree (see
// tests/mood.test.mjs, which covers both). Only validation lives
// here — labels and colours are a client concern.
const MOODS = ['free', 'busy', 'chilling'];
const DEFAULT_MOOD = 'free';

const isValidMood = (mood) => MOODS.includes(mood);
const normalizeMood = (mood) => (isValidMood(mood) ? mood : DEFAULT_MOOD);

module.exports = { MOODS, DEFAULT_MOOD, isValidMood, normalizeMood };
