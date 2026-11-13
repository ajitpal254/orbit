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
    this.iceConnectionState = 'new';
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
    this.restartIceCalls = 0;
    this.closed = false;
  }
  restartIce() { this.restartIceCalls += 1; }
  close() { this.closed = true; }
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
  // The sender must be a known occupant (H1 defense): seed it the way
  // room-state would, without offering — the candidate flow is what
  // this test is about.
  engine.occupants.add('peer1');
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

test('_onSignal ignores offers and ICE from socket ids not in the room', async () => {
  const engine = makeEngine('me');
  // A stranger's offer must not create a peer or trigger an answer —
  // this is the client half of the H1 fix (the server relay is the
  // real gate; this stops a stray offer being auto-answered).
  await engine._onSignal({ from: 'stranger', type: 'offer', data: { type: 'offer', sdp: 'x' } });
  assert.equal(engine.peers.has('stranger'), false);
  assert.equal(engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'answer').length, 0);
  // A stranger's ICE must not create a peer either.
  await engine._onSignal({ from: 'stranger', type: 'ice', data: { candidate: 'c1' } });
  assert.equal(engine.peers.has('stranger'), false);
  // Once the sender is a known occupant, its ICE is accepted.
  engine.occupants.add('friend');
  await engine._onSignal({ from: 'friend', type: 'ice', data: { candidate: 'c1' } });
  assert.ok(engine.peers.get('friend'));
  assert.equal(engine.peers.get('friend').pendingCandidates.length, 1);
  engine._removePeer('friend');
});

test('room-state seeds the known occupants; user-left removes them', async () => {
  const engine = makeEngine('me');
  await engine._onRoomState({ occupants: [{ socketId: 'aaa' }] });
  assert.ok(engine.occupants.has('aaa'));
  // A signal from a seeded occupant is accepted...
  await engine._onSignal({ from: 'aaa', type: 'ice', data: { candidate: 'c1' } });
  assert.ok(engine.peers.get('aaa'));
  // ...but after they leave, their signals are ignored.
  engine._onUserLeft({ socketId: 'aaa' });
  assert.equal(engine.occupants.has('aaa'), false);
  await engine._onSignal({ from: 'aaa', type: 'offer', data: { type: 'offer', sdp: 'x' } });
  assert.equal(engine.peers.has('aaa'), false);
  assert.equal(engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'answer').length, 0);
});

test('_offerTo reuses the same peer connection instead of orphaning one', async () => {
  const engine = makeEngine('me');
  await engine._offerTo('peer1');
  const pc1 = engine.peers.get('peer1').pc;
  await engine._offerTo('peer1');
  assert.equal(engine.peers.get('peer1').pc, pc1);
  assert.equal(engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, 2);
});

test('unanswered offer is re-offered once after the retry delay', async () => {
  const engine = makeEngine('me', { offerRetryMs: 10 });
  await engine._offerTo('peer1');
  assert.equal(engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, 1);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, 2);
  // No third offer: only one retry.
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, 2);
  engine._removePeer('peer1');
});

test('answered offer is never retried', async () => {
  const engine = makeEngine('me', { offerRetryMs: 10 });
  engine.occupants.add('peer1'); // known occupant, so its answer is accepted
  await engine._offerTo('peer1');
  await engine._onSignal({ from: 'peer1', type: 'answer', data: { type: 'answer', sdp: 'y' } });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(engine.socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, 1);
  engine._removePeer('peer1');
});

test('candidate types are reported as they are gathered', async () => {
  const seen = [];
  const engine = makeEngine('me', {
    onConnectionState: (socketId, conn, ice, candidates) =>
      seen.push([socketId, conn, ice, candidates])
  });
  await engine._offerTo('peer1');
  const peer = engine.peers.get('peer1');
  // Simulate ICE gathering: host, then srflx, then relay (TURN).
  peer.pc.onicecandidate({ candidate: { type: 'host' } });
  peer.pc.onicecandidate({ candidate: { type: 'srflx' } });
  peer.pc.onicecandidate({ candidate: { type: 'relay' } });
  assert.ok(seen.length >= 3);
  assert.equal(seen[seen.length - 1][3], 'host+srflx+relay');
  engine._removePeer('peer1');
});

test('retryPlayback plays every remote audio element and reports success', async () => {
  const engine = makeEngine('me');
  engine._createPeer('p1');
  engine._createPeer('p2');
  let played = 0;
  for (const id of ['p1', 'p2']) {
    engine.peers.get(id).audioEl = { play: async () => { played += 1; }, remove: () => {} };
  }
  assert.equal(await engine.retryPlayback(), true);
  assert.equal(played, 2);

  engine.peers.get('p2').audioEl = { play: async () => { throw new Error('blocked'); }, remove: () => {} };
  assert.equal(await engine.retryPlayback(), false);
  engine._removePeer('p1');
  engine._removePeer('p2');
});

test('join loads account TURN from /api/config into iceServers', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/config');
    return {
      json: async () => ({
        turn: { urls: ['turn:standard.relay.metered.ca:80'], username: 'u1', credential: 'p1' }
      })
    };
  };
  try {
    const engine = makeEngine('me');
    await engine.join(); // no navigator in node → micFailed, listen-only
    assert.ok(engine.micFailed);
    assert.ok(engine.iceServers.some((s) => s.username === 'u1'));
    assert.ok(engine.iceServers.some((s) => String(s.urls).includes('staticauth.openrelay.metered.ca')));
    assert.ok(engine.iceServers.some((s) => JSON.stringify(s.urls).includes('stun.l.google.com')));
    engine.leave();
  } finally {
    globalThis.fetch = origFetch;
  }
});

// --- ICE recovery (v0.9.0) ---
//
// The engine drives the iceRecovery machine (frontend/src/
// iceRecovery.js) from pc.oniceconnectionstatechange. Short grace /
// restart timeouts here (constructor options, same pattern as
// offerRetryMs) so the tests run in milliseconds, not seconds.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a timer-driven condition instead of sleeping a fixed
// amount and hoping the timer fired in time: on a loaded CI runner
// a 20ms grace + 40ms sleep leaves almost no slack (the v0.9.0
// merge run failed exactly here — restartIceCalls was still 0).
async function waitFor(cond, message) {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > 2000) assert.fail(`timed out waiting: ${message}`);
    await sleep(5);
  }
}

function makeRecoveryEngine(phases, opts = {}) {
  return makeEngine('me', {
    iceGraceMs: 20,
    iceRestartTimeoutMs: 50,
    onIceRecovery: (socketId, phase) => phases.push([socketId, phase]),
    ...opts
  });
}

async function peerWithOffer(engine, socketId) {
  await engine._onRoomState({ occupants: [{ socketId }] });
  const peer = engine.peers.get(socketId);
  assert.ok(peer, 'peer must exist after room-state offer');
  return peer;
}

function setIce(peer, state) {
  peer.pc.iceConnectionState = state;
  peer.pc.oniceconnectionstatechange();
}

test('ICE disconnected: grace, then restartIce; recovery clears on connected', async () => {
  const phases = [];
  const engine = makeRecoveryEngine(phases);
  const peer = await peerWithOffer(engine, 'peer1');
  setIce(peer, 'connected');
  setIce(peer, 'disconnected');
  assert.equal(peer.pc.restartIceCalls, 0, 'no restart inside the grace');
  assert.deepEqual(phases, [['peer1', 'recovering']]);
  await waitFor(() => peer.pc.restartIceCalls === 1, 'restartIce fires once the grace elapses');
  // Still disconnected after the restart: the restart timeout is
  // armed, but recovery must clear as soon as ICE comes back.
  setIce(peer, 'connected');
  assert.deepEqual(phases, [['peer1', 'recovering'], ['peer1', 'recovered']]);
  assert.equal(peer.pc.restartIceCalls, 1, 'no second restart after recovery');
  engine.leave();
});

test('ICE failed: peer recreated once, then dropped on the second failure', async () => {
  const phases = [];
  const engine = makeRecoveryEngine(phases);
  const peer = await peerWithOffer(engine, 'peer1');
  const offersBefore = engine.socket.emitted.filter(([, p]) => p.type === 'offer').length;
  setIce(peer, 'failed');
  await sleep(10);
  // Old pc closed, fresh pc in its place, fresh offer sent.
  assert.equal(peer.pc.closed, true, 'the dead pc is closed');
  const recreated = engine.peers.get('peer1');
  assert.ok(recreated, 'the peer record survives the recreate');
  assert.notEqual(recreated.pc, peer.pc, 'a new pc is negotiated');
  assert.equal(
    engine.socket.emitted.filter(([, p]) => p.type === 'offer').length,
    offersBefore + 1,
    'the recreate re-offers on the same socket id'
  );
  assert.deepEqual(phases, [['peer1', 'recovering']], 'the recreate is reported as recovering — the fresh pc has not connected yet');
  // The fresh pc fails too: now the peer is given up on.
  setIce(recreated, 'failed');
  assert.equal(engine.peers.get('peer1'), undefined, 'peer dropped after the second failure');
  assert.equal(recreated.pc.closed, true);
  assert.deepEqual(phases, [['peer1', 'recovering'], ['peer1', 'failed']]);
  engine.leave();
});

test('ICE restart that never recovers recreates the peer', async () => {
  const phases = [];
  const engine = makeRecoveryEngine(phases);
  const peer = await peerWithOffer(engine, 'peer1');
  setIce(peer, 'disconnected');
  await waitFor(() => peer.pc.restartIceCalls === 1, 'restartIce fires once the grace elapses');
  assert.deepEqual(phases, [['peer1', 'recovering']]);
  // Still disconnected past the restart timeout: full reconnect.
  await waitFor(() => peer.pc.closed === true, 'the unrecovered pc is closed');
  const recreated = engine.peers.get('peer1');
  assert.ok(recreated);
  assert.notEqual(recreated.pc, peer.pc);
  assert.deepEqual(phases, [['peer1', 'recovering']], 'still recovering — the new pc has not connected yet');
  // The fresh pc connects: recovery clears.
  setIce(recreated, 'connected');
  assert.deepEqual(phases, [['peer1', 'recovering'], ['peer1', 'recovered']]);
  engine.leave();
});

test('ICE recovery timers die with the peer and on leave', async () => {
  const phases = [];
  const engine = makeRecoveryEngine(phases);
  const peer = await peerWithOffer(engine, 'peer1');
  setIce(peer, 'disconnected');
  assert.ok(peer.iceTimer, 'grace timer armed');
  engine._removePeer('peer1');
  assert.equal(peer.iceTimer, null, 'removing the peer clears its timer');
  const peer2 = await peerWithOffer(engine, 'peer2');
  setIce(peer2, 'disconnected');
  engine.leave();
  assert.equal(peer2.iceTimer, null, 'leave clears every peer timer');
  assert.deepEqual(phases, [['peer1', 'recovering'], ['peer2', 'recovering']]);
});
