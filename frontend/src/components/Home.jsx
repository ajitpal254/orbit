import React, { useEffect, useState, useCallback } from 'react';
import { apiJson, getInvites, acceptInvite, declineInvite } from '../api';
import { ACCENTS } from '../accents';
import { initials } from '../orbLayout';

export default function Home({ user, onJoin, refreshTick }) {
  const [rooms, setRooms] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [accent, setAccent] = useState('violet');
  const [isPrivate, setIsPrivate] = useState(false);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setRooms(await apiJson('/api/rooms'));
    } catch {}
    try {
      setInvites(await getInvites());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000); // live occupancy refresh
    return () => clearInterval(t);
  }, [load]);

  // Socket pushes (friend request / room invite) bump refreshTick in App.
  useEffect(() => {
    if (refreshTick > 0) load();
  }, [refreshTick, load]);

  const createRoom = async (e) => {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const room = await apiJson('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, topic, accent, isPrivate })
      });
      setName('');
      setTopic('');
      setIsPrivate(false);
      setShowCreate(false);
      onJoin(room);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const answerInvite = async (invite, accept) => {
    try {
      if (accept) {
        await acceptInvite(invite.id);
        const room = await apiJson(`/api/rooms/${invite.room.id}`);
        onJoin(room);
      } else {
        await declineInvite(invite.id);
      }
      setInvites((prev) => prev.filter((i) => i.id !== invite.id));
    } catch (err) {
      setError(err.message);
    }
  };

  const live = rooms.filter((r) => r.occupantCount > 0);
  const quiet = rooms.filter((r) => r.occupantCount === 0);

  return (
    <div className="view view-anim">
      <div className="greeting">
        <p className="date-line">Your orbit</p>
        <h2>Hey, {user.name ? user.name.split(' ')[0] : 'friend'} 👋</h2>
        <p className="muted">
          {live.length > 0
            ? `${live.reduce((s, r) => s + r.occupantCount, 0)} friend${live.reduce((s, r) => s + r.occupantCount, 0) === 1 ? '' : 's'} talking right now`
            : 'No one is talking right now — start a room.'}
        </p>
      </div>

      <button className="btn btn-primary btn-block" onClick={() => setShowCreate((v) => !v)}>
        {showCreate ? '✕ Cancel' : '＋ New room'}
      </button>

      {showCreate && (
        <form className="card create-card" onSubmit={createRoom}>
          <input
            placeholder="Room name — e.g. Late Night" required
            value={name} onChange={(e) => setName(e.target.value)}
          />
          <input
            placeholder="Topic (optional) — what's this room about?"
            value={topic} onChange={(e) => setTopic(e.target.value)}
          />
          <div className="accent-picker">
            {ACCENTS.map((a) => (
              <button
                type="button"
                key={a.id}
                className={`accent-swatch ${accent === a.id ? 'selected' : ''}`}
                style={{ background: `linear-gradient(135deg, ${a.from}, ${a.to})` }}
                onClick={() => setAccent(a.id)}
                title={a.name}
                aria-label={a.name}
              />
            ))}
          </div>
          <div className="privacy-toggle" role="group" aria-label="Room privacy">
            <button
              type="button"
              className={!isPrivate ? 'selected' : ''}
              onClick={() => setIsPrivate(false)}
            >
              🌐 Public
            </button>
            <button
              type="button"
              className={isPrivate ? 'selected' : ''}
              onClick={() => setIsPrivate(true)}
            >
              🔒 Private
            </button>
          </div>
          {isPrivate && (
            <p className="muted privacy-hint">
              Only people you invite can see or join this room. Invite friends from inside the room.
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" disabled={creating}>
            {creating ? 'Creating…' : 'Create & drop in'}
          </button>
        </form>
      )}

      {loading && <p className="muted">Finding rooms…</p>}

      {invites.length > 0 && (
        <section>
          <h3 className="section-title">✉️ Room invites</h3>
          <div className="people-list">
            {invites.map((invite, i) => (
              <div key={invite.id} className="person-row stagger-in" style={{ animationDelay: `${i * 40}ms` }}>
                <span className="mini-orb person-orb">🔒</span>
                <span className="person-info">
                  <strong>{invite.room?.name || 'A room'}</strong>
                  <span className="muted person-email">
                    {invite.inviter?.name || 'Someone'} invited you
                    {invite.room?.isPrivate ? ' · private' : ''}
                  </span>
                </span>
                <span className="row-actions">
                  <button
                    className="btn btn-primary btn-small"
                    onClick={() => answerInvite(invite, true)}
                  >
                    Join
                  </button>
                  <button
                    className="btn btn-text btn-small"
                    onClick={() => answerInvite(invite, false)}
                  >
                    Decline
                  </button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {!loading && rooms.length === 0 && (
        <div className="empty-state">
          <span className="big-emoji">🪐</span>
          <p className="muted">No rooms yet.<br />Create the first one and invite your friends.</p>
        </div>
      )}

      {live.length > 0 && (
        <section>
          <h3 className="section-title"><span className="live-dot" /> Live now</h3>
          <div className="room-list">
            {live.map((room, i) => (
              <RoomCard key={room.id} room={room} index={i} onJoin={onJoin} />
            ))}
          </div>
        </section>
      )}

      {quiet.length > 0 && (
        <section>
          <h3 className="section-title">Rooms</h3>
          <div className="room-list">
            {quiet.map((room, i) => (
              <RoomCard key={room.id} room={room} index={i} onJoin={onJoin} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function RoomCard({ room, index, onJoin }) {
  const a = room.accent || {};
  const speaking = room.occupants?.some((o) => o.speaking);
  return (
    <button
      className="room-card stagger-in"
      onClick={() => onJoin(room)}
      style={{ '--room-from': a.from || '#8b5cf6', '--room-to': a.to || '#d946ef', animationDelay: `${(index || 0) * 50}ms` }}
    >
      <div className="room-card-top">
        <div>
          <strong className="room-name">
            {room.isPrivate && <span className="lock-badge" title="Private room">🔒 </span>}
            {room.name}
          </strong>
          {room.topic && <p className="room-topic">{room.topic}</p>}
        </div>
        {room.occupantCount > 0 && (
          <span className="room-count">
            <span className={`count-dot ${speaking ? 'speaking' : ''}`} />
            {room.occupantCount} in room
          </span>
        )}
      </div>
      <div className="room-occupants">
        {room.occupants?.slice(0, 5).map((o) => (
          <span
            key={o.userId}
            className={`mini-orb ${o.speaking ? 'speaking' : ''}`}
            title={o.name}
          >
            {initials(o.name)}
          </span>
        ))}
        {room.occupantCount === 0 && <span className="muted room-empty">Empty — be the first in</span>}
        {room.occupantCount > 5 && <span className="muted">+{room.occupantCount - 5}</span>}
      </div>
      {room.isPrivate && (
        <p className="room-private-line">
          Private · {room.memberCount ?? 0} member{(room.memberCount ?? 0) === 1 ? '' : 's'}
        </p>
      )}
    </button>
  );
}
