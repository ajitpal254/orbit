// Tests for the voice engine's music-bot track plumbing
// (frontend/src/voice.js, v0.10.0): captureStream capture, addTrack
// to every peer connection (and to late joiners), removeTrack +
// renegotiation on stop, the first/second audio split in ontrack, and
// the listener-side music volume/mute. RTCPeerConnection is faked —
// these tests cover the engine's logic, not real network ICE.
// (Harness mirrors tests/voiceShare.test.mjs.)
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
// The engine builds one <audio> element per remote track; the fake
// records what the engine asked of it (volume, muted, sink, play,
// remove) so the music/mic split is observable.
class FakeAudio {
  constructor() {
    this.volume = 1;
    this.muted = false;
    this.srcObject = null;
    this.autoplay = false;
    this.playsInline = false;
    this.played = 0;
    this.removed = false;
    this.sinkId = null;
  }
  play() { this.played += 1; return Promise.resolve(); }
  remove() { this.removed = true; }
  setSinkId(id) { this.sinkId = id; return Promise.resolve(); }
}
globalThis.Audio = FakeAudio;
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

const micTrack = { kind: 'audio', stop() {} };

// A fake captureStream: one audio track with listener support, so
// tests can fire the remote 'ended' event on it.
function makeMusicStream() {
  const listeners = {};
  const track = {
    kind: 'audio',
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
    getAudioTracks: () => [track],
    getTracks: () => [track]
  };
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
  // A mic track is already live: the music path must not touch it.
  engine.localStream = { getTracks: () => [micTrack] };
  return { engine, socket };
}

afterEach(() => {
  delete globalThis.navigator;
});

test('startMusic adds a second audio track to every peer and renegotiates; the mic is untouched', async () => {
  const music = makeMusicStream();
  const { engine, socket } = makeEngine();
  engine._createPeer('p1');
  engine._createPeer('p2');
  const res = await engine.startMusic(music);
  assert.deepEqual(res, { ok: true });
  for (const id of ['p1', 'p2']) {
    const pc = engine.peers.get(id).pc;
    assert.equal(pc.addedTracks.filter((t) => t.track.kind === 'audio').length, 2, 'mic + music');
    assert.equal(pc.addedTracks.filter((t) => t.track === music.track).length, 1);
    assert.equal(pc.addedTracks.find((t) => t.track === music.track).stream, music);
    // The mic sender is still the original one — never re-added.
    assert.equal(pc.addedTracks.find((t) => t.track === micTrack).stream, engine.localStream);
  }
  assert.equal(engine.musicSenders.size, 2);
  // Renegotiation: one offer per peer over the existing signal path.
  const offers = socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer');
  assert.equal(offers.length, 2);
  engine.leave();
});

test('startMusic with no audio track fails cleanly and adds nothing', async () => {
  const { engine, socket } = makeEngine();
  engine._createPeer('p1');
  const res = await engine.startMusic({ getAudioTracks: () => [], getTracks: () => [] });
  assert.equal(res.ok, false);
  assert.equal(engine.musicStream, null);
  assert.equal(engine.peers.get('p1').pc.addedTracks.length, 1, 'only the mic');
  assert.equal(socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, 0);
  engine.leave();
});

test('startMusic twice with the same stream is a no-op, not a second sender', async () => {
  const music = makeMusicStream();
  const { engine, socket } = makeEngine();
  engine._createPeer('p1');
  await engine.startMusic(music);
  const offersAfterFirst = socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length;
  const res = await engine.startMusic(music);
  assert.deepEqual(res, { ok: true });
  assert.equal(engine.peers.get('p1').pc.addedTracks.filter((t) => t.track === music.track).length, 1);
  assert.equal(socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer').length, offersAfterFirst);
  engine.leave();
});

test('stopMusic removes only the music sender, renegotiates, stops the capture', async () => {
  const music = makeMusicStream();
  const { engine, socket } = makeEngine();
  engine._createPeer('p1');
  await engine.startMusic(music);
  const pc = engine.peers.get('p1').pc;
  socket.emitted.length = 0;
  await engine.stopMusic();
  assert.equal(pc.removedSenders.length, 1);
  assert.equal(pc.removedSenders[0].track, music.track);
  // The mic sender was never removed.
  assert.equal(pc.addedTracks.filter((t) => t.track === micTrack).length, 1);
  assert.equal(music.track.stopped, true);
  assert.equal(engine.musicStream, null);
  assert.equal(engine.musicSenders.size, 0);
  // Renegotiation: the removal is offered to the peer.
  const offers = socket.emitted.filter(([e, p]) => e === 'signal' && p.type === 'offer');
  assert.equal(offers.length, 1);
  engine.leave();
});

test('stopMusic when no music is live is a no-op', async () => {
  const { engine, socket } = makeEngine();
  engine._createPeer('p1');
  await engine.stopMusic();
  assert.equal(socket.emitted.length, 0);
  engine.leave();
});

test('a peer created after music started gets the music track at once', async () => {
  const music = makeMusicStream();
  const { engine } = makeEngine();
  await engine.startMusic(music);
  engine._createPeer('late-joiner');
  const pc = engine.peers.get('late-joiner').pc;
  assert.equal(pc.addedTracks.filter((t) => t.track === micTrack).length, 1);
  assert.equal(pc.addedTracks.filter((t) => t.track === music.track).length, 1);
  engine.leave();
});

test('leave() stops the music capture so no music outlives the room', async () => {
  const music = makeMusicStream();
  const { engine } = makeEngine();
  engine._createPeer('p1');
  await engine.startMusic(music);
  assert.ok(engine.musicStream);
  engine.leave();
  assert.equal(music.track.stopped, true);
  assert.equal(engine.musicStream, null);
});

// --- receiver side: ontrack classification ---

function fireAudioTrack(pc, track) {
  pc.ontrack({ track, streams: [{ id: `stream-${track.kind}-${track.label || ''}` }] });
}

test('ontrack: first audio track is the mic, second audio track is music on its own element', () => {
  const seen = [];
  const { engine } = makeEngine({ onMusicTrack: (socketId, stream) => seen.push([socketId, stream]) });
  engine._createPeer('p1');
  const pc = engine.peers.get('p1').pc;

  const micRemote = { kind: 'audio', addEventListener() {} };
  fireAudioTrack(pc, micRemote);
  const peer = engine.peers.get('p1');
  assert.ok(peer.audioEl, 'first audio track builds the mic element');
  assert.equal(peer.musicEl, null, 'no music element yet');
  assert.equal(peer.analyser, null, 'no AudioContext in node — analyser stays null, as before');
  assert.equal(seen.length, 0, 'the mic is not reported as music');

  const musicRemote = { kind: 'audio', addEventListener() {} };
  fireAudioTrack(pc, musicRemote);
  assert.ok(peer.musicEl, 'second audio track builds the music element');
  assert.notEqual(peer.musicEl, peer.audioEl, 'music and mic are separate elements');
  assert.equal(peer.musicEl.played, 1);
  assert.equal(seen.length, 1, 'the music track is reported once');
  assert.equal(seen[0][0], 'p1');
  // No speaking analyser on the music stream: music must never light
  // the orb, and the analyser count stays at the mic's one.
  assert.equal(peer.analyser, null);
  engine.leave();
});

test('ontrack: the music element plays at musicVolume, not at master/peer volume', () => {
  const { engine } = makeEngine();
  engine._createPeer('p1');
  const pc = engine.peers.get('p1').pc;
  fireAudioTrack(pc, { kind: 'audio', addEventListener() {} });
  // Turn the voice volumes down: the music must not follow them.
  engine.setMasterVolume(0.2);
  engine.setPeerVolume('p1', 0.3);
  assert.equal(engine.peers.get('p1').audioEl.volume, 0.06);
  engine.setMusicVolume(0.7);
  fireAudioTrack(pc, { kind: 'audio', addEventListener() {} });
  const peer = engine.peers.get('p1');
  assert.equal(peer.musicEl.volume, 0.7, 'music rides its own volume only');
  assert.equal(peer.musicEl.muted, false);
  engine.leave();
});

test('setMusicVolume / setMusicMuted apply to live music elements; deafen mutes them too', () => {
  const { engine } = makeEngine();
  engine._createPeer('p1');
  const pc = engine.peers.get('p1').pc;
  fireAudioTrack(pc, { kind: 'audio', addEventListener() {} });
  fireAudioTrack(pc, { kind: 'audio', addEventListener() {} });
  const peer = engine.peers.get('p1');
  assert.equal(peer.musicEl.volume, 1);
  engine.setMusicVolume(0.4);
  assert.equal(peer.musicEl.volume, 0.4);
  engine.setMusicMuted(true);
  assert.equal(peer.musicEl.volume, 0, 'mute zeroes the volume');
  engine.setMusicMuted(false);
  assert.equal(peer.musicEl.volume, 0.4, 'unmute restores the volume');
  engine.setDeafened(true);
  assert.equal(peer.musicEl.muted, true, 'deafen mutes the music element outright');
  assert.equal(peer.audioEl.muted, true);
  engine.setDeafened(false);
  assert.equal(peer.musicEl.muted, false);
  engine.leave();
});

test('a music track ending tears its element down and reports onMusicEnded', () => {
  const ended = [];
  const { engine } = makeEngine({ onMusicEnded: (socketId) => ended.push(socketId) });
  engine._createPeer('p1');
  const pc = engine.peers.get('p1').pc;
  fireAudioTrack(pc, { kind: 'audio', addEventListener() {} });
  let endedFn = null;
  fireAudioTrack(pc, { kind: 'audio', addEventListener: (event, fn) => { endedFn = fn; } });
  const peer = engine.peers.get('p1');
  const musicEl = peer.musicEl;
  assert.ok(musicEl);
  assert.equal(typeof endedFn, 'function');
  endedFn();
  assert.deepEqual(ended, ['p1']);
  assert.equal(peer.musicEl, null, 'the element is torn down');
  assert.equal(musicEl.removed, true);
  assert.equal(musicEl.srcObject, null);
  // The mic element is untouched by the music ending.
  assert.ok(peer.audioEl);
  assert.equal(peer.audioEl.removed, false);
  engine.leave();
});

test('retryPlayback retries the music element too', async () => {
  const { engine } = makeEngine();
  engine._createPeer('p1');
  const pc = engine.peers.get('p1').pc;
  fireAudioTrack(pc, { kind: 'audio', addEventListener() {} });
  fireAudioTrack(pc, { kind: 'audio', addEventListener() {} });
  const peer = engine.peers.get('p1');
  assert.equal(await engine.retryPlayback(), true);
  assert.equal(peer.audioEl.played, 2);
  assert.equal(peer.musicEl.played, 2);
  engine.leave();
});

test('removing a peer with music tears the music element down and reports it once', () => {
  const ended = [];
  const { engine } = makeEngine({ onMusicEnded: (socketId) => ended.push(socketId) });
  engine._createPeer('p1');
  const pc = engine.peers.get('p1').pc;
  fireAudioTrack(pc, { kind: 'audio', addEventListener() {} });
  fireAudioTrack(pc, { kind: 'audio', addEventListener() {} });
  engine._removePeer('p1');
  assert.deepEqual(ended, ['p1']);
  // A peer that never played music reports nothing on removal.
  engine._createPeer('p2');
  engine._removePeer('p2');
  assert.deepEqual(ended, ['p1']);
  engine.leave();
});
