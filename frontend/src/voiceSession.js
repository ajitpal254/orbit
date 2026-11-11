// Voice-session state for the persistent call (App.jsx owns it).
//
// The session — which room the call is in, when it started, mute /
// deafen / moderator-mute — lives in App, above the view switch, so
// navigating to Friends / Messages / Profile / Notifications / About
// never tears the call down. RoomView and MiniPlayer both read this
// state and dispatch into it, so the room view's voice bar and the
// mini-player always show and control the same session.
//
// Pure logic only: no React, no DOM, no voice engine — the transport
// (voice.js) is untouched. Unit-tested in tests/voiceSession.test.mjs.

export const initialVoiceSessionState = {
  status: 'idle', // 'idle' | 'active'
  joinedAt: null, // ms epoch the current call started (mini-player timer)
  muted: false,
  deafened: false,
  modMuted: false, // a moderator muted me — the mute button is disabled
  modMutedBy: '' // name of the moderator who muted me ('' when not muted)
};

export function voiceSessionReducer(state, action) {
  switch (action.type) {
    case 'join':
      // A fresh call: reset mute/deafen/mod-mute, start the timer.
      return {
        ...initialVoiceSessionState,
        status: 'active',
        joinedAt: action.joinedAt ?? Date.now()
      };
    case 'leave':
      return initialVoiceSessionState;
    case 'set-muted':
      return { ...state, muted: action.muted };
    case 'set-deafened':
      return { ...state, deafened: action.deafened };
    case 'set-mod-muted':
      // Moderator mute is cooperative (voice is P2P — the server cannot
      // force a client silent): my client mutes itself, and unmuting by
      // the moderator unmutes it again.
      return {
        ...state,
        modMuted: action.muted,
        muted: action.muted,
        modMutedBy: action.muted ? (action.by || '') : ''
      };
    default:
      return state;
  }
}

// Call timer: 0:07, 12:34, 1:02:03. Hours appear only past the hour.
export function formatCallDuration(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${minutes}:${String(seconds).padStart(2, '0')}`;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return mmss;
}
