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
  constructor({ socket, roomId, selfId, onSpeaking, onMicError, onConnectionState, onPlaybackBlocked, offerRetryMs }) {
    this.socket = socket;
    this.roomId = roomId;
    this.selfId = selfId;
    this.onSpeaking = onSpeaking || (() => {});
    this.onMicError = onMicError || (() => {});
    this.onConnectionState = onConnectionState || (() => {});
    this.onPlaybackBlocked = onPlaybackBlocked || (() => {});
    // If an offer goes unanswered (peer missed it, was backgrounded, ...),
    // re-offer once after this delay instead of staying silent forever.
    this.offerRetryMs = offerRetryMs ?? 5000;
    this.peers = new Map(); // socketId -> { pc, audioEl, analyser, data, speaking, pendingCandidates, polite, makingOffer, ignoreOffer, offerRetries, retryTimer }
    // Socket ids known to be in the current room (from room-state and
    // user-joined). Defense-in-depth for audit H1: _onSignal ignores
    // anything from a socket id not in this set, so even if the server
    // relay ever forwarded a stray offer, the client will not answer it.
    this.occupants = new Set();
    this.localStream = null;
    this.localAnalyser = null;
    this.audioCtx = null;
    this.muted = false;
    this.deafened = false;
    this.micFailed = false;
    this.joined = false;
    this._pollTimer = null;
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
    };
    pc.ontrack = (e) => {
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
      candidateTypes: new Set()
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
    this._removePeer(socketId);
  }

  _removePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
    if (peer.retryTimer) clearTimeout(peer.retryTimer);
    try { peer.pc.close(); } catch {}
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
