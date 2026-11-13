// Constellation strip (v0.9.0 density): a horizontal row of friend
// avatars above the hero card, on desktop only (hidden below 1280px
// in CSS). Reuses the GET /api/friends/presence rows Home already
// fetches and shares with the night sky and the side panel — no new
// fetch, no new endpoint. The presence endpoint already sorts
// in-room first, then online, then away (see lib/friendPresence.js),
// and never leaks a room the viewer cannot see, so this strip just
// renders that order.
//
//   glowing ring = in a room — click drops into their room, via the
//     same GET /api/rooms/:id + onJoin(room) path NightSky uses.
//   steady ring = online; dim = away/offline — click opens Friends.
//   status is also written as text under the name, never colour alone.
// Renders nothing with no friends (the Home empty state covers that)
// or while presence is still loading.
import React, { useState } from 'react';
import { apiJson } from '../api';
import Avatar from './Avatar';

const statusText = (friend) => {
  if (friend.status === 'in-room' && friend.room) return `In ${friend.room.name}`;
  if (friend.status === 'online') return 'Online';
  return 'Away';
};

export default function ConstellationStrip({ friends, onJoin, onNavigate }) {
  const [joining, setJoining] = useState(null);
  const [joinError, setJoinError] = useState('');

  if (!friends || friends.length === 0) return null;

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
    if (friend.status === 'in-room' && friend.room) {
      joinFriendRoom(friend);
    } else if (onNavigate) {
      onNavigate({ view: 'friends' });
    }
  };

  return (
    <section className="constellation-strip" aria-label="Friends in your orbit">
      <div className="constellation-row">
        {friends.map((friend) => {
          const firstName = (friend.name || 'Friend').split(' ')[0];
          const inRoom = friend.status === 'in-room' && friend.room;
          return (
            <button
              key={friend.id}
              type="button"
              className={`constellation-orb constellation-orb--${friend.status}`}
              onClick={() => openFriend(friend)}
              disabled={joining === friend.id}
              aria-label={inRoom ? `${friend.name} — in ${friend.room.name}, drop in` : `${friend.name} — ${statusText(friend)}`}
              title={inRoom ? `${friend.name} — in ${friend.room.name}` : `${friend.name} — ${statusText(friend)}`}
            >
              <Avatar user={friend} size="sm" />
              <span className="constellation-name">{firstName}</span>
              <span className="constellation-status">{statusText(friend)}</span>
            </button>
          );
        })}
      </div>
      {joinError && <p className="error constellation-error">{joinError}</p>}
    </section>
  );
}
