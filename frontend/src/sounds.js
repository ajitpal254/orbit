// Tiny UI sounds, synthesized with WebAudio — no audio files, no network.
// Used for: someone joining the room, mute/unmute, deafen/undeafen.
//
// The context is created lazily and resumes on the first user gesture
// (joining the room, tapping a button). If the browser cannot play audio
// yet, the calls silently do nothing — they never throw.

let ctx = null;

function getCtx() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone({ freq, at = 0, dur = 0.12, type = 'sine', vol = 0.12 }) {
  const ac = getCtx();
  if (!ac) return;
  const t0 = ac.currentTime + at;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(vol, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

  // Focus end: a soft three-note rise (C5 -> E5 -> G5), quieter than
  // the join chime — it closes a quiet session, it should not startle
  // one. RoomView only plays it when the user is neither muted nor
  // deafened (see chimeFocusEnd).
export function playFocusEndSound() {
  tone({ freq: 523.25, dur: 0.18, vol: 0.08 });
  tone({ freq: 659.25, at: 0.16, dur: 0.18, vol: 0.08 });
  tone({ freq: 783.99, at: 0.32, dur: 0.3, vol: 0.08 });
}

// Someone joined the room: bright two-note chime (E5 -> A5).
export function playJoinSound() {
  tone({ freq: 659.25, dur: 0.12 });
  tone({ freq: 880, at: 0.1, dur: 0.16 });
}

// Mute: two notes down (440 -> 330). Unmute: the same two notes up.
export function playMuteSound(muted) {
  if (muted) {
    tone({ freq: 440, dur: 0.09, type: 'triangle' });
    tone({ freq: 329.63, at: 0.08, dur: 0.12, type: 'triangle' });
  } else {
    tone({ freq: 329.63, dur: 0.09, type: 'triangle' });
    tone({ freq: 440, at: 0.08, dur: 0.12, type: 'triangle' });
  }
}

// Deafen: two notes down, lower (330 -> 220). Undeafen: the same two up.
export function playDeafenSound(deafened) {
  if (deafened) {
    tone({ freq: 330, dur: 0.09, type: 'triangle' });
    tone({ freq: 220, at: 0.08, dur: 0.14, type: 'triangle' });
  } else {
    tone({ freq: 220, dur: 0.09, type: 'triangle' });
    tone({ freq: 330, at: 0.08, dur: 0.14, type: 'triangle' });
  }
}
