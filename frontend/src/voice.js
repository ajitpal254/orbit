// Mesh WebRTC voice engine — the only module that knows about
// RTCPeerConnection. The UI talks to it through join/leave/setMuted/
// setDeafened and the onSpeaking callback, so swapping in an SFU client
// (LiveKit) later means replacing this file, not the room UI.
//
// Signaling rides on socket.io (server: lib/socket.js):
//   - the JOINER offers to every existing occupant (from `room-state`)
//   - offers/answers/ICE relay through `signal` { to, type, data }
//   - Google STUN only — no TURN, no paid service. Works for small friend
//     groups (2–6 people); strict symmetric NATs may fail to connect.

const STUN_URLS = ['stun:stun.l.google.com:19302'];
const SPEAK_THRESHOLD = 0.02; // RMS of time-domain audio samples
const SPEAK_POLL_MS = 150;

export class VoiceEngine {
  constructor({ socket, roomId, selfId, onSpeaking, onMicError }) {
    this.socket = socket;
    this.roomId = roomId;
    this.selfId = selfId;
    this.onSpeaking = onSpeaking || (() => {});
    this.onMicError = onMicError || (() => {});
    this.peers = new Map(); // socketId -> { pc, audioEl, analyser, data, speaking }
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
  }

  async join() {
    if (this.joined) return;
    this.joined = true;
    this.socket.on('signal', this._onSignal);
    this.socket.on('user-left', this._onUserLeft);
    this.socket.on('room-state', this._onRoomState);

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
    const pc = new RTCPeerConnection({ iceServers: [{ urls: STUN_URLS }] });
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => pc.addTrack(t, this.localStream));
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        this.socket.emit('signal', { to: socketId, type: 'ice', data: e.candidate });
      }
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
    this.peers.set(socketId, { pc, audioEl: null, analyser: null, data: new Uint8Array(256), speaking: false });
    return pc;
  }

  async _onRoomState({ occupants }) {
    // We are the joiner: offer to every occupant already in the room.
    for (const occ of occupants || []) {
      try {
        const pc = this._createPeer(occ.socketId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('signal', { to: occ.socketId, type: 'offer', data: offer });
      } catch (err) {
        console.warn('offer failed', err);
      }
    }
  }

  async _onSignal({ from, type, data }) {
    try {
      if (type === 'offer') {
        const pc = this.peers.get(from)?.pc || this._createPeer(from);
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.socket.emit('signal', { to: from, type: 'answer', data: answer });
      } else if (type === 'answer') {
        const pc = this.peers.get(from)?.pc;
        if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (type === 'ice') {
        const pc = this.peers.get(from)?.pc;
        if (pc && data) await pc.addIceCandidate(new RTCIceCandidate(data)).catch(() => {});
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
