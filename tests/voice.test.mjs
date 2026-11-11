// Tests for the mesh voice engine's connection logic
// (frontend/src/voice.js): always-offer + perfect negotiation (the smaller
// socket id is polite and rolls back on a colliding offer), and the
// ICE-candidate queue that stops early candidates being dropped before the
// remote description exists. RTCPeerConnection is faked — these tests cover
// the engine's logic, not real network ICE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOfferer, VoiceEngine } from '../frontend/src/voice.js';

class FakePC {
  constructor() {
    this.signalingState = 'stable';
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
  async setLocalDescription(d) {
    if (d.type === 'rollback') {
      this.localDescription = null;
      this.signalingState = 'stable';
      return;
    }
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d) {
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
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

test('room-state: joiner offers to every occupant in the room', async () => {
  const engine = makeEngine('zzz');
  await engine._onRoomState({ occupants: [{ socketId: 'aaa' }, { socketId: 'mmm' }] });
  const offers = engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer');
  assert.equal(offers.length, 2);
  assert.deepEqual(offers.map(([, p]) => p.to).sort(), ['aaa', 'mmm']);
});

test('user-joined: existing occupant offers to the newcomer', async () => {
  const engine = makeEngine('aaa');
  await engine._onUserJoined({ socketId: 'zzz' });
  assert.equal(engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, 1);
});

// Two engines wired together through a fake signaling relay, both joining
// at the same moment — the exact case that used to kill both-way audio.
// Each offers; perfect negotiation must converge on exactly one surviving
// offer/answer exchange and leave both peers stable.
test('glare: two simultaneous joiners converge on one connection', async () => {
  const engineA = makeEngine('aaa'); // smaller id -> polite (rolls back)
  const engineB = makeEngine('zzz'); // larger id -> impolite (ignores collision)

  // Wire the mock sockets into a relay: a `signal` emit on one side is
  // delivered to the other side's _onSignal, like the server would.
  const pending = [];
  const link = (fromEngine, toEngine) => {
    fromEngine.socket.emit = (event, payload) => {
      fromEngine.socket.emitted.push([event, payload]);
      if (event === 'signal') {
        pending.push(toEngine._onSignal({ from: fromEngine.socket.id, ...payload }));
      }
    };
  };
  link(engineA, engineB);
  link(engineB, engineA);
  const drain = async () => {
    for (let i = 0; i < 10 && pending.length; i++) {
      await Promise.all(pending.splice(0));
      await new Promise((r) => setTimeout(r, 0));
    }
  };

  await Promise.all([
    engineA._onRoomState({ occupants: [{ socketId: 'zzz' }] }),
    engineB._onRoomState({ occupants: [{ socketId: 'aaa' }] })
  ]);
  await drain();

  const offersA = engineA.socket.emitted.filter(([, p]) => p.type === 'offer');
  const offersB = engineB.socket.emitted.filter(([, p]) => p.type === 'offer');
  assert.equal(offersA.length, 1);
  assert.equal(offersB.length, 1);

  // Exactly one answer: the polite side (A) answered B's offer.
  const answersA = engineA.socket.emitted.filter(([, p]) => p.type === 'answer');
  const answersB = engineB.socket.emitted.filter(([, p]) => p.type === 'answer');
  assert.equal(answersA.length, 1);
  assert.equal(answersB.length, 0);

  // Both peers end stable: B holds the answer to its offer, A holds B's offer.
  const peerA = engineA.peers.get('zzz');
  const peerB = engineB.peers.get('aaa');
  assert.equal(peerA.pc.signalingState, 'stable');
  assert.equal(peerB.pc.signalingState, 'stable');
  assert.equal(peerA.pc.remoteDescription.type, 'offer');
  assert.equal(peerB.pc.remoteDescription.type, 'answer');
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
