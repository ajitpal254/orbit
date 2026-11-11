// Friends "stories" row (phones only — display:none above 520px in
// CSS, and the presence fetch is skipped off-phone too, so desktop
// behaviour is untouched). Avatars of online friends, in-room first;
// an in-room friend gets a glowing ring and taps through to their
// room (same fetch + join as the desktop SidePanel's Join button).
// Online-but-not-in-a-room friends are shown, not tappable — there
// is nowhere to join. Data is GET /api/friends/presence, the same
// endpoint SidePanel consumes; no new backend. Hidden entirely when
// nobody is around, so an empty friends list shows no trace of it.
// Home fetches presence once and passes it here (shared with the
// night sky and the side panel) — when `friends` is provided, use it
// and skip the standalone fetch; otherwise fetch on our own.
import React, { useEffect, useState, useCallback } from 'react';
import { apiJson, getFriendsPresence } from '../api';
import { storiesFriends } from '../desktop';
import Avatar from './Avatar';

export default function StoriesRow({ refreshTick, onJoin, friends: friendsProp }) {
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 520px)').matches
  );
  const [ownFriends, setOwnFriends] = useState(null);
  const [joining, setJoining] = useState(null);
  const [error, setError] = useState('');

  // Home owns the fetch when it passes `friends`; otherwise fetch here.
  const friends = friendsProp !== undefined ? friendsProp : ownFriends;

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 520px)');
    const onChange = (e) => setIsPhone(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const load = useCallback(async () => {
    try {
      setOwnFriends(await getFriendsPresence());
    } catch {}
  }, []);

  useEffect(() => {
    if (friendsProp !== undefined || !isPhone) return undefined;
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load, isPhone, friendsProp]);

  useEffect(() => {
    if (friendsProp !== undefined || !isPhone || refreshTick <= 0) return;
    load();
  }, [refreshTick, load, isPhone, friendsProp]);

  const joinFriendRoom = async (friend) => {
    if (!friend.room) return;
    setError('');
    setJoining(friend.id);
    try {
      const room = await apiJson(`/api/rooms/${friend.room.id}`);
      onJoin(room);
    } catch (err) {
      setError(err.message);
    } finally {
      setJoining(null);
    }
  };

  const visible = storiesFriends(friends);
  if (!isPhone || visible.length === 0) return null;

  return (
    <div className="stories-row-wrap">
      <div className="stories-row" aria-label="Friends online now">
        {visible.map((f) => {
          const inRoom = f.status === 'in-room' && f.room;
          const firstName = (f.name || 'Friend').split(' ')[0];
          const inner = (
            <>
              <Avatar user={f} size="md" className={`story-avatar${inRoom ? ' story-in-room' : ''}`} />
              <span className="story-name">{firstName}</span>
              {inRoom && <span className="story-room">{f.room.name}</span>}
            </>
          );
          return inRoom ? (
            <button
              key={f.id}
              type="button"
              className="story"
              onClick={() => joinFriendRoom(f)}
              disabled={joining === f.id}
              aria-label={`Join ${f.name} in ${f.room.name}`}
            >
              {inner}
            </button>
          ) : (
            <span key={f.id} className="story story--online" title={`${f.name} is online`}>
              {inner}
            </span>
          );
        })}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
