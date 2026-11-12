// Tests for the voice engine's screen-sharing track plumbing
// (frontend/src/voice.js, v0.8.0): getDisplayMedia capture, addTrack
// to every peer connection (and to late joiners), removeTrack +
// renegotiation on stop, the browser-stop callback, and the video /
// audio split in ontrack. RTCPeerConnection is faked — these tests
// cover the engine's logic, not real network ICE. (Harness mirrors
// tests/voice.test.mjs.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceEngine } from '../frontend/src/voice.js';

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
    this.addedTracks = []; // { track, stream }
    this.removedSenders = [];
  }
  addTrack(track, stream) {
    const sender = { track };
    this.addedTracks.push({ track, stream });
    return sender;
  }
  removeTrack(sender) { this.removedSenders.push(sender); }
  getSenders() { return this.addedTracks.map(({ track }) => ({ track })); }
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
globalThis.MediaStream = class {
  constructor(tracks = []) { this.tracks = tracks; }
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

// A fake getDisplayMedia capture: one video track with listener
// support, so tests can fire the browser-stop 'ended' event.
function makeDisplayStream() {
  const listeners = {};
  const track = {
    kind: 'video',
    stopped: false,
    stop() { this.stopped = true; },
    addEventListener(event, fn) { (listeners[event] ||= []).push(fn); },
    removeEventListener(event, fn) {
      listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
    },
    fire(event) { (listeners[event] || []).forEach((fn) => fn()); }
  };
  return {
    track,
    getVideoTracks: () => [track],
    getTracks: () => [track]
  };
}

const audioTrack = { kind: 'audio', stop() {} };

// Node's global navigator is getter-only — override it via
// defineProperty (configurable, so afterEach can remove it).
function setNavigator(mediaDevices) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { mediaDevices },
    configurable: true
  });
}

function makeEngine(opts = {}) {
  const socket = mockSocket('self-sock');
  const engine = new VoiceEngine({
    socket,
    roomId: 'room1',
    selfId: 'user1',
    onSpeaking: () => {},
    onMicError: () => {},
    onConnectionState: () => {},
    offerRetryMs: 10, // re-offer timers must not hold the test process open
    ...opts
  });
  return { engine, socket };
}

afterEach(() => {
  delete globalThis.navigator;
});

test('startScreenShare adds the video track to every peer and renegotiates', async () => {
  const display = makeDisplayStream();
  setNavigator({ getDisplayMedia: async () => display });
  const { engine, socket } = makeEngine();
  // A mic track is already live: the audio path must be untouched.
  engine.localStream = { getTracks: () => [audioTrack] };
  engine._createPeer('p1');
  engine._createPeer('p2');
  const res = await engine.startScreenShare();
  assert.deepEqual(res, { ok: true });
  for (const id of ['p1', 'p2']) {
    const pc = engine.peers.get(id).pc;
    assert.equal(pc.addedTracks.filter((t) => t.track.kind === 'video').length, 1);
    assert.equal(pc.addedTracks.filter((t) => t.track.kind === 'audio').length, 1);
    assert.equal(pc.addedTracks.find((t) => t.track.kind === 'video').stream, display);
  }
  // Renegotiation: one offer per peer over the existing signal path.
  const offers = socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer');
  assert.equal(offers.length, 2);
  engine.leave();
});

test('stopScreenShare removes only the video sender, renegotiates, stops the capture', async () => {
  const display = makeDisplayStream();
  setNavigator({ getDisplayMedia: async () => display });
  const { engine, socket } = makeEngine();
  engine.localStream = { getTracks: () => [audioTrack] };
  engine._createPeer('p1');
  await engine.startScreenShare();
  const pc = engine.peers.get('p1').pc;
  const videoSender = pc.addedTracks.find((t) => t.track.kind === 'video');
  assert.ok(videoSender);
  socket.emitted.length = 0;
  await engine.stopScreenShare();
  assert.equal(pc.removedSenders.length, 1);
  assert.equal(pc.removedSenders[0].track, display.track);
  // The audio sender was never removed.
  assert.equal(pc.addedTracks.filter((t) => t.track.kind === 'audio').length, 1);
  assert.equal(display.track.stopped, true);
  assert.equal(engine.shareStream, null);
  // Renegotiation: the removal is offered to the peer.
  const offers = socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer');
  assert.equal(offers.length, 1);
  engine.leave();
});

test('stopScreenShare when not sharing is a no-op', async () => {
  setNavigator({ getDisplayMedia: async () => makeDisplayStream() });
  const { engine, socket } = makeEngine();
  engine._createPeer('p1');
  await engine.stopScreenShare();
  assert.equal(socket.emitted.length, 0);
  engine.leave();
});

test('startScreenShare fails cleanly without getDisplayMedia', async () => {
  setNavigator({});
  const { engine } = makeEngine();
  engine._createPeer('p1');
  const res = await engine.startScreenShare();
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Screen sharing is not supported in this browser.');
  assert.equal(engine.shareStream, null);
  engine.leave();
});

test('startScreenShare reports a cancelled picker instead of throwing', async () => {
  const err = new Error('denied');
  err.name = 'NotAllowedError';
  setNavigator({ getDisplayMedia: async () => { throw err; } });
  const { engine } = makeEngine();
  const res = await engine.startScreenShare();
  assert.equal(res.ok, false);
  assert.equal(res.error, 'Screen share was cancelled.');
  engine.leave();
});

test('a peer created after sharing started gets the video track at once', async () => {
  const display = makeDisplayStream();
  setNavigator({ getDisplayMedia: async () => display });
  const { engine } = makeEngine();
  await engine.startScreenShare();
  engine._createPeer('late-joiner');
  const pc = engine.peers.get('late-joiner').pc;
  assert.equal(pc.addedTracks.filter((t) => t.track.kind === 'video').length, 1);
  engine.leave();
});

test('the browser stop button reports via onLocalShareEnded', async () => {
  const display = makeDisplayStream();
  setNavigator({ getDisplayMedia: async () => display });
  let ended = 0;
  const { engine } = makeEngine({ onLocalShareEnded: () => { ended += 1; } });
  await engine.startScreenShare();
  display.track.fire('ended');
  assert.equal(ended, 1);
  // The engine does not tear down itself — RoomView owns the stop
  // path — so the stream is still live until stopScreenShare runs.
  assert.ok(engine.shareStream);
  await engine.stopScreenShare();
  assert.equal(display.track.stopped, true);
  engine.leave();
});

test('ontrack splits video from audio: video goes to onShareTrack, never to an <audio> element', async () => {
  const seen = [];
  const { engine } = makeEngine({ onShareTrack: (socketId, stream) => seen.push([socketId, stream]) });
  engine._createPeer('p1');
  const pc = engine.peers.get('p1').pc;
  const videoStream = { id: 'remote-screen' };
  const videoTrack = {
    kind: 'video',
    addEventListener() {}
  };
  pc.ontrack({ track: videoTrack, streams: [videoStream] });
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0], 'p1');
  assert.equal(seen[0][1], videoStream);
  // No audio element was built for the video track.
  assert.equal(engine.peers.get('p1').audioEl, null);
  engine.leave();
});

test('a remote share ending clears via onShareEnded', async () => {
  const ended = [];
  const { engine } = makeEngine({ onShareEnded: (socketId) => ended.push(socketId) });
  engine._createPeer('p1');
  const pc = engine.peers.get('p1').pc;
  let endedFn = null;
  pc.ontrack({
    track: { kind: 'video', addEventListener: (event, fn) => { endedFn = fn; } },
    streams: [{ id: 'remote-screen' }]
  });
  assert.equal(typeof endedFn, 'function');
  endedFn();
  assert.deepEqual(ended, ['p1']);
  engine.leave();
});

test('leave() stops the capture so no share outlives the room', async () => {
  const display = makeDisplayStream();
  setNavigator({ getDisplayMedia: async () => display });
  const { engine } = makeEngine();
  engine._createPeer('p1');
  await engine.startScreenShare();
  assert.ok(engine.shareStream);
  engine.leave();
  assert.equal(display.track.stopped, true);
  assert.equal(engine.shareStream, null);
});
