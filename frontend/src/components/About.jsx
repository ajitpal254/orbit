// About: what Orbit is, which version this is, and what is (and is
// not) finished yet. The app is in beta — the version line says so
// plainly instead of pretending to be a 1.0 release.
import React from 'react';
import { Icon } from './icons';

// Build version (Vite define from package.json, see vite.config.js).
// Guarded so the file doesn't break if the define is ever missing.
// Shared with the Home footer, which shows the same beta number.
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export default function About({ onBack }) {
  return (
    <div className="view view-anim about-view">
      <button className="btn btn-text back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Back</button>

      <div className="card about-card">
        <div className="about-head">
          <span className="about-logo"><Icon name="planet" size={34} /></span>
          <div>
            <h2>Orbit</h2>
            <span className="beta-badge">Beta v{APP_VERSION}</span>
          </div>
        </div>
        <p className="about-beta">
          This is a <strong>beta test</strong> — not a full, proper release yet.
          Things may change, break, or move around while it is being built.
        </p>
        <p className="muted">
          Orbit is spatial voice chat for friends. No servers, no channels —
          you drop into a room and talk, and everyone shows up as a floating
          orb. Voice is peer-to-peer; the server only helps you find each other.
        </p>
      </div>

      <div className="card">
        <h3 className="section-title">What&rsquo;s in</h3>
        <ul className="about-list">
          <li><Icon name="mic" size={15} /> Voice rooms — mesh voice with live speaking glow</li>
          <li><Icon name="users" size={15} /> Friends — requests, private rooms, room invites</li>
          <li><Icon name="chat" size={15} /> Direct messages between friends</li>
          <li><Icon name="crown" size={15} /> Roles &amp; moderation — owner, moderator, member</li>
          <li><Icon name="bell" size={15} /> Notifications — in-app center, plus web push when set up</li>
          <li><Icon name="image" size={15} /> Profiles — bio and an animated avatar or your own photo</li>
        </ul>
      </div>

      <div className="card">
        <h3 className="section-title">Known limits (beta)</h3>
        <ul className="about-list">
          <li>Voice works best with 2–6 people in a room (mesh)</li>
          <li>Mobile is a PWA — install it from the browser to keep it handy</li>
          <li>Moderator mute is cooperative: a muted member&rsquo;s app mutes itself</li>
          <li>Push notifications need the server&rsquo;s VAPID keys set up</li>
        </ul>
      </div>

      <div className="card">
        <h3 className="section-title">What&rsquo;s next</h3>
        <p className="muted about-next">
          Screen share is next. After that, a LiveKit server when rooms
          regularly grow past ~6 people.
        </p>
      </div>

      <p className="app-version">Orbit Beta v{APP_VERSION} — built for friends, tested by friends.</p>
    </div>
  );
}
