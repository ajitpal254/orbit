import React, { useEffect, useState, useCallback, useLayoutEffect, useRef } from 'react';
import { apiFetch, apiJson, getDms, getNotifications } from './api';
import { getSocket, disconnectSocket } from './socket';
import { playJoinSound } from './sounds';
import { onUpdateAvailable, applyUpdate } from './pwa';
import Auth from './components/Auth';
import Home from './components/Home';
import RoomView from './components/RoomView';
import Friends from './components/Friends';
import DirectMessages from './components/DirectMessages';
import Profile from './components/Profile';
import About from './components/About';
import Notifications from './components/Notifications';
import Avatar from './components/Avatar';
import Splash from './components/Splash';
import UpdateToast from './components/UpdateToast';

// Boot timeout per /api/auth/me attempt. Render's free tier sleeps when
// idle, so a cold start can take 30–60s — the attempts below ride that
// out, and the splash screen explains the wait instead of spinning
// silently forever.
const BOOT_TIMEOUT_MS = 20000;
const BOOT_ATTEMPTS = 3;

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [bootError, setBootError] = useState('');
  const [bootKey, setBootKey] = useState(0); // bump to re-run the boot check
  const [room, setRoom] = useState(null);
  const [view, setView] = useState('rooms'); // 'rooms' | 'friends' | 'messages' | 'profile' | 'about' | 'notifications'
  // Bumped whenever a friend request / room invite / DM arrives over the
  // socket, so Home (invites), Friends (requests) and Messages refresh live.
  const [refreshTick, setRefreshTick] = useState(0);
  // Friend whose DM thread should open (set by Friends "Message").
  const [dmUser, setDmUser] = useState(null);
  const [dmUnread, setDmUnread] = useState(0);
  // Unread notification count, for the bell badge. Refreshed on the
  // same tick as the lists, so marking one read clears the badge live.
  const [notifUnread, setNotifUnread] = useState(0);
  // A new app version is waiting in the service worker (see pwa.js).
  // Shown as a toast; the app never auto-reloads for it.
  const [updateAvailable, setUpdateAvailable] = useState(false);
  // Sliding tab pill: measured from the active tab button (offsetLeft /
  // offsetWidth) instead of CSS calc, so it tracks the active tab
  // exactly on every width and font.
  const tabsRef = useRef(null);
  const [pillStyle, setPillStyle] = useState(null);

  // Bootstrap the CSRF cookie so login/register POSTs pass the
  // double-submit check, then check for an existing session.
  // (Calorie-Tracker lesson: without this fetch, first signup 403s.)
  // The /api/auth/me check has a timeout and retries: without them a
  // slow cold start left the app on "Loading…" forever.
  useEffect(() => {
    apiFetch('/api/auth/csrf-token').catch(() => {});
    let cancelled = false;
    const boot = async () => {
      for (let attempt = 0; attempt < BOOT_ATTEMPTS; attempt += 1) {
        const ctrl = new AbortController();
        const timer = window.setTimeout(() => ctrl.abort(), BOOT_TIMEOUT_MS);
        try {
          const r = await apiFetch('/api/auth/me', { signal: ctrl.signal });
          const d = r.ok ? await r.json().catch(() => null) : null;
          if (!cancelled) {
            setUser(d ? d.user : null);
            setBootError('');
          }
          return;
        } catch {
          // Timed out or unreachable — retry below (unless out of attempts).
        } finally {
          window.clearTimeout(timer);
        }
        if (attempt < BOOT_ATTEMPTS - 1) {
          await new Promise((res) => window.setTimeout(res, 1000 * (attempt + 1)));
        }
      }
      if (!cancelled) {
        setUser(null);
        setBootError('Could not reach the server — it may still be waking up. Check your connection and try again.');
      }
    };
    boot().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [bootKey]);

  const retryBoot = useCallback(() => {
    setBootError('');
    setLoading(true);
    setBootKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    const onNotify = () => {
      // Same chime as someone joining a room — a friend request, a room
      // invite, or a DM is worth the same nudge.
      playJoinSound();
      setRefreshTick((t) => t + 1);
    };
    socket.on('friend-request', onNotify);
    socket.on('room-invite', onNotify);
    socket.on('friend-accepted', onNotify);
    socket.on('dm-message', onNotify);
    return () => {
      socket.off('friend-request', onNotify);
      socket.off('room-invite', onNotify);
      socket.off('friend-accepted', onNotify);
      socket.off('dm-message', onNotify);
    };
  }, [user]);

  // Total unread DMs, for the Messages tab badge. Refreshed on the same
  // tick as the lists, so opening a thread clears its badge live.
  useEffect(() => {
    if (!user) {
      setDmUnread(0);
      return;
    }
    let cancelled = false;
    getDms()
      .then((list) => {
        if (cancelled) return;
        setDmUnread((list || []).reduce((n, c) => n + (c.unreadCount || 0), 0));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user, refreshTick]);

  // Unread notifications, for the bell badge in the topbar.
  useEffect(() => {
    if (!user) {
      setNotifUnread(0);
      return;
    }
    let cancelled = false;
    getNotifications(1, 0)
      .then((d) => {
        if (!cancelled) setNotifUnread(d.unreadCount || 0);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [user, refreshTick]);

  // A notification row was tapped: jump to the right place. A room
  // invite opens that room directly (falling back to the rooms list
  // when the room is gone or no longer visible); a DM opens the
  // thread; everything else lands on the Friends tab.
  const handleNotifNavigate = useCallback(async (target) => {
    if (target.view === 'rooms' && target.roomId) {
      try {
        const room = await apiJson(`/api/rooms/${target.roomId}`);
        setRoom(room);
        return;
      } catch {
        // Fall through to the rooms list below.
      }
    }
    if (target.view === 'messages' && target.dmUser) {
      setDmUser({
        id: target.dmUser.id,
        name: target.dmUser.name,
        email: target.dmUser.email,
        avatarPreset: target.dmUser.avatarPreset,
        avatarImage: target.dmUser.avatarImage
      });
      setView('messages');
      return;
    }
    setView(target.view === 'friends' ? 'friends' : 'rooms');
  }, []);

  const openDm = useCallback((friend) => {
    setDmUser(friend);
    setView('messages');
  }, []);

  // Update toast: subscribe once; pwa.js replays the event if a new
  // version was already waiting before this mounted.
  useEffect(() => onUpdateAvailable(() => setUpdateAvailable(true)), []);

  // Measure the sliding tab pill from the active tab button. Runs on
  // mount / tab change / room enter-leave (the nav mounts when leaving
  // a room) and whenever the layout can shift under it (resize, fonts).
  const measurePill = useCallback(() => {
    const nav = tabsRef.current;
    if (!nav) return;
    const active = nav.querySelector('button.active');
    if (!active) return;
    setPillStyle({ left: active.offsetLeft, width: active.offsetWidth });
  }, []);

  useLayoutEffect(() => {
    measurePill();
  }, [view, room, measurePill]);

  useEffect(() => {
    window.addEventListener('resize', measurePill);
    if (document.fonts?.ready) document.fonts.ready.then(measurePill).catch(() => {});
    return () => window.removeEventListener('resize', measurePill);
  }, [measurePill]);

  const logout = async () => {
    try {
      await apiJson('/api/auth/logout', { method: 'POST' });
    } catch {}
    disconnectSocket();
    setRoom(null);
    setView('rooms');
    setDmUser(null);
    setDmUnread(0);
    setNotifUnread(0);
    setUser(null);
  };

  if (loading) {
    // Remount the splash per boot attempt so its elapsed timer restarts.
    return <Splash key={bootKey} onRetry={retryBoot} />;
  }

  if (!user) {
    return (
      <>
        <Auth onAuth={setUser} notice={bootError} onRetry={bootError ? retryBoot : undefined} />
        {updateAvailable && (
          <UpdateToast onUpdate={() => applyUpdate()} onDismiss={() => setUpdateAvailable(false)} />
        )}
      </>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">🪐 Orbit</span>
        <span className="topbar-actions">
          <button
            className="icon-btn bell-btn"
            onClick={() => setView('notifications')}
            aria-label={`Notifications${notifUnread > 0 ? `, ${notifUnread} unread` : ''}`}
          >
            🔔
            {notifUnread > 0 && (
              <span className="bell-badge">{notifUnread > 9 ? '9+' : notifUnread}</span>
            )}
          </button>
          <button
            className="topbar-avatar"
            onClick={() => setView('profile')}
            aria-label="Profile"
            title="Profile"
          >
            <Avatar user={user} size="sm" />
          </button>
          <button className="btn btn-text" onClick={logout}>Log out</button>
        </span>
      </header>

      {!room && (view === 'rooms' || view === 'friends' || view === 'messages') && (
        <nav
          className="view-tabs"
          aria-label="Sections"
          ref={tabsRef}
        >
          <span
            className="tab-indicator"
            aria-hidden="true"
            style={pillStyle ? { left: 0, width: pillStyle.width, transform: `translateX(${pillStyle.left}px)` } : undefined}
          />
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
          <button
            className={view === 'messages' ? 'active' : ''}
            onClick={() => setView('messages')}
          >
            Messages
            {dmUnread > 0 && <span className="tab-badge">{dmUnread}</span>}
          </button>
        </nav>
      )}

      <main className="main">
        {room ? (
          <RoomView key={room.id} user={user} room={room} onLeave={() => setRoom(null)} />
        ) : view === 'friends' ? (
          <Friends refreshTick={refreshTick} onMessage={openDm} />
        ) : view === 'messages' ? (
          <DirectMessages
            user={user}
            refreshTick={refreshTick}
            dmUser={dmUser}
            clearDmUser={() => setDmUser(null)}
            onMessagesRead={() => setRefreshTick((t) => t + 1)}
          />
        ) : view === 'profile' ? (
          <Profile user={user} onSaved={setUser} onOpenAbout={() => setView('about')} />
        ) : view === 'about' ? (
          <About onBack={() => setView('rooms')} />
        ) : view === 'notifications' ? (
          <Notifications
            refreshTick={refreshTick}
            onNavigate={handleNotifNavigate}
            onBack={() => setView('rooms')}
            onRead={() => setRefreshTick((t) => t + 1)}
          />
        ) : (
          <Home user={user} onJoin={setRoom} refreshTick={refreshTick} onOpenAbout={() => setView('about')} />
        )}
      </main>

      {updateAvailable && (
        <UpdateToast onUpdate={() => applyUpdate()} onDismiss={() => setUpdateAvailable(false)} />
      )}
    </div>
  );
}
