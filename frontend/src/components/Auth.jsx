import React, { useState } from 'react';
import { apiJson, getCookie } from '../api';

export default function Auth({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await apiJson(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-csrf-token': getCookie('csrfToken') },
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
