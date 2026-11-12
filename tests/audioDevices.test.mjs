// Tests for audio settings' pure half (v0.7.0,
// frontend/src/audioDevices.js): volume clamping, device-list
// normalization + fallback labels, default-device picking, and the
// capability checks that drive the graceful degradation in
// AudioSettings.jsx. navigator / HTMLMediaElement are faked per
// test — the module only reads them, never caches them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampVolume, supportsDeviceSelection, supportsOutputSelection,
  normalizeDevices, pickDefaultDevice, listMediaDevices
} from '../frontend/src/audioDevices.js';

test('audioDevices: clampVolume keeps 0–1, non-finite means full', () => {
  assert.equal(clampVolume(0), 0);
  assert.equal(clampVolume(0.5), 0.5);
  assert.equal(clampVolume(1), 1);
  assert.equal(clampVolume(-0.2), 0);
  assert.equal(clampVolume(1.5), 1);
  assert.equal(clampVolume(NaN), 1);
  assert.equal(clampVolume(undefined), 1);
  assert.equal(clampVolume(null), 1);
});

test('audioDevices: normalizeDevices keeps only the asked kind, dedupes, labels fall back', () => {
  const raw = [
    { deviceId: '', kind: 'audioinput', label: '' },
    { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Mic' },
    { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Mic' }, // duplicate
    { deviceId: 'spk-1', kind: 'audiooutput', label: 'Speakers' },
    { deviceId: 'cam-1', kind: 'videoinput', label: 'Camera' },
    null,
    { deviceId: 'mic-2', kind: 'audioinput', label: '   ' } // blank label
  ];
  assert.deepEqual(normalizeDevices(raw, 'audioinput'), [
    { deviceId: '', kind: 'audioinput', label: 'Microphone 1' },
    { deviceId: 'mic-1', kind: 'audioinput', label: 'USB Mic' },
    { deviceId: 'mic-2', kind: 'audioinput', label: 'Microphone 3' }
  ]);
  assert.deepEqual(normalizeDevices(raw, 'audiooutput'), [
    { deviceId: 'spk-1', kind: 'audiooutput', label: 'Speakers' }
  ]);
  assert.deepEqual(normalizeDevices([], 'audioinput'), []);
  assert.deepEqual(normalizeDevices(undefined, 'audioinput'), []);
});

test('audioDevices: pickDefaultDevice prefers the stored id, then the browser default, then first', () => {
  const devices = [
    { deviceId: '', kind: 'audioinput', label: 'Default' },
    { deviceId: 'a', kind: 'audioinput', label: 'Mic A' },
    { deviceId: 'b', kind: 'audioinput', label: 'Mic B' }
  ];
  assert.equal(pickDefaultDevice(devices, 'b'), 'b');
  assert.equal(pickDefaultDevice(devices, 'gone'), '');
  assert.equal(pickDefaultDevice(devices, ''), '');
  assert.equal(pickDefaultDevice(devices.slice(1), ''), 'a');
  assert.equal(pickDefaultDevice([], 'a'), '');
});

test('audioDevices: capability checks degrade without navigator / setSinkId', () => {
  const savedNavigator = globalThis.navigator;
  const savedMediaElement = globalThis.HTMLMediaElement;
  try {
    delete globalThis.navigator;
    assert.equal(supportsDeviceSelection(), false);
    globalThis.navigator = {};
    assert.equal(supportsDeviceSelection(), false);
    globalThis.navigator = { mediaDevices: {} };
    assert.equal(supportsDeviceSelection(), false);
    globalThis.navigator = { mediaDevices: { enumerateDevices: () => Promise.resolve([]) } };
    assert.equal(supportsDeviceSelection(), true);

    delete globalThis.HTMLMediaElement;
    assert.equal(supportsOutputSelection(), false);
    globalThis.HTMLMediaElement = function () {};
    assert.equal(supportsOutputSelection(), false);
    globalThis.HTMLMediaElement.prototype.setSinkId = function () {};
    assert.equal(supportsOutputSelection(), true);
  } finally {
    if (savedNavigator === undefined) delete globalThis.navigator;
    else globalThis.navigator = savedNavigator;
    if (savedMediaElement === undefined) delete globalThis.HTMLMediaElement;
    else globalThis.HTMLMediaElement = savedMediaElement;
  }
});

test('audioDevices: listMediaDevices never throws and reports support honestly', async () => {
  const savedNavigator = globalThis.navigator;
  try {
    delete globalThis.navigator;
    assert.deepEqual(await listMediaDevices(), { supported: false, inputs: [], outputs: [] });

    globalThis.navigator = {
      mediaDevices: {
        enumerateDevices: async () => [
          { deviceId: 'm1', kind: 'audioinput', label: 'Mic' },
          { deviceId: 's1', kind: 'audiooutput', label: '' }
        ]
      }
    };
    const ok = await listMediaDevices();
    assert.equal(ok.supported, true);
    assert.deepEqual(ok.inputs, [{ deviceId: 'm1', kind: 'audioinput', label: 'Mic' }]);
    assert.deepEqual(ok.outputs, [{ deviceId: 's1', kind: 'audiooutput', label: 'Speaker 1' }]);

    globalThis.navigator = { mediaDevices: { enumerateDevices: async () => { throw new Error('denied'); } } };
    assert.deepEqual(await listMediaDevices(), { supported: false, inputs: [], outputs: [] });
  } finally {
    if (savedNavigator === undefined) delete globalThis.navigator;
    else globalThis.navigator = savedNavigator;
  }
});
