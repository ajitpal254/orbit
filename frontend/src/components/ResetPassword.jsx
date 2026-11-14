// Reset-password form (v0.9.1): opened from a #reset-password-<token>
// link in the reset email. The token comes from the URL hash (never
// from a query string, so it stays out of server logs) and is POSTed
// in the JSON body to /api/auth/reset-password. Shown instead of the
// Auth screen while the user is logged out; on success it hands back
// to log-in via onDone.
import React, { useState } from 'react';
import { resetPassword } from '../api';
import { Icon } from './icons';

export default function ResetPassword({ token, onDone }) {
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (newPassword.length < 12) {
      setError('Password must be at least 12 characters');
      return;
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setBusy(true);
    try {
      await resetPassword(token, newPassword);
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not reset your password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="auth-orb"><Icon name="planet" size={34} /></div>
        <h1>Reset password</h1>
        <p className="muted">Choose a new password for your Orbit account.</p>
        {done ? (
          <>
            <p className="saved-note">
              <Icon name="check" size={14} /> Password reset — log in with your new password.
            </p>
            <button className="btn btn-primary" onClick={onDone}>
              Back to log in
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <input
              placeholder="New password (min 12 characters)"
              type="password" required
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
            />
            <input
              placeholder="Confirm new password"
              type="password" required
              value={confirm} onChange={(e) => setConfirm(e.target.value)}
            />
            {error && <p className="error">{error}</p>}
            <button className="btn btn-primary" disabled={busy}>
              {busy ? 'Please wait…' : 'Reset password'}
            </button>
            <button type="button" className="btn btn-text btn-small" onClick={onDone}>
              Back to log in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
