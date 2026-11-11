import React, { useEffect, useState, useCallback, useLayoutEffect, useRef, useReducer } from 'react';
import { apiFetch, apiJson, getDms, getFriends, getNotifications } from './api';
import { getSocket, disconnectSocket } from './socket';
import { playJoinSound, playMuteSound } from './sounds';
import { voiceSessionReducer, initialVoiceSessionState } from './voiceSession';
import MiniPlayer from './components/MiniPlayer';
import MobileTabBar from './components/MobileTabBar';
import { onUpdateAvailable, applyUpdate } from './pwa';
import { parseDeepLinkHash } from './deepLink';
import Auth from './components/Auth';
import Home from './components/Home';
import RoomView from './components/RoomView';
import Friends from './components/Friends';
import DirectMessages from './components/DirectMessages';
import Profile from './components/Profile';
import About from './components/About';
import Notifications from './components/Notifications';
import Avatar from './components/Avatar';
import IconRail from './components/IconRail';
import Splash from './components/Splash';
import UpdateToast from './components/UpdateToast';
import LockedRoom from './components/LockedRoom';
import { Icon } from './components/icons';

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
  // A private room the user is not a member of, opened from a link /
  // deep link / push tap: the locked-room screen with a knock button,
  // instead of a silent bounce to the rooms list. { id, name } — the
  // locked stub the server returns with the private-room 403.
  const [lockedRoom, setLockedRoom] = useState(null);
  // Whether the room view itself is on screen. The voice session is
  // keyed off `room`, not this flag: navigating to another view hides
  // the room (RoomView stays mounted, so the call keeps running) and
  // the mini-player takes over until you tap back in.
  const [inRoom, setInRoom] = useState(false);
  // The voice session (mute / deafen / moderator-mute / call start)
  // lives here, above the view switch, so the room view's voice bar
  // and the mini-player read and control the same session.
  const [session, dispatchSession] = useReducer(voiceSessionReducer, initialVoiceSessionState);
  // The VoiceEngine instance, created by RoomView. App needs it so the
  // mini-player's mute button can toggle the live session while the
  // room view is hidden; RoomView clears it when the session ends.
  const voiceEngineRef = useRef(null);
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
    // Knock traffic: a knock on my room (answer it from the members
    // panel), and the answer to my knock (admitted → the room appears
    // in my list; declined → my pending state clears).
    socket.on('knock-received', onNotify);
    socket.on('knock-admitted', onNotify);
    socket.on('knock-declined', onNotify);
    return () => {
      socket.off('friend-request', onNotify);
      socket.off('room-invite', onNotify);
      socket.off('friend-accepted', onNotify);
      socket.off('dm-message', onNotify);
      socket.off('knock-received', onNotify);
      socket.off('knock-admitted', onNotify);
      socket.off('knock-declined', onNotify);
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

  const openDm = useCallback((friend) => {
    setDmUser(friend);
    setView('messages');
    setInRoom(false);
  }, []);

  // Joining a room starts the voice session (RoomView mounts and its
  // engine joins); leaving it ends the session. Navigating between
  // views never touches either — that is the whole point.
  const joinRoom = useCallback((r) => {
    setLockedRoom(null);
    if (room?.id === r.id) {
      // Already in this room's session — just show the room again
      // instead of restarting the call timer and resetting mute.
      setView('rooms');
      setInRoom(true);
      return;
    }
    setRoom(r);
    setInRoom(true);
    setView('rooms');
    dispatchSession({ type: 'join', joinedAt: Date.now() });
  }, [room]);

  const leaveRoom = useCallback(() => {
    setRoom(null);
    setLockedRoom(null);
    setInRoom(false);
    dispatchSession({ type: 'leave' });
  }, []);

  // Navigate to a view without dropping the call: the room view hides,
  // RoomView stays mounted, and the mini-player appears.
  const goTo = useCallback((v) => {
    setLockedRoom(null);
    setView(v);
    setInRoom(false);
  }, []);

  const returnToRoom = useCallback(() => {
    setView('rooms');
    setInRoom(true);
  }, []);

  // A notification row was tapped: jump to the right place. A room
  // invite opens that room directly (falling back to the rooms list
  // when the room is gone or no longer visible); a DM opens the
  // thread; everything else lands on the Friends tab.
  // NOTE: this must stay below joinRoom/goTo — its dependency array
  // ([joinRoom, goTo]) is evaluated on the first render, so if either
  // were declared after it, the app would crash with
  // "Cannot access ... before initialization". That is exactly what
  // the v0.2.0 merge did; see tests/appCallbackOrder.test.mjs.
  const handleNotifNavigate = useCallback(async (target) => {
    if (target.view === 'rooms' && target.roomId) {
      try {
        const room = await apiJson(`/api/rooms/${target.roomId}`);
        joinRoom(room);
        return;
      } catch (err) {
        // A private room I am not a member of (a knock notification's
        // room is one I own, so this is the invite/gone case — but a
        // stale knock target can land here too): show the locked-room
        // screen with its knock button instead of bouncing silently.
        if (err.room) {
          setLockedRoom(err.room);
          setView('rooms');
          setInRoom(false);
          return;
        }
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
      goTo('messages');
      return;
    }
    goTo(target.view === 'friends' ? 'friends' : 'rooms');
  }, [joinRoom, goTo]);

  // Mini-player mute: same session, same engine, same sound as the
  // room view's voice bar — RoomView mirrors the state onto my orb.
  const toggleMute = useCallback(() => {
    if (session.modMuted) return;
    const next = !session.muted;
    voiceEngineRef.current?.setMuted(next);
    dispatchSession({ type: 'set-muted', muted: next });
    playMuteSound(next);
  }, [session.muted, session.modMuted]);

  // Update toast: subscribe once; pwa.js replays the event if a new
  // version was already waiting before this mounted.
  useEffect(() => onUpdateAvailable(() => setUpdateAvailable(true)), []);

  // Deep links from push taps: the service worker opens the app at
  // /#friends, /#room-<id>, /#dm-<userId> or /#notifications. Read the
  // hash once the user is known (room/DM targets need auth + a fetch),
  // and on hashchange for taps while a tab is already open (the SW
  // navigates that tab in place instead of opening a new one).
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const handleHash = async () => {
      const target = parseDeepLinkHash(window.location.hash || '');
      if (!target) return;
      // Consume the hash so a reload doesn't re-navigate.
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      if (target.view === 'rooms' && target.roomId) {
        try {
          const room = await apiJson(`/api/rooms/${target.roomId}`);
          if (!cancelled) joinRoom(room);
        } catch (err) {
          // A private room I am not a member of: the locked-room
          // screen (with its knock button), not a silent bounce.
          if (!cancelled && err.room) {
            setLockedRoom(err.room);
            setView('rooms');
            setInRoom(false);
          } else if (!cancelled) goTo('rooms');
        }
        return;
      }
      if (target.view === 'messages' && target.dmUserId) {
        try {
          const { friends } = await getFriends();
          const friend = (friends || []).find((f) => String(f.id) === String(target.dmUserId));
          if (!cancelled && friend) {
            setDmUser(friend);
            goTo('messages');
            return;
          }
        } catch {}
        if (!cancelled) goTo('messages');
        return;
      }
      if (!cancelled) goTo(target.view);
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => {
      cancelled = true;
      window.removeEventListener('hashchange', handleHash);
    };
  }, [user, joinRoom, goTo]);

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
  }, [view, room, inRoom, measurePill]);

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
    setLockedRoom(null);
    setInRoom(false);
    dispatchSession({ type: 'leave' });
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
    <div className={`app${room && !inRoom ? ' app--in-call' : ''}`}>
      {/* Desktop 3-zone icon rail (hidden below 900px in CSS, and while
          inside a room — same rule as the tab bar it replaces). It is
          a flex sibling of .app-body, so on desktop it docks to the
          left of the content with no fixed-position overlap math.
          Shown when !inRoom (not !room) so it stays usable mid-call,
          like the tabs — goTo never drops the call. */}
      {!inRoom && (
        <IconRail
          user={user}
          view={view}
          dmUnread={dmUnread}
          notifUnread={notifUnread}
          onNavigate={goTo}
        />
      )}
      <div className="app-body">
      <header className="topbar">
        <span className="logo"><Icon name="planet" size={20} /> Orbit</span>
        <span className="topbar-actions">
          <button
            className="icon-btn bell-btn"
            onClick={() => goTo('notifications')}
            aria-label={`Notifications${notifUnread > 0 ? `, ${notifUnread} unread` : ''}`}
          >
            <Icon name="bell" />
            {notifUnread > 0 && (
              <span className="bell-badge">{notifUnread > 9 ? '9+' : notifUnread}</span>
            )}
          </button>
          <button
            className="topbar-avatar"
            onClick={() => goTo('profile')}
            aria-label="Profile"
            title="Profile"
          >
            <Avatar user={user} size="sm" />
          </button>
          <button className="btn btn-text" onClick={logout}>Log out</button>
        </span>
      </header>

      {!inRoom && (view === 'rooms' || view === 'friends' || view === 'messages') && (
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
            onClick={() => goTo('rooms')}
          >
            Rooms
          </button>
          <button
            className={view === 'friends' ? 'active' : ''}
            onClick={() => goTo('friends')}
          >
            Friends
          </button>
          <button
            className={view === 'messages' ? 'active' : ''}
            onClick={() => goTo('messages')}
          >
            Messages
            {dmUnread > 0 && <span className="tab-badge">{dmUnread}</span>}
          </button>
        </nav>
      )}

      <main className="main">
        {room && (
          // The room view stays mounted at this one spot while a call is
          // active — hiding it (display: none) instead of unmounting it
          // is what keeps the voice session alive while you browse
          // another view. Only Leave (or logout / kick) unmounts it.
          <div className={inRoom ? undefined : 'room-view-hidden'} aria-hidden={!inRoom || undefined}>
            <RoomView
              key={room.id}
              user={user}
              room={room}
              onLeave={leaveRoom}
              session={session}
              dispatchSession={dispatchSession}
              voiceEngineRef={voiceEngineRef}
            />
          </div>
        )}
        {(!room || !inRoom) && (view === 'friends' ? (
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
          <Profile user={user} onSaved={setUser} onOpenAbout={() => goTo('about')} />
        ) : view === 'about' ? (
          <About onBack={() => goTo('rooms')} />
        ) : view === 'notifications' ? (
          <Notifications
            refreshTick={refreshTick}
            onNavigate={handleNotifNavigate}
            onBack={() => goTo('rooms')}
            onRead={() => setRefreshTick((t) => t + 1)}
          />
        ) : lockedRoom ? (
          <LockedRoom
            room={lockedRoom}
            onJoined={joinRoom}
            onBack={() => setLockedRoom(null)}
          />
        ) : (
          <Home user={user} onJoin={joinRoom} refreshTick={refreshTick} onOpenAbout={() => goTo('about')} onNavigate={handleNotifNavigate} notifUnread={notifUnread} onOpenNotifications={() => goTo('notifications')} />
        ))}
      </main>
      </div>

      {room && !inRoom && (
        <MiniPlayer
          roomName={room.name}
          joinedAt={session.joinedAt}
          muted={session.muted}
          modMuted={session.modMuted}
          onToggleMute={toggleMute}
          onReturn={returnToRoom}
        />
      )}

      {/* Phone bottom tab bar (M2): the top .view-tabs are gone ≤520px,
          so this floating pill is the section nav there. Hidden inside
          an open room view (!inRoom) — the voice bar owns the bottom
          there — and hidden above 520px in CSS (tablets keep the top
          tabs, desktop keeps the icon rail). */}
      {!inRoom && (
        <MobileTabBar view={view} dmUnread={dmUnread} onNavigate={goTo} />
      )}

      {updateAvailable && (
        <UpdateToast onUpdate={() => applyUpdate()} onDismiss={() => setUpdateAvailable(false)} />
      )}
    </div>
  );
}
