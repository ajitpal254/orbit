// Mesh WebRTC voice engine — the only module that knows about
// RTCPeerConnection. The UI talks to it through join/leave/setMuted/
// setDeafened and the onSpeaking callback, so swapping in an SFU client
// (LiveKit) later means replacing this file, not the room UI.
//
// Signaling rides on socket.io (server: lib/socket.js):
//   - every side offers when it learns of a peer: the joiner on
//     `room-state`, existing occupants on `user-joined`. Two sides that
//     learn of each other at the same moment both offer — that is expected,
//     and perfect negotiation below resolves it instead of killing the
//     connection. Always offering (rather than electing one offerer) also
//     keeps mixed old/new clients working: an older client that never
//     offers on `user-joined` still gets an offer from the new side.
//   - perfect negotiation: the side with the smaller socket id is polite —
//     when offers collide it rolls back its own pending offer and answers
//     the incoming one; the impolite side ignores the colliding offer and
//     waits for its own to be answered. Exactly one offer survives per pair.
//   - offers/answers/ICE relay through `signal` { to, type, data }
//   - ICE candidates arriving before the remote description is set are
//     queued and flushed after setRemoteDescription, never dropped.
//   - Google STUN + TURN (only used when a direct peer-to-peer path
//     fails, e.g. both phones on mobile networks behind symmetric NAT).
//     The ICE servers are loaded in join() from frontend/src/turnAuth.js:
//     an account TURN from /api/config when configured, Metered's no-signup
//     static-auth TURN, then Google STUN. Media stays DTLS-SRTP encrypted
//     end to end; a TURN relay only forwards opaque packets and cannot
//     decrypt them.
import { getIceServers, FALLBACK_ICE_SERVERS } from './turnAuth.js';
import { gainForDistance, distanceBetween, SPATIAL_AUDIO_ENABLED } from './proximity.js';
import { clampVolume, supportsOutputSelection } from './audioDevices.js';
import { createIceRecovery, iceRecoveryStep, ICE_DISCONNECTED_GRACE_MS, ICE_RESTART_TIMEOUT_MS } from './iceRecovery.js';
const SPEAK_THRESHOLD = 0.02; // RMS of time-domain audio samples
const SPEAK_POLL_MS = 150;

// Deterministic politeness for perfect negotiation: the side with the
// smaller socket id is polite (rolls back on a colliding offer); the other
// side is impolite (ignores it). Both sides compute the same result.
export function isOfferer(mySocketId, otherSocketId) {
  if (!mySocketId || !otherSocketId) return true;
  return mySocketId > otherSocketId;
}

export class VoiceEngine {
  constructor({ socket, roomId, selfId, onSpeaking, onMicError, onConnectionState, onPlaybackBlocked, offerRetryMs, iceGraceMs, iceRestartTimeoutMs, onIceRecovery, spatialEnabled, onShareTrack, onShareEnded, onLocalShareEnded }) {
    this.socket = socket;
    this.roomId = roomId;
    this.selfId = selfId;
    this.onSpeaking = onSpeaking || (() => {});
    this.onMicError = onMicError || (() => {});
    this.onConnectionState = onConnectionState || (() => {});
    this.onPlaybackBlocked = onPlaybackBlocked || (() => {});
    // ICE recovery (v0.9.0): the engine reports a peer's recovery
    // phases — 'recovering' when a peer's ICE leaves 'stable' for a
    // grace/restart, 'recovered' when it comes back, 'failed' when
    // the peer exhausted its recovery budget and was dropped. The UI
    // decides what that means for the room (it only shows the
    // room-level "Reconnecting…" when no peer is connected); the
    // engine never touches session state itself.
    this.onIceRecovery = onIceRecovery || (() => {});
    // ICE grace / restart timeout: constructor options (like
    // offerRetryMs above) so tests can use short values instead of
    // waiting out the real 2s / 10s.
    this.iceGraceMs = iceGraceMs ?? ICE_DISCONNECTED_GRACE_MS;
    this.iceRestartTimeoutMs = iceRestartTimeoutMs ?? ICE_RESTART_TIMEOUT_MS;
    // Screen sharing (v0.8.0): the UI is told about an incoming video
    // track (onShareTrack), a remote share ending (onShareEnded), and
    // my own capture ending under me — e.g. the browser's own "Stop
    // sharing" button (onLocalShareEnded). The engine never emits the
    // socket screen-share events itself; RoomView owns that, so the
    // claim / broadcast / rollback stays in one place.
    this.onShareTrack = onShareTrack || (() => {});
    this.onShareEnded = onShareEnded || (() => {});
    this.onLocalShareEnded = onLocalShareEnded || (() => {});
    // If an offer goes unanswered (peer missed it, was backgrounded, ...),
    // re-offer once after this delay instead of staying silent forever.
    this.offerRetryMs = offerRetryMs ?? 5000;
    this.peers = new Map(); // socketId -> { pc, audioEl, analyser, data, speaking, pendingCandidates, polite, makingOffer, ignoreOffer, offerRetries, retryTimer, iceMachine, iceTimer, gainNode, elementSource, gain }
    // Socket ids known to be in the current room (from room-state and
    // user-joined). Defense-in-depth for audit H1: _onSignal ignores
    // anything from a socket id not in this set, so even if the server
    // relay ever forwarded a stray offer, the client will not answer it.
    this.occupants = new Set();
    // Proximity audio (v0.6.0): orb positions in % of the room stage.
    // A peer with no entry here has no position data and is heard at
    // full gain (the non-spatial fallback — never silence). See
    // frontend/src/proximity.js for the documented curve, audible
    // radius, hysteresis, and the SPATIAL_AUDIO_ENABLED kill switch.
    this.positions = new Map(); // socketId -> { x, y }
    this.selfPosition = null; // { x, y } — my orb, set by the room view
    this.spatialEnabled = spatialEnabled ?? SPATIAL_AUDIO_ENABLED;
    this.spatialFailed = false; // set when the gain chain cannot be built
    this.localStream = null;
    this.localAnalyser = null;
    this.audioCtx = null;
    this.muted = false;
    this.deafened = false;
    // Audio settings (v0.7.0): master + per-peer volume, and the
    // chosen speaker. Volume rides on the <audio> element (element
    // volume × proximity GainNode = what is heard), so it never
    // touches the gain routing. Per-peer volumes are keyed by
    // socketId and survive re-renders; a peer with no entry plays at
    // master volume. The speaker id is re-applied to every new
    // <audio> element in ontrack, so a mid-call device change sticks
    // for joiners too.
    this.masterVolume = 1;
    this.peerVolumes = new Map(); // socketId -> 0..1
    this.speakerDeviceId = '';
    this.micDeviceId = '';
    this.micFailed = false;
    this.joined = false;
    this._pollTimer = null;
    // Screen sharing (v0.8.0): my captured screen stream (video only —
    // getDisplayMedia({ video: true, audio: false })) and, per peer,
    // the RTCRtpSender carrying that video track, so stopping can
    // removeTrack it from each connection. Audio is untouched: the
    // mic track lives on localStream and is never re-added here.
    this.shareStream = null;
    this.shareSenders = new Map(); // socketId -> RTCRtpSender
    this._onShareTrackEnded = this._onShareTrackEnded.bind(this);
    this.iceServers = null; // loaded in join() before any peer is created
    this._lastLevels = {};
    this._onSignal = this._onSignal.bind(this);
    this._onUserLeft = this._onUserLeft.bind(this);
    this._onRoomState = this._onRoomState.bind(this);
    this._onUserJoined = this._onUserJoined.bind(this);
  }

  async join() {
    if (this.joined) return;
    this.joined = true;
    this.socket.on('signal', this._onSignal);
    this.socket.on('user-left', this._onUserLeft);
    this.socket.on('room-state', this._onRoomState);
    this.socket.on('user-joined', this._onUserJoined);

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      this._setupLocalAnalyser();
    } catch (err) {
      // Mic denied/unavailable: stay in the room as a listener.
      this.micFailed = true;
      this.onMicError('Microphone unavailable — you are listening only.');
    }

    // Load ICE servers before joining: the account TURN (if configured
    // via /api/turn), the no-signup static-auth TURN, then Google STUN.
    // Peers are only created after join-room, so this always lands first.
    await this._loadIceServers();

    this.socket.emit('join-room', { roomId: this.roomId });
    this._pollTimer = setInterval(() => this._pollSpeaking(), SPEAK_POLL_MS);
  }

  async _loadIceServers() {
    try {
      const res = await fetch('/api/config', { credentials: 'include' });
      const cfg = await res.json().catch(() => ({}));
      this.iceServers = await getIceServers(cfg.turn || null);
    } catch {
      try {
        this.iceServers = await getIceServers(null);
      } catch {
        this.iceServers = FALLBACK_ICE_SERVERS;
      }
    }
  }

  leave() {
    this.joined = false;
    clearInterval(this._pollTimer);
    this.socket.off('signal', this._onSignal);
    this.socket.off('user-left', this._onUserLeft);
    this.socket.off('room-state', this._onRoomState);
    this.socket.off('user-joined', this._onUserJoined);
    this.socket.emit('leave-room', { roomId: this.roomId });
    this.occupants.clear();
    this.positions.clear();
    this.selfPosition = null;
    // Leaving stops my share outright: the captured tracks stop (the
    // server also releases my slot on leave-room, so the room hears
    // 'screen-share-stopped'). No renegotiation — the peer connections
    // are closing below anyway.
    this._stopShareTracks();
    for (const [id] of this.peers) this._removePeer(id);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((t) => { t.enabled = !muted; });
    }
    this.socket.emit('mic-state', { roomId: this.roomId, muted });
  }

  setDeafened(deafened) {
    this.deafened = deafened;
    for (const peer of this.peers.values()) {
      if (peer.audioEl) peer.audioEl.muted = deafened;
    }
  }

  // --- screen sharing (v0.8.0) ---
  //
  // getDisplayMedia({ video: true, audio: false }) captures the screen
  // as a video-only stream; the track is added to every existing
  // RTCPeerConnection (a renegotiation per peer — the same _offerTo the
  // audio path uses, so the perfect-negotiation rules still apply) and
  // to any peer created later (_createPeer). Audio negotiation is
  // untouched: the mic track is never removed, replaced, or re-added
  // here, and the video track rides its own sender per peer.
  //
  // The socket claim ('screen-share-started') is NOT emitted here —
  // RoomView emits it after this returns ok, and rolls the local
  // track back (stopScreenShare) if the server refuses the claim
  // ("Someone is already sharing"). Returns { ok: true } or
  // { ok: false, error } — a failed start never leaves a half-added
  // track behind.
  async startScreenShare() {
    if (this.shareStream) return { ok: true };
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return { ok: false, error: 'Screen sharing is not supported in this browser.' };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      return {
        ok: false,
        error: err?.name === 'NotAllowedError'
          ? 'Screen share was cancelled.'
          : 'Could not start screen sharing.'
      };
    }
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, error: 'Screen sharing gave no video track.' };
    }
    this.shareStream = stream;
    // The browser's own "Stop sharing" button ends this track without
    // telling the app — the ended event is the signal for RoomView to
    // run the normal stop path (removeTrack + renegotiate + socket
    // emit), so the room hears about it exactly like a dock stop.
    track.addEventListener('ended', this._onShareTrackEnded);
    for (const [socketId, peer] of this.peers) {
      this._addShareTrackToPeer(socketId, peer);
    }
    for (const socketId of this.peers.keys()) {
      await this._offerTo(socketId);
    }
    return { ok: true };
  }

  // Stop sharing: removeTrack the video sender from every peer and
  // renegotiate (so the remote video track ends and the viewers' layer
  // clears), then stop the captured tracks. Idempotent — stopping
  // when not sharing is a no-op, so the browser-stop callback and the
  // dock button can both call it safely.
  async stopScreenShare() {
    if (!this.shareStream) return;
    const stream = this.shareStream;
    this.shareStream = null;
    for (const [socketId, sender] of this.shareSenders) {
      const peer = this.peers.get(socketId);
      try {
        if (peer?.pc && sender) peer.pc.removeTrack(sender);
      } catch {}
    }
    this.shareSenders.clear();
    stream.getTracks().forEach((t) => {
      try { t.removeEventListener('ended', this._onShareTrackEnded); } catch {}
      t.stop();
    });
    for (const socketId of this.peers.keys()) {
      await this._offerTo(socketId);
    }
  }

  // My capture ended under me (browser chrome stop). The engine does
  // not tear anything down itself — RoomView owns the stop path — it
  // just reports it, so there is exactly one stop sequence.
  _onShareTrackEnded() {
    if (!this.shareStream) return;
    this.onLocalShareEnded();
  }

  // Add the live share track to one peer connection (existing peer, or
  // a peer created after sharing started). The sender is remembered
  // per peer so stopScreenShare can removeTrack exactly that sender.
  _addShareTrackToPeer(socketId, peer) {
    if (!this.shareStream || !peer?.pc) return;
    const track = this.shareStream.getVideoTracks()[0];
    if (!track) return;
    try {
      const sender = peer.pc.addTrack(track, this.shareStream);
      if (sender) this.shareSenders.set(socketId, sender);
    } catch {}
  }

  // Silent track stop for leave(): the senders die with their peer
  // connections, so no removeTrack / renegotiation — just stop the
  // capture so the OS releases the screen.
  _stopShareTracks() {
    if (!this.shareStream) return;
    const stream = this.shareStream;
    this.shareStream = null;
    this.shareSenders.clear();
    stream.getTracks().forEach((t) => {
      try { t.removeEventListener('ended', this._onShareTrackEnded); } catch {}
      t.stop();
    });
  }

  // --- audio settings (v0.7.0) ---
  //
  // Master volume (0..1) multiplies every remote stream; a per-peer
  // volume (0..1) multiplies that peer only. The element volume is
  // master × peer, clamped — so a quiet friend can be turned up
  // without touching anyone else, and the master slider never
  // silences a peer the proximity gain already quieted (the gain
  // chain is untouched; element volume and GainNode multiply).
  setMasterVolume(v) {
    this.masterVolume = clampVolume(v);
    this._applyVolumes();
  }

  setPeerVolume(socketId, v) {
    if (!socketId) return;
    this.peerVolumes.set(socketId, clampVolume(v));
    this._applyVolumes(socketId);
  }

  _applyVolumes(onlySocketId) {
    for (const [socketId, peer] of this.peers) {
      if (onlySocketId && socketId !== onlySocketId) continue;
      if (!peer.audioEl) continue;
      const peerVol = this.peerVolumes.get(socketId) ?? 1;
      try {
        peer.audioEl.volume = clampVolume(this.masterVolume * peerVol);
      } catch {}
    }
  }

  // Switch the microphone mid-call: grab a stream from the chosen
  // device, swap the track into every live peer connection
  // (replaceTrack — no renegotiation, no dropped call), and rebuild
  // the local speaking analyser on the new track. On failure the old
  // mic keeps running and the caller gets { ok: false, error } —
  // a failed switch must never leave the user mic-less.
  async setMicDevice(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, error: 'Microphone selection is not supported in this browser.' };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true, noiseSuppression: true, autoGainControl: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {})
        },
        video: false
      });
    } catch (err) {
      return { ok: false, error: err?.name === 'NotFoundError'
        ? 'That microphone is no longer available.'
        : 'Could not switch microphone.' };
    }
    const newTrack = stream.getAudioTracks()[0];
    if (!newTrack) {
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, error: 'That microphone gave no audio track.' };
    }
    const oldStream = this.localStream;
    this.localStream = stream;
    this.micDeviceId = deviceId || '';
    this.micFailed = false;
    for (const peer of this.peers.values()) {
      const sender = peer.pc?.getSenders?.().find((s) => s.track?.kind === 'audio');
      if (sender) {
        try { await sender.replaceTrack(newTrack); } catch {}
      }
    }
    // The old track stops after the swap so the old device releases.
    if (oldStream && oldStream !== stream) {
      oldStream.getTracks().forEach((t) => t.stop());
    }
    this._setupLocalAnalyser();
    return { ok: true };
  }

  // Switch the speaker (output device). Returns { supported } false
  // where the browser has no setSinkId (Safari, Firefox) — the UI
  // then hides the picker with an explanation instead of a broken
  // control. Applied to every live <audio> element and remembered
  // for joiners (ontrack re-applies it). A per-element failure does
  // not fail the whole switch: the result counts what applied.
  async setSpeakerDevice(deviceId) {
    if (!supportsOutputSelection()) {
      return { supported: false, applied: 0, failed: 0 };
    }
    this.speakerDeviceId = deviceId || '';
    let applied = 0;
    let failed = 0;
    for (const peer of this.peers.values()) {
      if (!peer.audioEl?.setSinkId) { failed += 1; continue; }
      try {
        await peer.audioEl.setSinkId(this.speakerDeviceId);
        applied += 1;
      } catch {
        failed += 1;
      }
    }
    return { supported: true, applied, failed };
  }

  // --- proximity audio (v0.6.0) ---
  //
  // My orb moved (drag / arrow keys / reset) or a remote orb moved
  // (orb-move relay). Gains are recomputed from the distance between
  // my orb and each peer's orb — see proximity.js for the curve.
  // Missing position data on either side means full gain (gain 1):
  // a peer that never moved, or an old client that never sends
  // orb-move, sounds exactly like before this feature existed.
  setSelfPosition(x, y) {
    this.selfPosition = { x, y };
    this._applyProximityGains();
  }

  updateRemotePosition(socketId, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.positions.set(socketId, { x, y });
    this._applyProximityGains();
  }

  // Kill switch (runtime half of SPATIAL_AUDIO_ENABLED): false restores
  // flat voice — every remote stream back to gain 1 — without touching
  // the peer connections. True re-applies distance gains.
  setSpatialEnabled(enabled) {
    this.spatialEnabled = Boolean(enabled);
    this._applyProximityGains();
  }

  // Gain for one peer right now, with hysteresis against its last gain
  // so the volume does not flicker while orbs drift near a boundary.
  _gainForPeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!this.spatialEnabled || this.spatialFailed) return 1;
    if (!this.selfPosition) return 1;
    const pos = this.positions.get(socketId);
    if (!pos) return 1; // no position data: hear normally (full gain)
    return gainForDistance(distanceBetween(this.selfPosition, pos), peer?.gain ?? null);
  }

  _applyProximityGains() {
    for (const [socketId, peer] of this.peers) {
      const gain = this._gainForPeer(socketId);
      peer.gain = gain;
      if (peer.gainNode) {
        try {
          // Smooth the step so a drag does not click the audio.
          if (typeof peer.gainNode.gain.setTargetAtTime === 'function') {
            peer.gainNode.gain.setTargetAtTime(gain, peer.gainNode.context?.currentTime ?? 0, 0.08);
          } else {
            peer.gainNode.gain.value = gain;
          }
        } catch {
          peer.gainNode.gain.value = gain;
        }
      }
    }
  }

  // Route one remote stream through a GainNode so proximity can turn
  // its volume down with distance. The analyser (speaking detection)
  // keeps tapping the raw MediaStreamSource as before — the gain chain
  // only affects what is heard, never what is measured.
  // If any step throws (no AudioContext, element source unsupported),
  // spatialFailed is set and the <audio> element keeps playing flat —
  // conventional voice, never silence. The failure is sticky for the
  // session: a half-built graph must not leave a peer inaudible.
  _routeThroughGain(socketId, audioEl) {
    const peer = this.peers.get(socketId);
    if (!peer || !this.spatialEnabled || this.spatialFailed) return;
    try {
      const ctx = this._ensureAudioCtx();
      const gainNode = ctx.createGain();
      gainNode.gain.value = this._gainForPeer(socketId);
      // Connect gain -> destination BEFORE creating the element source:
      // once createMediaElementSource runs, the element's audio only
      // flows through the graph, so the destination path must already
      // exist or the peer would go silent on a later failure.
      gainNode.connect(ctx.destination);
      const elementSource = ctx.createMediaElementSource(audioEl);
      elementSource.connect(gainNode);
      peer.gainNode = gainNode;
      peer.elementSource = elementSource;
      peer.gain = gainNode.gain.value;
    } catch {
      this.spatialFailed = true;
      if (peer) {
        peer.gainNode = null;
        peer.elementSource = null;
        peer.gain = 1;
      }
    }
  }

  // If the browser blocks audio playback (autoplay policy), the user can
  // tap to retry — returns true when every remote stream is playing.
  async retryPlayback() {
    let ok = true;
    for (const peer of this.peers.values()) {
      if (!peer.audioEl) continue;
      try {
        await peer.audioEl.play();
      } catch {
        ok = false;
      }
    }
    return ok;
  }

  // --- peer connections ---

  _createPeer(socketId) {
    const existing = this.peers.get(socketId);
    // Never orphan a live peer connection: close the old one first.
    if (existing?.pc) {
      try { existing.pc.close(); } catch {}
      if (existing.retryTimer) clearTimeout(existing.retryTimer);
    }
    const pc = new RTCPeerConnection({ iceServers: this.iceServers || FALLBACK_ICE_SERVERS });
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
    }
    // A peer created after sharing started (late joiner) gets the
    // video track with the audio ones, so their first offer already
    // carries the screen — no second renegotiation round needed.
    if (this.shareStream) {
      this._addShareTrackToPeer(socketId, { pc });
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        // Track which kinds of candidates we gathered: if 'relay' never
        // appears, the TURN server is not producing relay candidates.
        const p = this.peers.get(socketId);
        if (p) p.candidateTypes.add(e.candidate.type || 'unknown');
        this._reportConnection(socketId);
        this.socket.emit('signal', { to: socketId, type: 'ice', data: e.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      this._reportConnection(socketId);
    };
    pc.oniceconnectionstatechange = () => {
      this._reportConnection(socketId);
      this._handleIceState(socketId);
    };
    pc.ontrack = (e) => {
      // Screen sharing (v0.8.0): a video track is a shared screen, not
      // voice — it never gets an <audio> element, a GainNode, or a
      // speaking analyser. The UI renders it in the share layer
      // (behind the orbs) and clears the layer when the track ends
      // (the sharer stopped, or left). Audio tracks take the existing
      // path below, untouched.
      if (e.track?.kind === 'video') {
        const stream = e.streams?.[0] || new MediaStream([e.track]);
        this.onShareTrack(socketId, stream);
        try {
          e.track.addEventListener('ended', () => this.onShareEnded(socketId));
        } catch {}
        return;
      }
      const stream = e.streams[0];
      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = this.deafened;
      audioEl.srcObject = stream;
      audioEl.play().catch(() => {
        // Autoplay blocked: the connection may be fine while nothing is
        // heard. The UI offers a tap-to-enable-sound button for this.
        this.onPlaybackBlocked(socketId);
      });
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.audioEl = audioEl;
        peer.analyser = this._analyserFor(stream);
        // Audio settings (v0.7.0): a speaker picked earlier in the
        // call applies to this new element too, and the stored
        // master / per-peer volumes — otherwise a joiner would
        // always arrive at full volume on the default speaker.
        if (this.speakerDeviceId && audioEl.setSinkId) {
          audioEl.setSinkId(this.speakerDeviceId).catch(() => {});
        }
        this._applyVolumes(socketId);
        // Proximity gain: route the element through a GainNode. If
        // the chain cannot be built, _routeThroughGain marks the
        // session spatialFailed and the element plays flat as before.
        this._routeThroughGain(socketId, audioEl);
      }
    };
    this.peers.set(socketId, {
      pc,
      audioEl: null,
      analyser: null,
      data: new Uint8Array(256),
      speaking: false,
      // Keep candidates queued by an early ICE message (see _addIceCandidate).
      pendingCandidates: existing ? existing.pendingCandidates : [],
      // Perfect negotiation: smaller socket id is polite (rolls back on a
      // colliding offer), larger id is impolite (ignores the collision).
      polite: this.socket.id ? this.socket.id < socketId : false,
      makingOffer: existing ? existing.makingOffer : false,
      ignoreOffer: false,
      offerRetries: 0,
      retryTimer: null,
      // ICE recovery (v0.9.0): the per-peer state machine (see
      // iceRecovery.js) + the timer that re-reads the live ICE state
      // when a grace or a restart timeout elapses. Both die with the
      // peer in _removePeer, so a dropped peer never fires a stale
      // recovery step. `recovering` tracks whether the UI has been
      // told this peer is down — it survives a recreate (see
      // _recreatePeer) so one episode reports exactly once.
      iceMachine: createIceRecovery(),
      iceTimer: null,
      recovering: false,
      candidateTypes: new Set(),
      // Proximity audio: the GainNode this peer's stream routes
      // through (null until ontrack builds it, or when spatial
      // audio is off / failed — then the element plays flat).
      gainNode: null,
      elementSource: null,
      gain: 1
    });
    return pc;
  }

  // Report connection + ICE state (and gathered candidate types) to the UI.
  _reportConnection(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    this.onConnectionState(
      socketId,
      peer.pc.connectionState,
      peer.pc.iceConnectionState,
      [...peer.candidateTypes].join('+')
    );
  }

  // ICE recovery (v0.9.0): drive one peer's recovery machine with its
  // live ICE state. 'disconnected' is transient — wait out the grace,
  // then restart ICE; 'failed' (or a restart that never recovers)
  // earns one full peer reconnect; only a second failure gives up.
  // The machine only decides (see iceRecovery.js); this method
  // performs the action and arms the timer that re-reads the live
  // state when a grace / restart timeout elapses. Recovery phases are
  // reported to the UI via onIceRecovery — 'recovering' when the peer
  // goes down and we start fixing it, 'recovered' when its ICE comes
  // back, 'failed' when the peer was dropped. One 'recovering' covers
  // a whole episode (grace → restart → recreate): peer.recovering
  // survives the recreate in _recreatePeer, so the UI is not told
  // twice and 'recovered' still fires when the fresh pc connects. A
  // dropped peer's orb already shows disconnected via
  // onConnectionState; the session itself never ends on one peer's
  // failure — the call is a room, not a 1:1.
  _handleIceState(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer || !peer.pc) return;
    const ice = peer.pc.iceConnectionState;
    const { machine, action } = iceRecoveryStep(peer.iceMachine, ice, Date.now(), {
      graceMs: this.iceGraceMs,
      restartTimeoutMs: this.iceRestartTimeoutMs
    });
    peer.iceMachine = machine;
    if (peer.iceTimer) { clearTimeout(peer.iceTimer); peer.iceTimer = null; }
    if (machine.phase === 'waiting') {
      peer.iceTimer = setTimeout(() => { peer.iceTimer = null; this._handleIceState(socketId); }, this.iceGraceMs);
    } else if (machine.phase === 'restarting') {
      peer.iceTimer = setTimeout(() => { peer.iceTimer = null; this._handleIceState(socketId); }, this.iceRestartTimeoutMs);
    }
    const isDown = machine.phase === 'waiting' || machine.phase === 'restarting';
    if (isDown && !peer.recovering) {
      peer.recovering = true;
      this.onIceRecovery(socketId, 'recovering');
    }
    if ((ice === 'connected' || ice === 'completed') && peer.recovering) {
      peer.recovering = false;
      this.onIceRecovery(socketId, 'recovered');
    }
    if (action === 'restart-ice') {
      try { peer.pc.restartIce(); } catch {}
    } else if (action === 'recreate-peer') {
      this._recreatePeer(socketId);
    } else if (action === 'give-up') {
      this._removePeer(socketId);
      this.onIceRecovery(socketId, 'failed');
    }
  }

  // A full reconnect for one peer: the old pc is dead (ICE failed, or
  // a restart never recovered), so drop it and negotiate a fresh one
  // on the same socket id — the peer's orb, position and mute state
  // live outside the pc, so nothing else moves. The fresh pc inherits
  // the exhausted budget (iceMachine.recreated) — this WAS the one
  // allowed recreate, so its next failure gives up instead of
  // recreating forever — and the recovering flag, so the UI keeps
  // showing the peer as down until the fresh pc actually connects.
  _recreatePeer(socketId) {
    const old = this.peers.get(socketId);
    if (!old) return;
    const wasRecovering = !!old.recovering;
    this._removePeer(socketId);
    this._createPeer(socketId);
    const peer = this.peers.get(socketId);
    if (peer) {
      peer.iceMachine.recreated = true;
      peer.recovering = true;
      if (!wasRecovering) this.onIceRecovery(socketId, 'recovering');
    }
    this._offerTo(socketId);
  }

  async _offerTo(socketId) {
    // Reuse the existing peer connection: a second offer on the same pc is
    // a renegotiation, while a fresh pc would orphan the first one's ICE.
    const pc = this.peers.get(socketId)?.pc || this._createPeer(socketId);
    const peer = this.peers.get(socketId);
    try {
      peer.makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('signal', { to: socketId, type: 'offer', data: offer });
      // No answer within the window: the peer may have missed the offer
      // (backgrounded tab, dropped packet). Re-offer once on the same pc.
      if (peer.retryTimer) clearTimeout(peer.retryTimer);
      peer.retryTimer = setTimeout(() => {
        peer.retryTimer = null;
        if (peer.pc.signalingState === 'have-local-offer' && peer.offerRetries < 1) {
          peer.offerRetries += 1;
          this._offerTo(socketId);
        }
      }, this.offerRetryMs);
    } catch (err) {
      console.warn('offer failed', err);
    } finally {
      peer.makingOffer = false;
    }
  }

  async _onRoomState({ occupants }) {
    // We are the joiner: offer to every occupant already in the room.
    // A colliding offer from the other side is resolved by perfect
    // negotiation in _onSignal, so offering unconditionally is safe.
    for (const occ of occupants || []) {
      this.occupants.add(occ.socketId);
      await this._offerTo(occ.socketId);
    }
  }

  async _onUserJoined({ socketId }) {
    // An existing occupant learns a newcomer joined: offer to them too.
    if (!socketId) return;
    this.occupants.add(socketId);
    await this._offerTo(socketId);
  }

  // ICE candidates that arrive before the remote description is set would
  // throw and be lost — queue them and flush once it exists.
  _addIceCandidate(socketId, data) {
    const peer = this.peers.get(socketId);
    if (!peer || !data) return;
    if (peer.pc.remoteDescription) {
      peer.pc.addIceCandidate(new RTCIceCandidate(data)).catch(() => {});
    } else {
      peer.pendingCandidates.push(data);
    }
  }

  _flushPendingCandidates(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer || !peer.pendingCandidates.length) return;
    const queued = peer.pendingCandidates.splice(0);
    for (const data of queued) {
      peer.pc.addIceCandidate(new RTCIceCandidate(data)).catch(() => {});
    }
  }

  async _onSignal({ from, type, data }) {
    // H1 defense-in-depth: ignore signaling from socket ids that are not
    // in the current room. The server relay already enforces this, but a
    // stray or malicious offer must never reach createPeer/answer here.
    // Legitimate senders are always known first: the server sends
    // room-state (occupants) to the joiner before any offer can arrive,
    // and user-joined to existing occupants before the newcomer offers.
    if (!this.occupants.has(from)) return;
    try {
      if (type === 'offer') {
        let peer = this.peers.get(from);
        if (!peer) {
          this._createPeer(from);
          peer = this.peers.get(from);
        }
        const pc = peer.pc;
        // Perfect negotiation: if we have a pending local offer and an
        // offer arrives at the same time, the polite side rolls back and
        // answers the incoming offer; the impolite side ignores it and
        // waits for its own offer to be answered. Either way exactly one
        // offer survives and the connection forms.
        const offerCollision = peer.makingOffer || pc.signalingState !== 'stable';
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;
        if (offerCollision) {
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        this._flushPendingCandidates(from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('signal', { to: from, type: 'answer', data: answer });
      } else if (type === 'answer') {
        const peer = this.peers.get(from);
        const pc = peer?.pc;
        if (pc) {
          if (peer.retryTimer) {
            clearTimeout(peer.retryTimer);
            peer.retryTimer = null;
          }
          await pc.setRemoteDescription(new RTCSessionDescription(data));
          this._flushPendingCandidates(from);
        }
      } else if (type === 'ice') {
        if (!this.peers.get(from)) this._createPeer(from);
        this._addIceCandidate(from, data);
      }
    } catch (err) {
      console.warn('signal handling failed', type, err);
    }
  }

  _onUserLeft({ socketId }) {
    this.occupants.delete(socketId);
    this.positions.delete(socketId);
    this._removePeer(socketId);
  }

  _removePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    if (peer.retryTimer) clearTimeout(peer.retryTimer);
    if (peer.iceTimer) { clearTimeout(peer.iceTimer); peer.iceTimer = null; }
    // Their share sender dies with the connection; the UI clears the
    // share layer for this peer (they left, or their share ended).
    this.shareSenders.delete(socketId);
    this.onShareEnded(socketId);
    try { peer.pc.close(); } catch {}
    // Tear down the proximity gain chain before dropping the element:
    // a live GainNode holding a dead element source leaks the graph.
    try { peer.elementSource?.disconnect(); } catch {}
    try { peer.gainNode?.disconnect(); } catch {}
    if (peer.audioEl) {
      peer.audioEl.srcObject = null;
      peer.audioEl.remove();
    }
    this.peers.delete(socketId);
  }

  // --- speaking detection ---

  _ensureAudioCtx() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
    return this.audioCtx;
  }

  _analyserFor(stream) {
    try {
      const ctx = this._ensureAudioCtx();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      return analyser;
    } catch {
      return null;
    }
  }

  _setupLocalAnalyser() {
    this.localAnalyser = this._analyserFor(this.localStream);
  }

  _rms(analyser, data) {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  _pollSpeaking() {
    const levels = {};
    let changed = false;
    const localRms = this.localAnalyser ? this._rms(this.localAnalyser, new Uint8Array(256)) : 0;
    const selfSpeaking = !this.muted && localRms > SPEAK_THRESHOLD;
    levels.self = Math.min(1, localRms * 6);
    if (selfSpeaking !== this._lastLevels.selfSpeaking) changed = true;
    this._lastLevels.selfSpeaking = selfSpeaking;

    for (const [id, peer] of this.peers) {
      const rms = peer.analyser ? this._rms(peer.analyser, peer.data) : 0;
      const speaking = rms > SPEAK_THRESHOLD;
      levels[id] = Math.min(1, rms * 6);
      if (speaking !== peer.speaking) {
        peer.speaking = speaking;
        changed = true;
      } else if (Math.abs((this._lastLevels[id] || 0) - levels[id]) > 0.2) {
        changed = true;
      }
      this._lastLevels[id] = levels[id];
    }

    if (changed) this.onSpeaking({ selfSpeaking, levels });
    // Let the server know our speaking state (drives the home screen).
    const speakingNow = selfSpeaking;
    if (speakingNow !== this._lastSentSpeaking) {
      this._lastSentSpeaking = speakingNow;
      this.socket.emit('speaking', { roomId: this.roomId, speaking: speakingNow });
    }
  }
}
