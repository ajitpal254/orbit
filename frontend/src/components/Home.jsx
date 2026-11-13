import React, { useEffect, useState, useCallback } from 'react';
import { apiJson, getInvites, acceptInvite, declineInvite, getFriendsPresence, getMyActivity, joinRoom as joinRoomPreflight } from '../api';
import { getSocket } from '../socket';
import { ACCENTS } from '../accents';
import { initials } from '../orbLayout';
import { selectBusiestRoom } from '../desktop';
import { quietRooms } from '../activityStats';
import { formatBadgeCount } from '../mobileNav';
import StoriesRow from './StoriesRow';
import HeroCard from './HeroCard';
import NightSky from './NightSky';
import SidePanel from './SidePanel';
import ConstellationStrip from './ConstellationStrip';
import StreakStrip from './StreakStrip';
import { Icon } from './icons';

// Build version (Vite define from package.json, see vite.config.js).
// Guarded so the file doesn't break if the define is ever missing.
// Shared with the About section, which displays the same beta number.
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

// Room cap (v0.7.0): rooms hold at most 8 people — keep in sync with
// MAX_ROOM_OCCUPANTS in lib/roomCap.js. The list's occupantCount can
// go stale, so this only decides when to pre-flight; the server is
// still the gate, and RoomView shows the full-room card on a race.
const ROOM_CAP = 8;

export default function Home({ user, onJoin, refreshTick, onOpenAbout, onNavigate, notifUnread, onOpenNotifications }) {
  const [rooms, setRooms] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [accent, setAccent] = useState('violet');
  const [isPrivate, setIsPrivate] = useState(false);
  // Together mode: 'talk' is a normal voice room, 'focus' is a quiet
  // room with a shared focus timer. Defaults to talk; the owner or a
  // moderator can switch it later from inside the room.
  const [mode, setMode] = useState('talk');
  // Campfire (fading room): on by default — the playbook makes rooms
  // temporary by default, and the owner can keep one anytime. The
  // server only treats an explicit true as ephemeral, so this toggle
  // is the only thing that ever creates one.
  const [isCampfire, setIsCampfire] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  // Friend presence, fetched ONCE here and shared by the night sky and
  // the desktop side panel — one GET /api/friends/presence for both,
  // never two. Only a successful fetch replaces the list, so a failed
  // refresh (offline included) keeps the last-known sky and NightSky
  // says so instead of flashing empty. `presenceError` is '' on success.
  const [presence, setPresence] = useState(null);
  const [presenceError, setPresenceError] = useState('');
  // My activity this week (streak strip, v0.9.0): one GET
  // /api/me/activity, loaded on mount and on socket pushes. A failed
  // fetch keeps null, so StreakStrip says it could not load instead
  // of claiming a quiet week.
  const [activity, setActivity] = useState(null);
  const [activityLoading, setActivityLoading] = useState(true);

  const loadActivity = useCallback(async () => {
    try {
      setActivity(await getMyActivity());
    } catch {
      setActivity(null);
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    loadActivity();
  }, [loadActivity]);

  // Socket pushes (friend request / room invite) bump refreshTick in App.
  useEffect(() => {
    if (refreshTick > 0) loadActivity();
  }, [refreshTick, loadActivity]);

  const loadPresence = useCallback(async () => {
    try {
      setPresence(await getFriendsPresence());
      setPresenceError('');
    } catch (err) {
      setPresenceError(err.message || 'Could not load presence');
    }
  }, []);

  useEffect(() => {
    loadPresence();
    // Same 5s cadence SidePanel used to poll on its own.
    const t = setInterval(loadPresence, 5000);
    return () => clearInterval(t);
  }, [loadPresence]);

  // Socket pushes (friend request / room invite) bump refreshTick in App.
  useEffect(() => {
    if (refreshTick > 0) loadPresence();
  }, [refreshTick, loadPresence]);

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
    // Slow fallback poll only — the list refreshes live from the
    // server's `rooms-changed` socket push (join / leave / create /
    // delete, see lib/socket.js), so the old 5s poll is gone.
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const socket = getSocket();
    const onRoomsChanged = () => load();
    socket.on('rooms-changed', onRoomsChanged);
    return () => { socket.off('rooms-changed', onRoomsChanged); };
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
        body: JSON.stringify({ name, topic, accent, isPrivate, ephemeral: isCampfire, mode })
      });
      setName('');
      setTopic('');
      setIsPrivate(false);
      setIsCampfire(true);
      setMode('talk');
      setShowCreate(false);
      onJoin(room);
    } catch (err) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  // Dashed "+ New room" card (desktop polish): opens the existing
  // create-room form — no new flow, just setShowCreate(true).
  const openCreate = () => setShowCreate(true);

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

  // Room cap (v0.7.0): when the list already shows a room full, ask
  // the server first (POST /api/rooms/:id/join) instead of mounting
  // the room view and being refused on the socket. A slot may have
  // freed since the list loaded, in which case the pre-flight succeeds
  // and the join goes ahead; when it is still full the server's
  // friendly message lands in the home error line. Rooms below the
  // cap join directly — the socket handler enforces the cap there,
  // and RoomView shows the full-room card if a race fills it first.
  const tryJoin = async (room) => {
    setError('');
    if ((room.occupantCount || 0) >= ROOM_CAP) {
      try {
        await joinRoomPreflight(room.id);
      } catch (err) {
        setError(err.message || 'This room is full right now.');
        return;
      }
    }
    onJoin(room);
  };

  const live = rooms.filter((r) => r.occupantCount > 0);
  // Empty rooms split in two on desktop ≥1280px (v0.9.0 density):
  // rooms active within the last 7 days stay in the main "Rooms"
  // list; rooms with no activity in 7 days move to the dimmed
  // "Recently quiet" row below it. See frontend/src/activityStats.js
  // — a room with no lastActiveAt falls back to createdAt, so it is
  // never quiet within its first week. Phones keep the single
  // un-split list (rooms-section--all), so the ≤900px layout is
  // pixel-identical; the split sections are display:none below
  // 1280px and the all-list is display:none at ≥1280px.
  const emptyRooms = rooms.filter((r) => r.occupantCount === 0);
  const recentlyQuiet = quietRooms(rooms);
  const quiet = emptyRooms.filter((r) => !recentlyQuiet.includes(r));
  // The hero room (busiest live room) is also in `live` — the Live-now
  // list hides it on desktop via .room-card--is-hero so it appears
  // once; phones have no hero, so they still list every live room.
  const heroRoom = selectBusiestRoom(rooms);
  const liveOthers = live.filter((r) => r.id !== heroRoom?.id);

  return (
    <div className={`view view-anim home-view${heroRoom ? ' home-view--has-hero' : ''}`}>
      {/* M3: friends stories row (phones only) — online friends at the
          top of Home; tap an in-room friend to join their room. Shares
          Home's single presence fetch with the night sky and the side
          panel (no second GET /api/friends/presence). */}
      <StoriesRow refreshTick={refreshTick} onJoin={tryJoin} friends={presence} />
      <div className="home-head">
      <div className="greeting">
        <p className="date-line">Your orbit</p>
        <h2>Hey, {user.name ? user.name.split(' ')[0] : 'friend'}</h2>
        <p className="muted">
          {live.length > 0
            ? `${live.reduce((s, r) => s + r.occupantCount, 0)} friend${live.reduce((s, r) => s + r.occupantCount, 0) === 1 ? '' : 's'} talking right now`
            : 'No one is talking right now — start a room.'}
        </p>
      </div>

      {/* M2: on phones the bell lives here, in the Home header — the
          topbar bell is hidden ≤520px (see index.css), and the bottom
          tab bar has no notifications tab. Only rendered on phones
          (.home-bell is display:none above 520px). */}
      <button
        className="icon-btn home-bell"
        onClick={() => onOpenNotifications && onOpenNotifications()}
        aria-label={`Notifications${notifUnread > 0 ? `, ${notifUnread} unread` : ''}`}
      >
        <Icon name="bell" />
        {notifUnread > 0 && (
          <span className="bell-badge">{formatBadgeCount(notifUnread)}</span>
        )}
      </button>

      <button className="btn btn-primary btn-block" onClick={() => setShowCreate((v) => !v)}>
        {showCreate ? (<><Icon name="x" size={16} /> Cancel</>) : (<><Icon name="plus" size={16} /> New room</>)}
      </button>
      </div>

      {/* Constellation strip (v0.9.0 density, desktop ≥1280px only):
          friend avatars above the hero, reusing Home's single presence
          fetch — hidden below 1280px in CSS, so phones keep their
          stories row and nothing else changes. */}
      <ConstellationStrip friends={presence} onJoin={tryJoin} onNavigate={onNavigate} />

      {/* Night-sky home: top of Home on phones, and on desktop in
          place of the hero when nobody is live (hasLiveHero hides it
          via CSS ≥900px). The mobile-basics stories row also lands
          here — the coordinator resolves that overlap at merge time. */}
      <NightSky
        friends={presence}
        loading={presence === null && !presenceError}
        error={presenceError}
        onJoin={tryJoin}
        onNavigate={onNavigate}
        onRetry={loadPresence}
        hasLiveHero={!!heroRoom}
      />

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
              <Icon name="globe" size={15} /> Public
            </button>
            <button
              type="button"
              className={isPrivate ? 'selected' : ''}
              onClick={() => setIsPrivate(true)}
            >
              <Icon name="lock" size={15} /> Private
            </button>
          </div>
          {isPrivate && (
            <p className="muted privacy-hint">
              Only people you invite can see or join this room. Invite friends from inside the room.
            </p>
          )}
          <div className="privacy-toggle" role="group" aria-label="Room mode">
            <button
              type="button"
              className={mode !== 'focus' ? 'selected' : ''}
              onClick={() => setMode('talk')}
            >
              <Icon name="chat" size={15} /> Talk
            </button>
            <button
              type="button"
              className={mode === 'focus' ? 'selected' : ''}
              onClick={() => setMode('focus')}
            >
              <Icon name="timer" size={15} /> Focus
            </button>
          </div>
          {mode === 'focus' && (
            <p className="muted privacy-hint">
              A quiet room with a shared focus timer — the owner or a moderator starts it inside.
            </p>
          )}
          <label className="campfire-toggle">
            <input
              type="checkbox"
              checked={isCampfire}
              onChange={(e) => setIsCampfire(e.target.checked)}
            />
            <span><Icon name="flame" size={15} /> Campfire — closes 1 min after the last person leaves</span>
          </label>
          {isCampfire && (
            <p className="muted privacy-hint">
              Temporary by default, so your list stays short without any tidying. The room owner can keep it anytime.
            </p>
          )}
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" disabled={creating}>
            {creating ? 'Creating…' : 'Create & drop in'}
          </button>
        </form>
      )}

      {loading && rooms.length === 0 && (
        <div className="room-list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="room-card skeleton-card">
              <div className="skeleton-line skeleton-title" />
              <div className="skeleton-line skeleton-topic" />
              <div className="skeleton-orbs">
                <span className="skeleton-orb" />
                <span className="skeleton-orb" />
                <span className="skeleton-orb" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Desktop 3-zone hero: the busiest live room. Hidden below 900px
          in CSS, so the phone home screen is untouched. When nobody is
          live the night sky above takes its place — the empty hero
          state is retired, since the sky already carries the quiet
          moment and the header still has New room. */}
      {!loading && heroRoom && (
        <HeroCard
          room={heroRoom}
          onJoin={tryJoin}
          onStartRoom={() => setShowCreate(true)}
          onGoFriends={() => onNavigate && onNavigate({ view: 'friends' })}
        />
      )}

      {/* Streak strip (v0.9.0 density, desktop ≥1280px only): stacked
          under the hero in the bento's right column — hidden below
          1280px in CSS. */}
      <StreakStrip activity={activity} loading={activityLoading} />

      {invites.length > 0 && (
        <section>
          <h3 className="section-title"><Icon name="mail" size={15} /> Room invites</h3>
          <div className="people-list">
            {invites.map((invite, i) => (
              <div key={invite.id} className="person-row stagger-in" style={{ animationDelay: `${i * 40}ms` }}>
                <span className="mini-orb person-orb"><Icon name="lock" size={14} /></span>
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
          <span className="empty-orb" aria-hidden="true" />
          <p className="muted">No rooms yet.<br />Create the first one and invite your friends.</p>
          <button className="btn btn-primary" onClick={() => setShowCreate(true)}>
            Create a room
          </button>
        </div>
      )}

      {live.length > 0 && (
        <section className={liveOthers.length === 0 ? 'live-section--only-hero' : undefined}>
          <h3 className="section-title"><span className="live-dot" /> Live now</h3>
          <div className="room-list">
            {live.map((room, i) => (
              <RoomCard key={room.id} room={room} index={i} onJoin={tryJoin} isHero={heroRoom?.id === room.id} />
            ))}
            {/* Dashed card lives here only when there is no quiet list
                to host it; the live section hides on desktop when the
                hero is the only live room, so no card then either. */}
            {liveOthers.length > 0 && emptyRooms.length === 0 && (
              <NewRoomCard onOpen={openCreate} index={live.length} />
            )}
          </div>
        </section>
      )}

      {/* Phones (and <1280px): the single un-split rooms list, exactly
          as before — hidden at ≥1280px, where the split below takes
          over. Desktop split sections are display:none below 1280px. */}
      {emptyRooms.length > 0 && (
        <section className="rooms-section--all">
          <h3 className="section-title">Rooms</h3>
          <div className="room-list">
            {emptyRooms.map((room, i) => (
              <RoomCard key={room.id} room={room} index={i} onJoin={tryJoin} />
            ))}
            <NewRoomCard onOpen={openCreate} index={emptyRooms.length} />
          </div>
        </section>
      )}

      {/* Desktop ≥1280px split: active empty rooms… */}
      {quiet.length > 0 && (
        <section className="rooms-section--split">
          <h3 className="section-title">Rooms</h3>
          <div className="room-list">
            {quiet.map((room, i) => (
              <RoomCard key={room.id} room={room} index={i} onJoin={tryJoin} />
            ))}
            <NewRoomCard onOpen={openCreate} index={quiet.length} />
          </div>
        </section>
      )}

      {/* Recently quiet (v0.9.0 density): empty rooms with no activity
          in the last 7 days, dimmed — one tap reopens the room. The
          dashed "+ New room" card lives here when the main Rooms list
          is empty, so it is never lost. */}
      {recentlyQuiet.length > 0 && (
        <section className="recently-quiet-section">
          <h3 className="section-title"><Icon name="clock" size={15} /> Recently quiet</h3>
          <div className="room-list">
            {recentlyQuiet.map((room, i) => (
              <RoomCard key={room.id} room={room} index={i} onJoin={tryJoin} isQuiet />
            ))}
            {quiet.length === 0 && (
              <NewRoomCard onOpen={openCreate} index={recentlyQuiet.length} />
            )}
          </div>
        </section>
      )}

      <button className="app-version app-version-btn" onClick={onOpenAbout}>
        Beta v{APP_VERSION} · About Orbit
      </button>

      {/* Desktop 3-zone right column: friends presence + activity.
          Rendered last so the ≥900px grid can place it in column 2
          spanning the rows; hidden below 900px in CSS. */}
      <SidePanel refreshTick={refreshTick} onJoinRoom={tryJoin} onNavigate={onNavigate} friends={presence} />
    </div>
  );
}

// Dashed "+ New room" card appended after the real room cards on
// desktop (Plan v2 §2 fix ②). It opens the existing create-room form
// via onOpen — no new flow. The aria-label is deliberately "Create a
// room", not "+ New room": the smoke test selects the header button
// with getByRole('button', { name: 'New room' }), and Playwright's
// substring name matching would otherwise resolve to two buttons and
// fail strict mode. Visible text stays "+ New room" per the plan.
function NewRoomCard({ onOpen, index }) {
  return (
    <button
      type="button"
      className="room-card room-card--new stagger-in"
      style={{ animationDelay: `${(index || 0) * 50}ms` }}
      onClick={onOpen}
      aria-label="Create a room"
    >
      + New room
    </button>
  );
}

function RoomCard({ room, index, onJoin, isHero, isQuiet }) {
  const a = room.accent || {};
  const speaking = room.occupants?.some((o) => o.speaking);
  return (
    <button
      className={`room-card stagger-in${isHero ? ' room-card--is-hero' : ''}${isQuiet ? ' room-card--quiet' : ''}`}
      onClick={() => onJoin(room)}
      style={{ '--room-from': a.from || '#8b5cf6', '--room-to': a.to || '#d946ef', animationDelay: `${(index || 0) * 50}ms` }}
    >
      <div className="room-card-top">
        <div>
          <strong className="room-name">
            {room.isPrivate && <span className="lock-badge" title="Private room"><Icon name="lock" size={12} /> </span>}
            {room.ephemeral && <span className="campfire-badge" title="Campfire — closes 1 min after the last person leaves"><Icon name="flame" size={12} /> Campfire</span>}
            {room.mode === 'focus' && <span className="focus-badge" title="Focus room — shared focus timer"><Icon name="timer" size={12} /> Focus</span>}
            {room.name}
          </strong>
          {room.topic && <p className="room-topic">{room.topic}</p>}
        </div>
        {room.occupantCount > 0 && (
          <span className="room-count">
            <span className={`count-dot ${speaking ? 'speaking' : ''}`} />
            {room.occupantCount >= ROOM_CAP ? `Full · ${room.occupantCount}/8` : `${room.occupantCount} in room`}
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
