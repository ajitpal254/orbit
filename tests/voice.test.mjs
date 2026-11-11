// Tests for the mesh voice engine's connection logic
// (frontend/src/voice.js): the deterministic offerer rule that prevents
// glare when two people join at the same moment, and the ICE-candidate
// queue that stops early candidates being dropped before the remote
// description exists. RTCPeerConnection is faked — these tests cover the
// engine's logic, not real network ICE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOfferer, VoiceEngine } from '../frontend/src/voice.js';

class FakePC {
  constructor() {
    this.remoteDescription = null;
    this.localDescription = null;
    this.addedCandidates = [];
    this.connectionState = 'new';
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
  play() { return Promise.resolve(); }
  remove() {}
};

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

function makeEngine(socketId) {
  return new VoiceEngine({
    socket: mockSocket(socketId),
    roomId: 'room1',
    selfId: 'user1',
    onSpeaking: () => {},
    onMicError: () => {},
    onConnectionState: () => {}
  });
}

test('isOfferer: exactly one side of a pair offers', () => {
  assert.equal(isOfferer('socket-b', 'socket-a'), true);
  assert.equal(isOfferer('socket-a', 'socket-b'), false);
  assert.equal(isOfferer('zzz', 'aaa'), true);
  assert.equal(isOfferer('aaa', 'zzz'), false);
  // Same id never happens for two peers, but the rule stays total.
  assert.equal(isOfferer('same', 'same'), false);
});

test('isOfferer: missing socket id falls back to offering', () => {
  assert.equal(isOfferer(null, 'peer'), true);
  assert.equal(isOfferer('me', null), true);
  assert.equal(isOfferer(undefined, undefined), true);
});

test('room-state: joiner offers only to occupants it is the offerer for', async () => {
  const big = makeEngine('zzz');
  await big._onRoomState({ occupants: [{ socketId: 'aaa' }, { socketId: 'mmm' }] });
  const offers = big.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer');
  assert.equal(offers.length, 2);
  assert.deepEqual(offers.map(([, p]) => p.to).sort(), ['aaa', 'mmm']);

  const small = makeEngine('aaa');
  await small._onRoomState({ occupants: [{ socketId: 'mmm' }, { socketId: 'zzz' }] });
  const noOffers = small.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer');
  assert.equal(noOffers.length, 0);
});

test('user-joined: existing occupant offers only when it is the offerer', async () => {
  const big = makeEngine('zzz');
  await big._onUserJoined({ socketId: 'aaa' });
  assert.equal(big.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, 1);

  const small = makeEngine('aaa');
  await small._onUserJoined({ socketId: 'zzz' });
  assert.equal(small.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, 0);
});

test('ICE candidates arriving before the remote description are queued, then flushed', async () => {
  const engine = makeEngine('me');
  // Candidate first: no remote description yet, so it must be queued, not lost.
  await engine._onSignal({ from: 'peer1', type: 'ice', data: { candidate: 'c1' } });
  const peer = engine.peers.get('peer1');
  assert.ok(peer);
  assert.equal(peer.pc.addedCandidates.length, 0);
  assert.equal(peer.pendingCandidates.length, 1);

  // Offer arrives: remote description is set and the queued candidate flushes.
  await engine._onSignal({ from: 'peer1', type: 'offer', data: { type: 'offer', sdp: 'x' } });
  assert.ok(peer.pc.remoteDescription);
  assert.equal(peer.pc.addedCandidates.length, 1);
  assert.equal(peer.pendingCandidates.length, 0);
  // An answer was sent back to the offerer.
  const answers = engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'answer');
  assert.equal(answers.length, 1);
  assert.equal(answers[0][1].to, 'peer1');

  // Later candidates go straight in now that the remote description exists.
  await engine._onSignal({ from: 'peer1', type: 'ice', data: { candidate: 'c2' } });
  assert.equal(peer.pc.addedCandidates.length, 2);
  assert.equal(peer.pendingCandidates.length, 0);
});
