// Mic test — the onboarding / audio-settings microphone check:
// grant the mic, speak, and watch the level meter respond. The
// test passes when the level stays above the audible threshold for
// a few consecutive polls (HEARD_POLLS), so a single noise blip
// does not count. Never blocks: the parent always offers Skip /
// Close, and a denied mic is a friendly message, not a dead end —
// the user can still join listening-only.
//
// Lifecycle: the stream + AudioContext live only while the test is
// running (started by the user's tap, so permission prompts are
// allowed); unmount / Done stops every track and closes the
// context, so the mic light goes off with the test.
import React, { useEffect, useRef, useState } from 'react';
import { rmsLevel, isAudible, HEARD_POLLS, classifyMicError } from '../micTest';
import '../micTest.css';

export default function MicTest({ onHeard, compact = false }) {
  const [state, setState] = useState('idle'); // idle | requesting | listening | heard | error
  const [level, setLevel] = useState(0);
  const [error, setError] = useState(null);
  const streamRef = useRef(null);
  const ctxRef = useRef(null);
  const rafRef = useRef(null);
  const heardPollsRef = useRef(0);
  const doneRef = useRef(false);

  const stop = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (ctxRef.current) {
      ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
  };

  useEffect(() => stop, []);

  const start = async () => {
    setError(null);
    setLevel(0);
    heardPollsRef.current = 0;
    doneRef.current = false;
    setState('requesting');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
    } catch (err) {
      setError(classifyMicError(err));
      setState('error');
      return;
    }
    streamRef.current = stream;
    let ctx;
    let analyser;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
    } catch {
      // No AudioContext (old browser): the mic itself works — the
      // meter just cannot run. Count that as heard so the test does
      // not block on a meter the browser cannot draw.
      setState('heard');
      if (onHeard) onHeard();
      return;
    }
    const data = new Uint8Array(analyser.fftSize);
    setState('listening');
    const tick = () => {
      if (doneRef.current) return;
      analyser.getByteTimeDomainData(data);
      const lv = rmsLevel(data);
      setLevel(lv);
      if (isAudible(lv)) {
        heardPollsRef.current += 1;
        if (heardPollsRef.current >= HEARD_POLLS) {
          doneRef.current = true;
          setState('heard');
          if (onHeard) onHeard();
          stop();
          return;
        }
      } else {
        heardPollsRef.current = 0;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const stopTest = () => {
    doneRef.current = true;
    stop();
    setLevel(0);
    setState('idle');
  };

  return (
    <div className={`mic-test${compact ? ' mic-test--compact' : ''}`}>
      {state === 'idle' && (
        <button type="button" className="btn btn-primary btn-small" onClick={start}>
          Test my microphone
        </button>
      )}
      {state === 'requesting' && (
        <p className="muted">Asking for your microphone…</p>
      )}
      {(state === 'listening' || state === 'heard') && (
        <div className="mic-test-meter-wrap">
          <div
            className={`mic-test-meter${state === 'heard' ? ' mic-test-meter--heard' : ''}`}
            role="meter"
            aria-label="Microphone level"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(Math.min(1, level * 6) * 100)}
          >
            <div
              className="mic-test-meter-fill"
              style={{ width: `${Math.round(Math.min(1, level * 6) * 100)}%` }}
            />
          </div>
          <p className="mic-test-status" role="status">
            {state === 'heard'
              ? '✓ We can hear you — your mic works.'
              : 'Speak now — say a few words and watch the meter move.'}
          </p>
          {state === 'listening' && (
            <button type="button" className="btn btn-text btn-small" onClick={stopTest}>
              Stop test
            </button>
          )}
        </div>
      )}
      {state === 'error' && error && (
        <div>
          <p className="mic-test-error" role="alert">{error.message}</p>
          <button type="button" className="btn btn-text btn-small" onClick={start}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
