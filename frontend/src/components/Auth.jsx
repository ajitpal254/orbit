import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from '../api';
import { getGoogleClientId, shouldShowGoogleButton, loadGoogleScript, renderGoogleButton } from '../googleSignIn';

export default function Auth({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [googleClientId, setGoogleClientId] = useState(null);
  const googleBtnRef = useRef(null);
  const googleRenderedRef = useRef(false);

  // Google one-tap: only if the server reports a client ID. Any failure
  // here is non-fatal — the password form below keeps working.
  useEffect(() => {
    let cancelled = false;
    apiJson('/api/config')
      .then((cfg) => {
        if (cancelled) return;
        const clientId = getGoogleClientId(cfg);
        if (!shouldShowGoogleButton(clientId)) return;
        setGoogleClientId(clientId);
      })
      .catch(() => { /* config fetch failed — password login still works */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!googleClientId || !googleBtnRef.current || googleRenderedRef.current) return;
    googleRenderedRef.current = true;
    loadGoogleScript()
      .then(() => {
        renderGoogleButton(googleBtnRef.current, googleClientId, async (credential) => {
          setError('');
          setBusy(true);
          try {
            const data = await apiJson('/api/auth/google', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ credential })
            });
            onAuth(data.user);
          } catch (err) {
            setError(err.message || 'Google sign-in failed');
          } finally {
            setBusy(false);
          }
        });
      })
      .catch(() => { /* GSI script failed — password login still works */ });
  }, [googleClientId, onAuth]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await apiJson(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, name })
      });
      onAuth(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="auth-orb"><span>🪐</span></div>
        <h1>Orbit</h1>
        <p className="muted">Voice rooms for your people. Drop in, talk, drift out.</p>
        <div className="auth-tabs">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Log in</button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Sign up</button>
        </div>
        {googleClientId && (
          <>
            <div ref={googleBtnRef} className="google-btn" />
            <div className="auth-divider"><span>or with email</span></div>
          </>
        )}
        <form onSubmit={submit}>
          {mode === 'register' && (
            <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          )}
          <input
            placeholder="Email" type="email" required
            value={email} onChange={(e) => setEmail(e.target.value)}
          />
          <input
            placeholder={mode === 'register' ? 'Password (min 12 characters)' : 'Password'}
            type="password" required
            value={password} onChange={(e) => setPassword(e.target.value)}
          />
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}
