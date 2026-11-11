// Night-sky home (playbook Prompt B item 1): friends as stars instead
// of a list. Data is the existing friend presence — GET
// /api/friends/presence, the same rows SidePanel.jsx shows — passed in
// by Home (which fetches once and shares it with both), never fetched
// here and never a new endpoint. Positions come from nightSky.js
// (deterministic hash of the user id), presence from starState().
//
// Behaviour:
//   in-room star (glow + pulse) → tap joins their room, via the same
//     GET /api/rooms/:id + onJoin(room) path SidePanel uses.
//   any other star → tap opens a small profile sheet (avatar, name,
//     status) with Join / Open in Friends actions.
//   stars are real <button>s — keyboard users Tab to a friend and press
//     Enter, no dragging, with a visible :focus-visible ring. Status is
//     also written as text under each name, never colour alone.
//   loading → skeleton stars; fetch error with last-known friends →
//     stale sky + a quiet note (offline included); error with nothing
//     → error line + Retry; no friends at all → renders nothing (the
//     Home empty state already covers that).
// Placement is Home's job: top of Home on phones, and on desktop only
// when there is no live hero (hasLiveHero hides it via CSS ≥900px).
import React, { useEffect, useRef, useState } from 'react';
import { apiJson } from '../api';
import { initials } from '../orbLayout';
import { starPosition, starState, starStatusText, starLabel, canJoin, outCount, visibleStars } from '../nightSky';
import Avatar from './Avatar';
import { Icon } from './icons';

export default function NightSky({ friends, loading, error, onJoin, onNavigate, onRetry, hasLiveHero }) {
  const [joining, setJoining] = useState(null);
  const [joinError, setJoinError] = useState('');
  // The sheet tracks an id, not a snapshot: the friend object is
  // re-derived from the live presence list each render, so if they
  // drop into a room while the sheet is open the Join button appears.
  const [selectedId, setSelectedId] = useState(null);
  const selected = selectedId
    ? (friends || []).find((f) => f.id === selectedId) || null
    : null;
  const closeBtnRef = useRef(null);

  // When the sheet opens, move focus to its Close button; Esc closes
  // it and returns focus to the star that opened it.
  useEffect(() => {
    if (!selected) return undefined;
    closeBtnRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [selected]);

  const joinFriendRoom = async (friend) => {
    if (!friend?.room?.id) return;
    setJoinError('');
    setJoining(friend.id);
    try {
      const room = await apiJson(`/api/rooms/${friend.room.id}`);
      onJoin(room);
    } catch (err) {
      setJoinError(err.message);
    } finally {
      setJoining(null);
    }
  };

  const openFriend = (friend) => {
    if (canJoin(friend)) {
      joinFriendRoom(friend);
    } else {
      setSelectedId(friend.id);
    }
  };

  // No friends at all: nothing to show as a sky.
  if (!loading && !error && (!friends || friends.length === 0)) return null;

  const out = outCount(friends || []);
  const { stars, overflow } = visibleStars(friends || []);
  const positions = Object.fromEntries(
    stars.map((f, i) => [f.id, starPosition(f, i)])
  );

  return (
    <section
      className={`night-sky${hasLiveHero ? ' night-sky--has-hero' : ''}`}
      aria-label="Your sky — friends as stars"
    >
      <div className="night-sky-head">
        <h3 className="section-title night-sky-title">
          <Icon name="planet" size={15} /> Your sky
        </h3>
        <p className="muted night-sky-sub">
          {loading
            ? 'Finding your friends…'
            : out > 0
              ? `${out} friend${out === 1 ? '' : 's'} out tonight — tap a bright star to drop in`
              : 'No one is out right now — dim stars are offline'}
        </p>
      </div>

      {loading && (
        <div className="night-sky-stage" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span key={i} className="night-star-skeleton" style={{ left: `${22 + i * 26}%`, top: `${30 + (i % 2) * 28}%` }} />
          ))}
        </div>
      )}

      {!loading && error && friends && friends.length > 0 && (
        <p className="muted night-sky-note" role="status">
          Couldn&rsquo;t refresh — showing the last known sky.
        </p>
      )}

      {!loading && error && (!friends || friends.length === 0) && (
        <div className="night-sky-error">
          <p className="error">Couldn&rsquo;t load your sky{error ? ` — ${error}` : ''}</p>
          {onRetry && (
            <button className="btn btn-text btn-small" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}

      {!loading && stars.length > 0 && (
        <div className="night-sky-stage">
          <div className="starfield" aria-hidden="true" />
          <div className="starfield-twinkle starfield-twinkle-a" aria-hidden="true" />
          <div className="starfield-twinkle starfield-twinkle-b" aria-hidden="true" />
          {stars.map((friend) => {
            const pos = positions[friend.id];
            const state = starState(friend);
            const firstName = (friend.name || 'Friend').split(' ')[0];
            return (
              <button
                key={friend.id}
                type="button"
                className={`night-star night-star--${state}`}
                style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
                onClick={() => openFriend(friend)}
                aria-label={starLabel(friend)}
                title={starLabel(friend)}
              >
                <span
                  className="night-star-dot"
                  style={{
                    width: pos.size,
                    height: pos.size,
                    animationDelay: `${pos.delay}s`,
                    animationDuration: `${pos.duration}s`
                  }}
                >
                  {initials(friend.name)}
                </span>
                <span className="night-star-name">{firstName}</span>
                <span className="night-star-status">{starStatusText(friend)}</span>
              </button>
            );
          })}
        </div>
      )}

      {joinError && <p className="error night-sky-error-line">{joinError}</p>}

      {!loading && overflow > 0 && (
        <button
          className="btn btn-text btn-small night-sky-more"
          onClick={() => onNavigate && onNavigate({ view: 'friends' })}
        >
          +{overflow} more friend{overflow === 1 ? '' : 's'} — see all
        </button>
      )}

      {selected && (
        <div className="night-sheet" role="dialog" aria-label={`${selected.name || 'Friend'} — profile`}>
          <Avatar user={selected} size="md" />
          <span className="person-info">
            <strong>{selected.name || 'Unnamed'}</strong>
            <span className="muted person-email">{starStatusText(selected)}</span>
          </span>
          <span className="row-actions night-sheet-actions">
            {canJoin(selected) && (
              <button
                className="btn btn-primary btn-small"
                disabled={joining === selected.id}
                onClick={() => joinFriendRoom(selected)}
              >
                {joining === selected.id ? 'Joining…' : 'Join'}
              </button>
            )}
            <button
              className="btn btn-text btn-small"
              onClick={() => onNavigate && onNavigate({ view: 'friends' })}
            >
              Open in Friends
            </button>
            <button
              ref={closeBtnRef}
              className="btn btn-text btn-small"
              onClick={() => setSelectedId(null)}
            >
              <Icon name="x" size={14} /> Close
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
