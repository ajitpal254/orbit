import React, { useEffect, useState } from 'react';
import { apiFetch, apiJson } from './api';
import { getSocket, disconnectSocket } from './socket';
import { playJoinSound } from './sounds';
import Auth from './components/Auth';
import Home from './components/Home';
import RoomView from './components/RoomView';
import Friends from './components/Friends';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [room, setRoom] = useState(null);
  const [view, setView] = useState('rooms'); // 'rooms' | 'friends'
  // Bumped whenever a friend request / room invite arrives over the
  // socket, so Home (invites) and Friends (requests) refresh live.
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    // Bootstrap the CSRF cookie so login/register POSTs pass the
    // double-submit check, then check for an existing session.
    // (Calorie-Tracker lesson: without this fetch, first signup 403s.)
    apiFetch('/api/auth/csrf-token').catch(() => {});
    apiFetch('/api/auth/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setUser(d ? d.user : null))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    const onNotify = () => {
      // Same chime as someone joining a room — a friend request or a
      // room invite is worth the same nudge.
      playJoinSound();
      setRefreshTick((t) => t + 1);
    };
    socket.on('friend-request', onNotify);
    socket.on('room-invite', onNotify);
    socket.on('friend-accepted', onNotify);
    return () => {
      socket.off('friend-request', onNotify);
      socket.off('room-invite', onNotify);
      socket.off('friend-accepted', onNotify);
    };
  }, [user]);

  const logout = async () => {
    try {
      await apiJson('/api/auth/logout', { method: 'POST' });
    } catch {}
    disconnectSocket();
    setRoom(null);
    setView('rooms');
    setUser(null);
  };

  if (loading) {
    return (
      <div className="auth-wrap">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (!user) return <Auth onAuth={setUser} />;

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">🪐 Orbit</span>
        <button className="btn btn-text" onClick={logout}>Log out</button>
      </header>

      {!room && (
        <nav className="view-tabs" aria-label="Sections">
          <button
            className={view === 'rooms' ? 'active' : ''}
            onClick={() => setView('rooms')}
          >
            Rooms
          </button>
          <button
            className={view === 'friends' ? 'active' : ''}
            onClick={() => setView('friends')}
          >
            Friends
          </button>
        </nav>
      )}

      <main className="main">
        {room ? (
          <RoomView key={room.id} user={user} room={room} onLeave={() => setRoom(null)} />
        ) : view === 'friends' ? (
          <Friends refreshTick={refreshTick} />
        ) : (
          <Home user={user} onJoin={setRoom} refreshTick={refreshTick} />
        )}
      </main>
    </div>
  );
}
