// Audio settings (v0.7.0, playbook p.12) — mic / speaker picker +
// master + per-peer volume, in the room view.
//
// Graceful degradation, by design:
//   - no enumerateDevices (old browser) → a plain note, no picker.
//   - no setSinkId (Safari / Firefox) → the speaker picker is
//     disabled with an explanation; the OS default plays.
//   - a mic switch that fails keeps the old mic running (voice.js
//     returns { ok: false } instead of swapping) and reports it here.
//   - volumes are element volume (master × peer), never the
//     proximity GainNode — spatial audio behaviour is untouched.
//
// Mic / speaker choices and the master volume persist in
// localStorage per device, so a returning user keeps their setup.
// Per-peer volumes are session-only: socket ids do not survive a
// reload, so persisting them would be noise.
import React, { useEffect, useState } from 'react';
import {
  supportsDeviceSelection, supportsOutputSelection,
  listMediaDevices, pickDefaultDevice, clampVolume
} from '../audioDevices';
import MicTest from './MicTest';
import { Icon } from './icons';
import '../audioSettings.css';

const LS_MIC = 'orbit:audio:mic';
const LS_SPEAKER = 'orbit:audio:speaker';
const LS_MASTER = 'orbit:audio:master';

const readStored = (key) => {
  try { return window.localStorage.getItem(key) || ''; } catch { return ''; }
};
const writeStored = (key, value) => {
  try { window.localStorage.setItem(key, value); } catch {}
};

export default function AudioSettings({ voiceRef, peers = [], onClose }) {
  const engine = () => voiceRef?.current || null;
  const [supported, setSupported] = useState(supportsDeviceSelection());
  const [outputSupported] = useState(supportsOutputSelection());
  const [inputs, setInputs] = useState([]);
  const [outputs, setOutputs] = useState([]);
  const [micId, setMicId] = useState(() => readStored(LS_MIC));
  const [speakerId, setSpeakerId] = useState(() => readStored(LS_SPEAKER));
  const [master, setMaster] = useState(() => {
    const v = Number(readStored(LS_MASTER));
    return Number.isFinite(v) ? clampVolume(v) : 1;
  });
  const [peerVols, setPeerVols] = useState({});
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshDevices = async () => {
    const { supported: ok, inputs: ins, outputs: outs } = await listMediaDevices();
    setSupported(ok);
    setInputs(ins);
    setOutputs(outs);
    // Pre-select the stored device when it is still plugged in.
    if (ins.length) setMicId((cur) => pickDefaultDevice(ins, cur || readStored(LS_MIC)));
    if (outs.length) setSpeakerId((cur) => pickDefaultDevice(outs, cur || readStored(LS_SPEAKER)));
  };

  // Load the device list when the panel opens, and re-apply the
  // stored master volume (a reload starts the engine at full).
  useEffect(() => {
    refreshDevices();
    const eng = engine();
    if (eng) eng.setMasterVolume(Number(readStored(LS_MASTER)) || 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeMic = async (id) => {
    const eng = engine();
    if (!eng) return;
    setBusy(true);
    setNotice('');
    const res = await eng.setMicDevice(id);
    setBusy(false);
    if (res.ok) {
      setMicId(id);
      writeStored(LS_MIC, id);
      setNotice('Microphone switched.');
    } else {
      setNotice(res.error || 'Could not switch microphone — your previous mic is still active.');
      // Keep the select on the device that is actually live.
      setMicId(eng.micDeviceId || '');
    }
  };

  const changeSpeaker = async (id) => {
    const eng = engine();
    if (!eng) return;
    setBusy(true);
    setNotice('');
    const res = await eng.setSpeakerDevice(id);
    setBusy(false);
    if (!res.supported) {
      setNotice('This browser cannot choose a speaker — sound plays through your system default.');
      return;
    }
    setSpeakerId(id);
    writeStored(LS_SPEAKER, id);
    setNotice(res.failed > 0
      ? `Speaker set for ${res.applied} ${res.applied === 1 ? 'person' : 'people'} (${res.failed} could not switch).`
      : 'Speaker switched.');
  };

  const changeMaster = (v) => {
    const vol = clampVolume(v);
    setMaster(vol);
    writeStored(LS_MASTER, String(vol));
    engine()?.setMasterVolume(vol);
  };

  const changePeer = (socketId, v) => {
    const vol = clampVolume(v);
    setPeerVols((prev) => ({ ...prev, [socketId]: vol }));
    engine()?.setPeerVolume(socketId, vol);
  };

  return (
    <div className="audio-settings card" role="dialog" aria-label="Audio settings">
      <div className="audio-settings-head">
        <strong><Icon name="settings" size={15} /> Audio settings</strong>
        <button className="btn btn-text btn-small" onClick={onClose} aria-label="Close audio settings">
          <Icon name="x" size={14} />
        </button>
      </div>

      {!supported && (
        <p className="muted">This browser does not list audio devices — sound still works through your system defaults.</p>
      )}
      {supported && (
        <>
          <label className="field-label" htmlFor="audio-mic">Microphone</label>
          <div className="audio-row">
            <select
              id="audio-mic"
              value={micId}
              disabled={busy || inputs.length === 0}
              onChange={(e) => changeMic(e.target.value)}
            >
              {inputs.map((d) => (
                <option key={d.deviceId || 'default'} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
            <button className="btn btn-text btn-small" onClick={refreshDevices} title="Refresh the device list">
              Refresh
            </button>
          </div>
          {inputs.length === 0 && (
            <p className="muted">No microphones found — if you just allowed the mic, tap Refresh.</p>
          )}

          <label className="field-label" htmlFor="audio-speaker">Speaker</label>
          {outputSupported ? (
            <select
              id="audio-speaker"
              value={speakerId}
              disabled={busy || outputs.length === 0}
              onChange={(e) => changeSpeaker(e.target.value)}
            >
              {outputs.map((d) => (
                <option key={d.deviceId || 'default'} value={d.deviceId}>{d.label}</option>
              ))}
            </select>
          ) : (
            <p className="muted">This browser cannot choose a speaker (Safari / Firefox) — sound plays through your system default.</p>
          )}
        </>
      )}

      <label className="field-label" htmlFor="audio-master">
        Master volume — {Math.round(master * 100)}%
      </label>
      <input
        id="audio-master"
        type="range" min={0} max={100} step={5}
        value={Math.round(master * 100)}
        onChange={(e) => changeMaster(Number(e.target.value) / 100)}
        aria-label="Master volume"
      />

      {peers.length > 0 && (
        <div className="audio-peers">
          <p className="section-title">Per-person volume</p>
          {peers.map((p) => {
            const v = peerVols[p.socketId] ?? 1;
            return (
              <div key={p.socketId} className="audio-peer-row">
                <span className="audio-peer-name">{p.name.split(' ')[0]}</span>
                <input
                  type="range" min={0} max={100} step={5}
                  value={Math.round(v * 100)}
                  onChange={(e) => changePeer(p.socketId, Number(e.target.value) / 100)}
                  aria-label={`Volume for ${p.name}`}
                />
                <span className="muted audio-peer-pct">{Math.round(v * 100)}%</span>
              </div>
            );
          })}
        </div>
      )}
      {peers.length === 0 && (
        <p className="muted">You are alone in here — per-person volume appears when friends join.</p>
      )}

      {notice && <p className="muted" role="status">{notice}</p>}

      <div className="audio-mic-test">
        <p className="section-title">Microphone check</p>
        <MicTest compact />
      </div>
    </div>
  );
}
