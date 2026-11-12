// Mood picker — the three-state glow selector (free / busy /
// chilling). Used in Profile, in the room view ("My mood"), and in
// onboarding. Pure presentational: the parent owns the value and
// persists it (PATCH /api/users/me + socket 'mood' in a room).
import React from 'react';
import { MOODS, MOOD_META, normalizeMood } from '../mood';
import '../mood.css';

export default function MoodPicker({ value, onChange, label = 'Mood' }) {
  const current = normalizeMood(value);
  return (
    <div className="mood-picker" role="radiogroup" aria-label={label}>
      {MOODS.map((m) => {
        const meta = MOOD_META[m];
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={current === m}
            className={`mood-btn${current === m ? ' selected' : ''}`}
            style={{ '--mood-color': meta.color }}
            onClick={() => onChange && onChange(m)}
            title={meta.label}
          >
            <span className="mood-dot" aria-hidden="true" />
            {meta.short}
          </button>
        );
      })}
    </div>
  );
}
