// Streak / activity strip (v0.9.0 density): a small strip beside the
// hero card — "N days active this week" with one dot per day and the
// current streak, derived from GET /api/me/activity (see
// frontend/src/activityStats.js). Desktop only, hidden below 1280px
// in CSS. Never fake activity: with no active days it says the week
// is quiet so far, and while the fetch is still loading it says so
// instead of showing zeroes.
import React from 'react';
import { weekActivity } from '../activityStats';
import { Icon } from './icons';

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

export default function StreakStrip({ activity, loading }) {
  if (loading) {
    return (
      <section className="streak-strip" aria-label="Your activity this week">
        <span className="streak-icon"><Icon name="flame" size={16} /></span>
        <span className="muted">Checking your week…</span>
      </section>
    );
  }

  // Null activity means the fetch failed (a successful fetch always
  // returns an object, even with zero active days) — say so instead
  // of claiming a quiet week.
  if (!activity) {
    return (
      <section className="streak-strip" aria-label="Your activity this week">
        <span className="streak-icon"><Icon name="flame" size={16} /></span>
        <span className="muted">Couldn&rsquo;t load your week — check back soon</span>
      </section>
    );
  }

  const { days, count, streak } = weekActivity(activity?.days);
  const messageCount = activity?.messageCount || 0;

  return (
    <section className="streak-strip" aria-label="Your activity this week">
      <span className="streak-icon"><Icon name="flame" size={16} /></span>
      <span className="streak-text">
        {count === 0 ? (
          <><strong>Quiet week so far</strong><span className="muted"> — no activity in the last 7 days</span></>
        ) : (
          <><strong>{count} day{count === 1 ? '' : 's'} active this week</strong>{streak > 1 && <span className="muted"> · {streak} in a row</span>}{messageCount > 0 && <span className="muted"> · {messageCount} message{messageCount === 1 ? '' : 's'}</span>}</>
        )}
      </span>
      <span className="streak-dots" aria-hidden="true">
        {days.map((d) => {
          const letter = DAY_LETTERS[new Date(`${d.date}T00:00:00Z`).getUTCDay()];
          return (
            <span key={d.date} className={`streak-dot${d.active ? ' streak-dot--active' : ''}`} title={`${d.date}${d.active ? ' — active' : ''}`}>
              {letter}
            </span>
          );
        })}
      </span>
    </section>
  );
}
