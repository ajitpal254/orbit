// Tests for the audio-settings engine half (v0.7.0): master +
// per-peer volume and speaker switching on VoiceEngine
// (frontend/src/voice.js). RTCPeerConnection / Audio /
// HTMLMediaElement are faked, following tests/voice.test.mjs —
// these cover the engine's volume/device logic, not real audio.
// The proximity GainNode routing is untouched by this feature and
// is covered by tests/proximityVoice.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceEngine } from '../frontend/src/voice.js';

class FakeAudio {
  constructor() {
    this.volume = 1;
    this.muted = false;
    this.sinkId = '';
  }
  play() { return Promise.resolve(); }
  remove() {}
  async setSinkId(id) { this.sinkId = id; }
}
globalThis.Audio = FakeAudio;
globalThis.HTMLMediaElement = function () {};
globalThis.HTMLMediaElement.prototype.setSinkId = FakeAudio.prototype.setSinkId;

class FakePC {
  constructor() {
    this.senders = [{
      track: { kind: 'audio' },
      replacedWith: null,
      async replaceTrack(t) { this.replacedWith = t; }
    }];
  }
  getSenders() { return this.senders; }
  close() {}
}
globalThis.RTCPeerConnection = FakePC;

const mockSocket = (id = 'me') => ({
  id,
  handlers: {},
  emitted: [],
  on(event, fn) { (this.handlers[event] ||= []).push(fn); },
  off() {},
  emit(event, data) { this.emitted.push({ event, data }); }
});

const engineWithPeer = (socketId = 'peer-1') => {
  const engine = new VoiceEngine({ socket: mockSocket(), roomId: 'room-1', selfId: 'user-1' });
  const audioEl = new FakeAudio();
  engine.peers.set(socketId, { pc: new FakePC(), audioEl, analyser: null, gainNode: null, elementSource: null, gain: 1 });
  return { engine, audioEl, socketId };
};

test('audio settings: master volume multiplies every peer element', () => {
  const { engine, audioEl } = engineWithPeer();
  engine.setMasterVolume(0.5);
  assert.equal(engine.masterVolume, 0.5);
  assert.equal(audioEl.volume, 0.5);
  engine.setMasterVolume(0);
  assert.equal(audioEl.volume, 0);
  engine.setMasterVolume(2); // clamps to 1, never above
  assert.equal(audioEl.volume, 1);
  engine.setMasterVolume(NaN); // non-finite means full, never silence
  assert.equal(audioEl.volume, 1);
});

test('audio settings: per-peer volume multiplies that peer only', () => {
  const engine = new VoiceEngine({ socket: mockSocket(), roomId: 'room-1', selfId: 'user-1' });
  const a = new FakeAudio();
  const b = new FakeAudio();
  engine.peers.set('peer-a', { pc: new FakePC(), audioEl: a });
  engine.peers.set('peer-b', { pc: new FakePC(), audioEl: b });
  engine.setPeerVolume('peer-a', 0.25);
  assert.equal(a.volume, 0.25);
  assert.equal(b.volume, 1);
  engine.setMasterVolume(0.5);
  assert.equal(a.volume, 0.125); // master × peer
  assert.equal(b.volume, 0.5);
  // A peer volume set before the element exists applies on ontrack —
  // simulated here by adding the peer after the setting.
  engine.setPeerVolume('peer-c', 0.4);
  const c = new FakeAudio();
  engine.peers.set('peer-c', { pc: new FakePC(), audioEl: c });
  engine._applyVolumes('peer-c');
  assert.equal(c.volume, 0.2); // 0.5 master × 0.4 peer
});

test('audio settings: speaker switch applies to live elements and is remembered', async () => {
  const { engine, audioEl } = engineWithPeer();
  const res = await engine.setSpeakerDevice('spk-9');
  assert.deepEqual(res, { supported: true, applied: 1, failed: 0 });
  assert.equal(audioEl.sinkId, 'spk-9');
  assert.equal(engine.speakerDeviceId, 'spk-9');
});

test('audio settings: speaker switch reports unsupported without setSinkId', async () => {
  const saved = globalThis.HTMLMediaElement.prototype.setSinkId;
  try {
    delete globalThis.HTMLMediaElement.prototype.setSinkId;
    const { engine, audioEl } = engineWithPeer();
    const res = await engine.setSpeakerDevice('spk-9');
    assert.deepEqual(res, { supported: false, applied: 0, failed: 0 });
    assert.equal(audioEl.sinkId, '');
  } finally {
    globalThis.HTMLMediaElement.prototype.setSinkId = saved;
  }
});

test('audio settings: mic switch swaps the track into every peer, keeps the old mic on failure', async () => {
  // Node 24 exposes navigator as a getter-only global — define it
  // (configurable) instead of assigning it.
  const hadNavigator = Object.prototype.hasOwnProperty.call(globalThis, 'navigator');
  const prevDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setNavigator = (value) => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  };
  try {
    const newTrack = { kind: 'audio', id: 'new-track' };
    const fakeStream = { getAudioTracks: () => [newTrack], getTracks: () => [newTrack] };
    setNavigator({ mediaDevices: { getUserMedia: async () => fakeStream } });
    const { engine } = engineWithPeer();
    const peer = engine.peers.get('peer-1');
    const res = await engine.setMicDevice('mic-2');
    assert.deepEqual(res, { ok: true });
    assert.equal(engine.micDeviceId, 'mic-2');
    assert.equal(peer.pc.senders[0].replacedWith, newTrack);

    // A failing switch keeps the previous mic: same device id, same track.
    setNavigator({
      mediaDevices: { getUserMedia: async () => { const e = new Error('gone'); e.name = 'NotFoundError'; throw e; } }
    });
    const failed = await engine.setMicDevice('mic-gone');
    assert.equal(failed.ok, false);
    assert.match(failed.error, /no longer available/);
    assert.equal(engine.micDeviceId, 'mic-2');
    assert.equal(peer.pc.senders[0].replacedWith, newTrack);
  } finally {
    if (hadNavigator && prevDescriptor) Object.defineProperty(globalThis, 'navigator', prevDescriptor);
    else delete globalThis.navigator;
  }
});
