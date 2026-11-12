// Tests for the proximity-audio half of the voice engine
// (frontend/src/voice.js): each remote stream routes through a
// GainNode whose gain follows the distance curve, peers with no
// position data stay at full gain, the kill switch restores flat
// voice, and a failed gain chain falls back to conventional voice
// instead of silence. RTCPeerConnection / AudioContext / Audio are
// faked — these tests cover the engine's logic, not real audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceEngine } from '../frontend/src/voice.js';
import { SPATIAL_AUDIO_ENABLED } from '../frontend/src/proximity.js';

class FakePC {
  constructor() {
    this.signalingState = 'stable';
    this.remoteDescription = null;
    this.localDescription = null;
    this.addedCandidates = [];
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
  }
  addTrack() {}
  async createOffer() { return { type: 'offer', sdp: 'fake-offer' }; }
  async createAnswer() { return { type: 'answer', sdp: 'fake-answer' }; }
  async setLocalDescription(d) { this.localDescription = d; }
  async setRemoteDescription(d) { this.remoteDescription = d; }
  async addIceCandidate(c) { this.addedCandidates.push(c); }
  close() {}
}
globalThis.RTCPeerConnection = FakePC;
globalThis.RTCSessionDescription = class {
  constructor(d) { Object.assign(this, d); }
};
globalThis.RTCIceCandidate = class {
  constructor(d) { Object.assign(this, d); }
};
globalThis.Audio = class {
  constructor() { this.played = false; }
  play() { this.played = true; return Promise.resolve(); }
  remove() {}
};

class FakeGainNode {
  constructor(ctx) {
    this.context = ctx;
    this.gain = {
      value: 1,
      setTargetAtTime(v) { this.value = v; }
    };
    this.disconnectCalled = false;
    this.connectedTo = [];
  }
  connect(dest) { this.connectedTo.push(dest); }
  disconnect() { this.disconnectCalled = true; }
}

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.destination = {};
    this.currentTime = 0;
    this.gains = [];
    this.elementSources = [];
  }
  resume() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createMediaElementSource(el) {
    const src = { el, connect() {}, disconnect() {} };
    this.elementSources.push(src);
    return src;
  }
  createGain() {
    const g = new FakeGainNode(this);
    this.gains.push(g);
    return g;
  }
  createAnalyser() {
    return { fftSize: 0, getByteTimeDomainData() {} };
  }
}
globalThis.window = { AudioContext: FakeAudioContext };

function mockSocket(id) {
  const handlers = {};
  return {
    id,
    handlers,
    emitted: [],
    on(event, fn) { (handlers[event] ||= []).push(fn); },
    off(event, fn) { handlers[event] = (handlers[event] || []).filter((f) => f !== fn); },
    emit(event, payload) { this.emitted.push([event, payload]); }
  };
}

function makeEngine(socketId, opts = {}) {
  return new VoiceEngine({
    socket: mockSocket(socketId),
    roomId: 'room1',
    selfId: 'user1',
    onSpeaking: () => {},
    onMicError: () => {},
    onConnectionState: () => {},
    ...opts
  });
}

// Drive a peer's ontrack with a fake stream so the engine builds the
// <audio> element (and, when spatial audio is on, the gain chain).
function addPeerWithTrack(engine, socketId) {
  const pc = engine._createPeer(socketId);
  pc.ontrack({ streams: [{ id: 'stream-' + socketId }] });
  return engine.peers.get(socketId);
}

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('kill switch ships on', () => {
  assert.equal(SPATIAL_AUDIO_ENABLED, true);
});

test('ontrack routes the remote stream through a GainNode at full gain', () => {
  const engine = makeEngine('me');
  const peer = addPeerWithTrack(engine, 'peer1');
  assert.ok(peer.audioEl, 'audio element exists');
  assert.ok(peer.gainNode, 'gain node built');
  assert.equal(peer.gainNode.gain.value, 1, 'no positions yet: full gain');
  assert.equal(peer.gain, 1);
  // The element source feeds the gain node, which feeds the destination.
  assert.equal(peer.elementSource.el, peer.audioEl);
  assert.equal(peer.gainNode.connectedTo.length, 1);
  engine._removePeer('peer1');
});

test('gain follows distance: close is loud, far is quiet, floor holds', () => {
  const engine = makeEngine('me');
  const peer = addPeerWithTrack(engine, 'peer1');
  engine.setSelfPosition(50, 50);
  // Same spot: full volume.
  engine.updateRemotePosition('peer1', 50, 50);
  assert.equal(peer.gainNode.gain.value, 1);
  // 50% away: mid-falloff, ~0.67.
  engine.updateRemotePosition('peer1', 0, 50);
  assert.ok(approx(peer.gainNode.gain.value, 1 - (25 / 65) * 0.85));
  // 90% away: the 0.15 floor — quiet, never silent.
  engine.updateRemotePosition('peer1', 50, 140);
  assert.equal(peer.gainNode.gain.value, 0.15);
  // Further still: the floor holds.
  engine.updateRemotePosition('peer1', 150, 150);
  assert.equal(peer.gainNode.gain.value, 0.15);
  engine._removePeer('peer1');
});

test('a peer with no position data is heard at full gain', () => {
  const engine = makeEngine('me');
  const peer = addPeerWithTrack(engine, 'peer1');
  // I moved, they never sent orb-move (old client, or just joined):
  // they must sound exactly like before this feature existed.
  engine.setSelfPosition(10, 10);
  assert.equal(peer.gainNode.gain.value, 1);
  assert.equal(peer.gain, 1);
  // And with no position on my side either, a positioned peer is full.
  engine.updateRemotePosition('peer1', 90, 90);
  const engine2 = makeEngine('me2');
  const peer2 = addPeerWithTrack(engine2, 'peer1');
  engine2.updateRemotePosition('peer1', 90, 90);
  assert.equal(peer2.gainNode.gain.value, 1, 'no self position: full gain');
  engine._removePeer('peer1');
  engine2._removePeer('peer1');
});

test('gain hysteresis: a small drift does not flicker the volume', () => {
  const engine = makeEngine('me');
  const peer = addPeerWithTrack(engine, 'peer1');
  engine.setSelfPosition(50, 50);
  engine.updateRemotePosition('peer1', 0, 50); // ~0.673
  const held = peer.gainNode.gain.value;
  engine.updateRemotePosition('peer1', 2, 50); // ~0.647, within 0.05
  assert.equal(peer.gainNode.gain.value, held, 'tiny move keeps the old gain');
  engine.updateRemotePosition('peer1', 50, 150); // 100 away: the floor
  assert.equal(peer.gainNode.gain.value, 0.15);
  engine._removePeer('peer1');
});

test('setSpatialEnabled(false) restores flat voice; re-enabling restores distance gain', () => {
  const engine = makeEngine('me');
  const peer = addPeerWithTrack(engine, 'peer1');
  engine.setSelfPosition(50, 50);
  engine.updateRemotePosition('peer1', 50, 140); // floor
  assert.equal(peer.gainNode.gain.value, 0.15);
  engine.setSpatialEnabled(false); // the kill switch at runtime
  assert.equal(peer.gainNode.gain.value, 1);
  assert.equal(peer.gain, 1);
  engine.setSpatialEnabled(true);
  assert.equal(peer.gainNode.gain.value, 0.15);
  engine._removePeer('peer1');
});

test('spatialEnabled:false at construction builds no gain chain', () => {
  const engine = makeEngine('me', { spatialEnabled: false });
  const peer = addPeerWithTrack(engine, 'peer1');
  assert.equal(peer.gainNode, null);
  assert.ok(peer.audioEl, 'the element still plays flat');
  engine.setSelfPosition(50, 50);
  engine.updateRemotePosition('peer1', 50, 140);
  assert.equal(peer.gain, 1);
  engine._removePeer('peer1');
});

test('a failed gain chain falls back to flat voice, never silence', () => {
  const origCtx = globalThis.window.AudioContext;
  class ThrowingCtx extends FakeAudioContext {
    createMediaElementSource() { throw new Error('no element source'); }
  }
  globalThis.window.AudioContext = ThrowingCtx;
  try {
    const engine = makeEngine('me');
    const peer = addPeerWithTrack(engine, 'peer1');
    // The element exists and plays directly — the failure only means
    // no distance gain, not no audio.
    assert.ok(peer.audioEl);
    assert.equal(peer.gainNode, null);
    assert.equal(engine.spatialFailed, true);
    assert.equal(peer.gain, 1);
    // The failure is sticky: a second peer is flat too, not half-built.
    const peer2 = addPeerWithTrack(engine, 'peer2');
    assert.equal(peer2.gainNode, null);
    assert.ok(peer2.audioEl);
    engine._removePeer('peer1');
    engine._removePeer('peer2');
  } finally {
    globalThis.window.AudioContext = origCtx;
  }
});

test('leaving removes positions and disconnects the gain chain', () => {
  const engine = makeEngine('me');
  const peer = addPeerWithTrack(engine, 'peer1');
  engine.setSelfPosition(50, 50);
  engine.updateRemotePosition('peer1', 0, 50);
  assert.equal(engine.positions.size, 1);
  engine._onUserLeft({ socketId: 'peer1' });
  assert.equal(engine.positions.size, 0, 'position forgotten with the peer');
  assert.equal(engine.peers.has('peer1'), false);
  assert.equal(peer.gainNode.disconnectCalled, true, 'gain node disconnected');
});

test('updateRemotePosition ignores non-finite coordinates', () => {
  const engine = makeEngine('me');
  addPeerWithTrack(engine, 'peer1');
  engine.updateRemotePosition('peer1', NaN, 50);
  engine.updateRemotePosition('peer1', 50, Infinity);
  assert.equal(engine.positions.size, 0);
  engine._removePeer('peer1');
});
