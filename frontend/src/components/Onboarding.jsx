// Onboarding (v0.7.0, playbook p.12) — the first-run flow for a
// new user: test the mic before the first call, pick a mood, then
// continue into the app.
//
// Skippable and never blocking: it shows once per device (App gates
// it on localStorage 'orbit:onboarded:v1'), Skip and Continue both
// dismiss it forever, and a denied mic is a message, not a wall —
// the user can still join listening-only. Returning users never
// see it. The mic test can be retaken anytime from Audio settings.
import React, { useState } from 'react';
import { updateProfile } from '../api';
import MicTest from './MicTest';
import MoodPicker from './MoodPicker';
import { normalizeMood } from '../mood';
import '../onboarding.css';

export default function Onboarding({ user, onSaved, onDone }) {
  const [mood, setMood] = useState(normalizeMood(user?.mood));
  const [moodSaved, setMoodSaved] = useState(false);
  const [heard, setHeard] = useState(false);

  const pickMood = async (m) => {
    setMood(m);
    setMoodSaved(false);
    try {
      const data = await updateProfile({ mood: m });
      setMoodSaved(true);
      if (onSaved && data?.user) onSaved(data.user);
    } catch {
      // The mood is a nicety here, not the onboarding — a failed
      // save stays local for this session and never blocks Continue.
    }
  };

  return (
    <div className="onboarding-overlay" role="dialog" aria-modal="true" aria-label="Welcome to Orbit">
      <div className="onboarding-card card">
        <h2>Welcome to Orbit</h2>
        <p className="muted">
          Rooms, not servers — drop in with friends as floating orbs.
          Two quick things before your first call, and you can skip
          either of them.
        </p>

        <section className="onboarding-step">
          <h3><span className="onboarding-num" aria-hidden="true">1</span> Check your mic</h3>
          <p className="muted">Speak and watch the meter move — so your first call just works.</p>
          <MicTest onHeard={() => setHeard(true)} />
          {heard && <p className="saved-note">Mic sounds good.</p>}
        </section>

        <section className="onboarding-step">
          <h3><span className="onboarding-num" aria-hidden="true">2</span> Set your mood</h3>
          <p className="muted">Your orb glows with it — friends see at a glance if you are free to talk.</p>
          <MoodPicker value={mood} onChange={pickMood} label="Your mood" />
          {moodSaved && <p className="saved-note">Mood saved.</p>}
        </section>

        <div className="onboarding-actions">
          <button type="button" className="btn btn-primary" onClick={onDone}>
            Continue to Orbit
          </button>
          <button type="button" className="btn btn-text" onClick={onDone}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
