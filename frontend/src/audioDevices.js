// Audio device helpers — the pure half of audio settings
// (playbook p.12: "Device picker, level meter, per-person volume").
//
// Everything here is defensive: browsers differ wildly in what they
// expose (setSinkId exists in Chrome/Edge, not in Safari/Firefox;
// enumerateDevices returns empty labels until mic permission is
// granted), so every capability is feature-detected and every list
// has a fallback. Nothing here touches the live engine —
// voice.js owns getUserMedia / setSinkId calls; this module only
// normalizes what the browser reports.

// Volume is a 0–1 float. Non-finite input (a hand-typed value, a
// missing stored setting) means "full volume" — never silence, never
// NaN into an <audio> element.
export function clampVolume(v) {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0, v));
}

// enumerateDevices exists (Chrome, Firefox, Safari 15+). Without it
// there is no picker at all — the component shows a plain note.
export function supportsDeviceSelection() {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === 'function'
  );
}

// setSinkId (HTMLMediaElement) is how a speaker is chosen. Chrome /
// Edge have it; Safari and Firefox do not — there the speaker picker
// is disabled with an explanation, and the OS default plays.
export function supportsOutputSelection() {
  return (
    typeof HTMLMediaElement !== 'undefined' &&
    typeof HTMLMediaElement.prototype.setSinkId === 'function'
  );
}

const KIND_LABEL = { audioinput: 'Microphone', audiooutput: 'Speaker' };

// Normalize a raw enumerateDevices() list for the picker: keep only
// audio devices, drop duplicates (same deviceId twice — browsers do
// this for the default device), and give unlabeled devices a stable
// numbered name ("Microphone 1"). Labels are empty until the user
// grants mic permission, so the fallback is the normal case on a
// first visit, not an error.
export function normalizeDevices(devices = [], kind) {
  const seen = new Set();
  const out = [];
  let n = 0;
  for (const d of devices || []) {
    if (!d || d.kind !== kind) continue;
    const id = d.deviceId || '';
    if (seen.has(id)) continue;
    seen.add(id);
    n += 1;
    const label = typeof d.label === 'string' && d.label.trim()
      ? d.label.trim()
      : `${KIND_LABEL[kind] || 'Device'} ${n}`;
    out.push({ deviceId: id, kind, label });
  }
  return out;
}

// The device to pre-select: the stored id when it is still plugged
// in, otherwise the browser default (deviceId '' — the "Default"
// entry enumerateDevices returns), otherwise the first device.
export function pickDefaultDevice(devices = [], preferredId) {
  if (!devices.length) return '';
  if (preferredId && devices.some((d) => d.deviceId === preferredId)) return preferredId;
  const def = devices.find((d) => d.deviceId === '');
  return def ? def.deviceId : devices[0].deviceId;
}

// Enumerate + normalize in one call for the component. Never throws:
// an unsupported browser resolves { supported: false, inputs: [],
// outputs: [] } and the UI degrades to a note.
export async function listMediaDevices() {
  if (!supportsDeviceSelection()) {
    return { supported: false, inputs: [], outputs: [] };
  }
  try {
    const raw = await navigator.mediaDevices.enumerateDevices();
    return {
      supported: true,
      inputs: normalizeDevices(raw, 'audioinput'),
      outputs: normalizeDevices(raw, 'audiooutput')
    };
  } catch {
    return { supported: false, inputs: [], outputs: [] };
  }
}
