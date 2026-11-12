// Mic test — the pure half of the onboarding mic check
// (playbook p.12: "Onboarding + mic test — first minute decides
// retention"). The component (MicTest.jsx) owns getUserMedia +
// AnalyserNode; this module is the math and the error wording, so
// node --test can cover it without a microphone.

// Same threshold the voice engine uses for "speaking"
// (voice.js SPEAK_THRESHOLD): a level above this is a voice, not
// room noise.
export const MIC_AUDIBLE_THRESHOLD = 0.02;

// RMS of a byte time-domain buffer (AnalyserNode
// getByteTimeDomainData): 0 = silence, ~0.1+ = a voice at normal
// distance. Same formula as VoiceEngine._rms in voice.js, kept in
// sync by tests/micTest.test.mjs.
export function rmsLevel(data) {
  if (!data || data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

export const isAudible = (level, threshold = MIC_AUDIBLE_THRESHOLD) =>
  Number.isFinite(level) && level > threshold;

// How many consecutive above-threshold polls count as "we can hear
// you" — a single blip (a door slam, a cough) must not pass the
// test; sustained speech does.
export const HEARD_POLLS = 3;

// getUserMedia failures, in plain language. The raw error name is
// kept as `code` for logging; the UI shows `message` only.
export function classifyMicError(err) {
  const name = err?.name || '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        code: 'denied',
        message: 'Microphone access was blocked — allow the mic in your browser settings, or skip this step and join listening-only.'
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        code: 'not-found',
        message: 'No microphone was found on this device — you can still join and listen.'
      };
    case 'NotReadableError':
    case 'AbortError':
      return {
        code: 'in-use',
        message: 'Your microphone is busy in another app or tab — close it and try again, or skip and join listening-only.'
      };
    default:
      return {
        code: 'unavailable',
        message: 'The microphone is unavailable right now — you can still join and listen.'
      };
  }
}
