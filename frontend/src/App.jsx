import React, { useEffect, useState } from 'react';
import { apiFetch, apiJson } from './api';
import { disconnectSocket } from './socket';
import Auth from './components/Auth';
import Home from './components/Home';
import RoomView from './components/RoomView';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [room, setRoom] = useState(null);

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

  const logout = async () => {
    try {
      await apiJson('/api/auth/logout', { method: 'POST' });
    } catch {}
    disconnectSocket();
    setRoom(null);
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

      <main className="main">
        {room ? (
          <RoomView key={room.id} user={user} room={room} onLeave={() => setRoom(null)} />
        ) : (
          <Home user={user} onJoin={setRoom} />
        )}
      </main>
    </div>
  );
}
