// Mood glow — the three orb moods (playbook p.5: "free · busy ·
// chilling. A colour and pulse on your orb replaces status text.
// Three states are enough; no free-text status to maintain").
//
// Pure + testable, no React. The server mirror is lib/mood.js
// (same states, same validation); the two must agree on MOODS and
// DEFAULT_MOOD — tests/mood.test.mjs covers both sides.
//
// Non-colour cue: every mood also has a distinct pulse speed and a
// text label (orb popover + aria-label), so the state is never
// colour alone. The glow is a ring + soft halo on the orb; the
// speaking glow (green, index.css .orb.speaking) still wins while
// someone is actually talking — mood is the idle state.
export const MOODS = ['free', 'busy', 'chilling'];

export const DEFAULT_MOOD = 'free';

export const MOOD_META = {
  free: {
    label: 'Free to talk',
    short: 'Free',
    // Green — the same "available" green the app already uses for
    // speaking/live, so it reads as open at a glance.
    color: '#34d399',
    pulseSeconds: 2.4
  },
  busy: {
    label: 'Busy — quiet please',
    short: 'Busy',
    // Amber — the app's "away" warmth, not a hard red: busy is a
    // soft do-not-disturb, not an error.
    color: '#fbbf24',
    pulseSeconds: 4.2
  },
  chilling: {
    label: 'Chilling — just hanging',
    short: 'Chilling',
    // Violet — the room's own base colour: present but not asking
    // for anything.
    color: '#a78bfa',
    pulseSeconds: 3.2
  }
};

export const isValidMood = (mood) => MOODS.includes(mood);

// Unknown / missing / legacy values read as the default — a user who
// never picked a mood is "free", and a hand-rolled client cannot park
// an orb in a state the UI has no style for.
export const normalizeMood = (mood) => (isValidMood(mood) ? mood : DEFAULT_MOOD);

export const moodLabel = (mood) => MOOD_META[normalizeMood(mood)].label;

export const moodShort = (mood) => MOOD_META[normalizeMood(mood)].short;
