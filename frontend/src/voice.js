// Mesh WebRTC voice engine — the only module that knows about
// RTCPeerConnection. The UI talks to it through join/leave/setMuted/
// setDeafened and the onSpeaking callback, so swapping in an SFU client
// (LiveKit) later means replacing this file, not the room UI.
//
// Signaling rides on socket.io (server: lib/socket.js):
//   - exactly ONE side offers per pair (see isOfferer): the side with the
//     larger socket id. The joiner offers to smaller-id occupants from
//     `room-state`; existing occupants offer to a larger-id newcomer on
//     `user-joined`. Both sides compute the same answer, so it holds
//     regardless of join order — two people joining at the same moment can
//     never both offer (glare) and kill the connection.
//   - offers/answers/ICE relay through `signal` { to, type, data }
//   - ICE candidates arriving before the remote description is set are
//     queued and flushed after setRemoteDescription, never dropped.
//   - Google STUN + free OpenRelay TURN (only used when a direct
//     peer-to-peer path fails, e.g. both phones on mobile networks behind
//     symmetric NAT). Media stays DTLS-SRTP encrypted end to end; a TURN
//     relay only forwards opaque packets and cannot decrypt them.

const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302'] },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];
const SPEAK_THRESHOLD = 0.02; // RMS of time-domain audio samples
const SPEAK_POLL_MS = 150;

// Deterministic offerer rule: for any pair, exactly one side offers —
// the one with the larger socket id. Both sides compute the same result,
// so simultaneous joins can never glare.
export function isOfferer(mySocketId, otherSocketId) {
  if (!mySocketId || !otherSocketId) return true;
  return mySocketId > otherSocketId;
}

export class VoiceEngine {
  constructor({ socket, roomId, selfId, onSpeaking, onMicError, onConnectionState }) {
    this.socket = socket;
    this.roomId = roomId;
    this.selfId = selfId;
    this.onSpeaking = onSpeaking || (() => {});
    this.onMicError = onMicError || (() => {});
    this.onConnectionState = onConnectionState || (() => {});
    this.peers = new Map(); // socketId -> { pc, audioEl, analyser, data, speaking, pendingCandidates }
    this.localStream = null;
    this.localAnalyser = null;
    this.audioCtx = null;
    this.muted = false;
    this.deafened = false;
    this.micFailed = false;
    this.joined = false;
    this._pollTimer = null;
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

    this.socket.emit('join-room', { roomId: this.roomId });
    this._pollTimer = setInterval(() => this._pollSpeaking(), SPEAK_POLL_MS);
  }

  leave() {
    this.joined = false;
    clearInterval(this._pollTimer);
    this.socket.off('signal', this._onSignal);
    this.socket.off('user-left', this._onUserLeft);
    this.socket.off('room-state', this._onRoomState);
    this.socket.off('user-joined', this._onUserJoined);
    this.socket.emit('leave-room', { roomId: this.roomId });
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

  // --- peer connections ---

  _createPeer(socketId) {
    const existing = this.peers.get(socketId);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('signal', { to: socketId, type: 'ice', data: e.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      this.onConnectionState(socketId, pc.connectionState);
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      const audioEl = new Audio();
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = this.deafened;
      audioEl.srcObject = stream;
      audioEl.play().catch(() => {});
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
      pendingCandidates: existing ? existing.pendingCandidates : []
    });
    return pc;
  }

  async _offerTo(socketId) {
    try {
      const pc = this._createPeer(socketId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('signal', { to: socketId, type: 'offer', data: offer });
    } catch (err) {
      console.warn('offer failed', err);
    }
  }

  async _onRoomState({ occupants }) {
    // We are the joiner: offer only to occupants we are the offerer for.
    // The other side offers to us on `user-joined` when the rule says so.
    const myId = this.socket.id;
    for (const occ of occupants || []) {
      if (isOfferer(myId, occ.socketId)) await this._offerTo(occ.socketId);
    }
  }

  async _onUserJoined({ socketId }) {
    // An existing occupant learns a newcomer joined: offer only when the
    // rule makes us the offerer for this pair.
    if (socketId && isOfferer(this.socket.id, socketId)) await this._offerTo(socketId);
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
    try {
      if (type === 'offer') {
        const pc = this.peers.get(from)?.pc || this._createPeer(from);
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        this._flushPendingCandidates(from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('signal', { to: from, type: 'answer', data: answer });
      } else if (type === 'answer') {
        const pc = this.peers.get(from)?.pc;
        if (pc) {
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
    this._removePeer(socketId);
  }

  _removePeer(socketId) {
    const peer = this.peers.get(socketId);
    if (!peer) return;
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
