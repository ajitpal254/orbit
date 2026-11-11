// Tests for the UI sounds (frontend/src/sounds.js) with a fake
// AudioContext that records the notes instead of playing them. The module
// never throws when audio is unavailable — that is tested too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playJoinSound, playMuteSound, playDeafenSound } from '../frontend/src/sounds.js';

let lastCtx = null;

class FakeOscillator {
  constructor() {
    this.type = '';
    this.frequency = { setValueAtTime: (v) => { this.freq = v; } };
    this.freq = null;
    this.started = false;
  }
  connect() {}
  start() { this.started = true; }
  stop() {}
}

class FakeGain {
  constructor() {
    this.gain = {
      setValueAtTime: () => {},
      linearRampToValueAtTime: () => {},
      exponentialRampToValueAtTime: () => {}
    };
  }
  connect() {}
}

class FakeAudioContext {
  constructor() {
    lastCtx = this;
    this.currentTime = 0;
    this.state = 'running';
    this.destination = {};
    this.oscs = [];
  }
  createOscillator() {
    const osc = new FakeOscillator();
    this.oscs.push(osc);
    return osc;
  }
  createGain() { return new FakeGain(); }
  resume() { return Promise.resolve(); }
}

globalThis.window = { AudioContext: FakeAudioContext };

test('join sound is two ascending notes', () => {
  const before = lastCtx ? lastCtx.oscs.length : 0;
  playJoinSound();
  const notes = lastCtx.oscs.slice(before);
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((o) => o.freq), [659.25, 880]);
  assert.ok(notes.every((o) => o.started));
});

test('mute plays two notes down, unmute two notes up', () => {
  const before = lastCtx.oscs.length;
  playMuteSound(true);
  assert.deepEqual(lastCtx.oscs.slice(before).map((o) => o.freq), [440, 329.63]);

  const before2 = lastCtx.oscs.length;
  playMuteSound(false);
  assert.deepEqual(lastCtx.oscs.slice(before2).map((o) => o.freq), [329.63, 440]);
});

test('deafen plays two lower notes down, undeafen two notes up', () => {
  const before = lastCtx.oscs.length;
  playDeafenSound(true);
  assert.deepEqual(lastCtx.oscs.slice(before).map((o) => o.freq), [330, 220]);

  const before2 = lastCtx.oscs.length;
  playDeafenSound(false);
  assert.deepEqual(lastCtx.oscs.slice(before2).map((o) => o.freq), [220, 330]);
});
