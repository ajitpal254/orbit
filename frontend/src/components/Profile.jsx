// Profile: edit name + bio, pick an animated avatar preset or upload
// your own photo, and toggle web push.
//
// The photo is downscaled client-side (canvas, 256x256 JPEG ~0.8)
// before it is sent, so the stored data URL stays small; the server
// still enforces the 200KB cap. Choosing a preset clears a photo and
// uploading a photo clears the preset — one avatar source at a time.
import React, { useEffect, useRef, useState } from 'react';
import { updateProfile, apiJson, resendVerificationEmail } from '../api';
import { AVATAR_PRESETS } from '../avatars';
import Avatar from './Avatar';
import MoodPicker from './MoodPicker';
import { normalizeMood } from '../mood';
import { Icon } from './icons';
import { isPushSupported, getPushState, subscribeToPush, unsubscribeFromPush } from '../push';

const MAX_AVATAR_IMAGE_LENGTH = 200 * 1024;

// Downscale an image file to a 256x256 cover-cropped JPEG data URL.
// Returns the data URL, or throws a human-readable error.
const downscalePhoto = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('That file is not an image'));
      img.onload = () => {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // Cover crop: fill the square, centered.
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        const url = canvas.toDataURL('image/jpeg', 0.8);
        if (url.length > MAX_AVATAR_IMAGE_LENGTH) {
          reject(new Error('That photo is still too large after resizing — try a smaller one'));
        } else {
          resolve(url);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

export default function Profile({ user, onSaved, onOpenAbout }) {
  const [name, setName] = useState(user.name || '');
  const [bio, setBio] = useState(user.bio || '');
  // Mood glow (v0.7.0): the orb colour + pulse friends see in rooms.
  const [mood, setMood] = useState(normalizeMood(user.mood));
  const [avatarPreset, setAvatarPreset] = useState(user.avatarPreset || null);
  const [avatarImage, setAvatarImage] = useState(user.avatarImage || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const fileRef = useRef(null);

  // Web push toggle state: 'unsupported' | 'unconfigured' | 'subscribed'
  // | 'unsubscribed' | 'denied'. The VAPID public key comes from the
  // public /api/config (same pattern as TURN/Google config).
  const [pushState, setPushState] = useState('unsubscribed');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState('');
  const [vapidKey, setVapidKey] = useState(undefined); // undefined = not loaded yet
  // "Send test notification" state — one tap verifies push end to end
  // without needing a second user (POST /api/push/test).
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState('');

  // Email verification (audit M1): an unverified account cannot be
  // found in search, send invites, or create rooms. The resend
  // button requests a fresh verification email (24h, single-use).
  const [resendBusy, setResendBusy] = useState(false);
  const [resendResult, setResendResult] = useState('');

  const resendVerification = async () => {
    setResendResult('');
    setResendBusy(true);
    try {
      const data = await resendVerificationEmail();
      setResendResult(data.message || 'Verification email sent — check your inbox.');
    } catch (err) {
      setResendResult(err.message || 'Could not send a verification email');
    } finally {
      setResendBusy(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await apiJson('/api/config');
        if (cancelled) return;
        setVapidKey(cfg.vapidPublicKey || null);
        if (!cfg.vapidPublicKey) {
          setPushState('unconfigured');
          return;
        }
        setPushState(await getPushState());
      } catch {
        if (!cancelled) setPushState('unconfigured');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const previewUser = { name: name || user.name, avatarPreset, avatarImage };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    setSaved(false);
    setSaving(true);
    try {
      const data = await updateProfile({ name, bio, avatarPreset, avatarImage, mood });
      setSaved(true);
      if (onSaved) onSaved(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const onPhotoPicked = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    try {
      const url = await downscalePhoto(file);
      setAvatarImage(url);
      setAvatarPreset(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const togglePush = async () => {
    setPushError('');
    setPushBusy(true);
    try {
      if (pushState === 'subscribed') {
        await unsubscribeFromPush();
        setPushState('unsubscribed');
      } else {
        if (window.Notification && Notification.permission === 'denied') {
          setPushState('denied');
          return;
        }
        await subscribeToPush(vapidKey);
        setPushState('subscribed');
      }
    } catch (err) {
      // A denied permission prompt surfaces as NotAllowedError; the
      // toggle reports it plainly instead of failing silently.
      if (err && err.name === 'NotAllowedError') setPushState('denied');
      else setPushError(err.message || 'Could not change push settings');
    } finally {
      setPushBusy(false);
    }
  };

  // One-tap push check: the server sends a test push to this device's
  // subscriptions and leaves an in-app test notification behind. Only
  // offered while subscribed — without a subscription there is nothing
  // for the push to reach.
  const sendTestPush = async () => {
    setTestResult('');
    setTestBusy(true);
    try {
      const data = await apiJson('/api/push/test', { method: 'POST' });
      setTestResult(
        data.sent > 0
          ? 'Sent — a notification should appear even with the app in the background. Give it a few seconds.'
          : 'No push subscription was found on the server — turn push off and on again, then retry.'
      );
    } catch (err) {
      setTestResult(err.message || 'Could not send a test notification');
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className="view view-anim profile-view">
      <div className="greeting">
        <p className="date-line">Your orbit</p>
        <h2><Icon name="user" size={22} /> Profile</h2>
        <p className="muted">How friends see you in rooms and chats.</p>
      </div>

      {user.emailVerified === false && (
        <div className="card" role="alert">
          <h3 className="section-title">Verify your email</h3>
          <p className="muted">
            We sent a verification email to {user.email}. Until you verify,
            friends cannot find you in search and you cannot send invites
            or create rooms.
          </p>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={resendBusy}
            onClick={resendVerification}
          >
            {resendBusy ? 'Sending…' : 'Resend verification email'}
          </button>
          {resendResult && <p className="muted">{resendResult}</p>}
        </div>
      )}

      <form className="card profile-card" onSubmit={save}>
        <div className="profile-avatar-row">
          <Avatar user={previewUser} size="lg" />
          <div className="profile-avatar-actions">
            <button type="button" className="btn btn-primary btn-small" onClick={() => fileRef.current?.click()}>
              Upload a photo
            </button>
            {avatarImage && (
              <button
                type="button" className="btn btn-text btn-small"
                onClick={() => setAvatarImage('')}
              >
                Remove photo
              </button>
            )}
            <input
              ref={fileRef} type="file" accept="image/*" hidden
              onChange={onPhotoPicked}
            />
            <p className="muted profile-hint">Photos are resized to 256px on your device before uploading.</p>
          </div>
        </div>

        <p className="section-title">Or pick an animated avatar</p>
        <div className="preset-grid" role="radiogroup" aria-label="Avatar presets">
          {AVATAR_PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              role="radio"
              aria-checked={avatarPreset === p.id && !avatarImage}
              className={`preset-btn ${avatarPreset === p.id && !avatarImage ? 'selected' : ''}`}
              onClick={() => { setAvatarPreset(p.id); setAvatarImage(''); }}
              title={p.name}
            >
              <Avatar user={{ name: name || user.name, avatarPreset: p.id }} size="md" />
              <span>{p.name}</span>
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="profile-name">Display name</label>
        <input
          id="profile-name" value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={40} placeholder="Your name"
        />
        <label className="field-label" htmlFor="profile-bio">Bio</label>
        <textarea
          id="profile-bio" value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={140} rows={3}
          placeholder="A line about you (optional)"
        />
        <p className="muted char-count">{bio.length}/140</p>

        <p className="section-title">Mood — your orb glows with it in rooms</p>
        <MoodPicker value={mood} onChange={setMood} label="Mood" />
        <p className="muted profile-hint">Free, busy or chilling — no status text to maintain. Changing it here applies from your next room; in a room, use the picker under the orbs to change it live.</p>

        {error && <p className="error">{error}</p>}
        {saved && <p className="saved-note"><Icon name="check" size={14} /> Profile saved</p>}
        <button className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </button>
      </form>

      <div className="card">
        <h3 className="section-title">Notifications</h3>
        <div className="push-row">
          <div>
            <strong>Push notifications</strong>
            <p className="muted push-hint">
              {pushState === 'unsupported' && 'Push is not supported in this browser.'}
              {pushState === 'unconfigured' && 'Push is not set up yet on the server — the in-app bell still works.'}
              {pushState === 'denied' && 'Notifications are blocked for this site — allow them in your browser settings to turn push on.'}
              {pushState === 'subscribed' && 'On — friend requests, invites and DMs can reach you even when the app is closed.'}
              {pushState === 'unsubscribed' && 'Off — turn on to get friend requests, invites and DMs even when the app is closed.'}
            </p>
          </div>
          <button
            className="btn btn-primary btn-small"
            disabled={pushBusy || pushState === 'unsupported' || pushState === 'unconfigured' || pushState === 'denied'}
            onClick={togglePush}
          >
            {pushBusy ? '…' : pushState === 'subscribed' ? 'On' : 'Off'}
          </button>
        </div>
        {pushError && <p className="error">{pushError}</p>}
        {pushState === 'subscribed' && (
          <div className="push-test-row">
            <button
              type="button"
              className="btn btn-text btn-small"
              disabled={testBusy}
              onClick={sendTestPush}
            >
              {testBusy ? 'Sending…' : 'Send test notification'}
            </button>
            {testResult && <p className="muted">{testResult}</p>}
          </div>
        )}
      </div>

      <button className="btn btn-text" onClick={onOpenAbout}>
        About Orbit — Beta v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'}
      </button>
    </div>
  );
}
