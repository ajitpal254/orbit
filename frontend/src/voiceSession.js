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
  status: 'idle', // 'idle' | 'active' | 'reconnecting'
  joinedAt: null, // ms epoch the current call started (mini-player timer)
  muted: false,
  deafened: false,
  modMuted: false, // a moderator muted me — the mute button is disabled
  modMutedBy: '', // name of the moderator who muted me ('' when not muted)
  // Screen sharing (v0.8.0): one sharer per room. `sharing` is me
  // sharing; screenSharerId/Name is whoever holds the slot (me or a
  // peer) so the room can show the video layer + banner. shareError
  // is the last refusal, e.g. "Someone is already sharing".
  sharing: false,
  screenSharerId: null,
  screenSharerName: '',
  shareError: ''
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
    case 'reconnecting':
      // Only a live call can start reconnecting — an idle session
      // stays idle (e.g. a socket blip before any join, or a
      // reconnect attempt after the call already ended). The mute /
      // deafen state and the call timer survive: this is the same
      // call, temporarily without a transport.
      if (state.status !== 'active') return state;
      return { ...state, status: 'reconnecting' };
    case 'reconnected':
      // Only a reconnecting session can come back — anything else is
      // already where it should be, so a stale event cannot resurrect
      // an ended call or restart an idle one.
      if (state.status !== 'reconnecting') return state;
      return { ...state, status: 'active' };
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
    case 'share-started':
      // Someone (me or a peer) took the room's one share slot. isMine
      // is passed by the caller — the reducer does not know my id.
      return {
        ...state,
        sharing: !!action.isMine,
        screenSharerId: action.userId || null,
        screenSharerName: action.name || '',
        shareError: ''
      };
    case 'share-stopped':
      // Only the current sharer's stop clears the slot; a stale stop
      // (or someone else's) must never clear a live share. An
      // action with no userId (my own stop button) clears always.
      if (action.userId && state.screenSharerId && String(action.userId) !== String(state.screenSharerId)) {
        return state;
      }
      return { ...state, sharing: false, screenSharerId: null, screenSharerName: '', shareError: '' };
    case 'share-error':
      return { ...state, shareError: action.error || 'Could not start screen sharing.' };
    case 'share-clear-error':
      return { ...state, shareError: '' };
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
