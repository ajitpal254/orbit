import React, { useEffect, useRef, useState, useCallback } from 'react';
import { apiJson, getFriends, getUserAvatars, inviteToRoom, leavePrivateRoom, promoteMember, demoteMember, kickMember, transferOwnership, muteMember } from '../api';
import { getSocket } from '../socket';
import { VoiceEngine } from '../voice';
import { playJoinSound, playMuteSound, playDeafenSound } from '../sounds';
import { orbPositions, initials, orbHue } from '../orbLayout';
import Avatar from './Avatar';

export default function RoomView({ user, room, onLeave }) {
  const [occupants, setOccupants] = useState(() => ({
    self: { socketId: 'self', userId: user.id, name: user.name, muted: false, isSelf: true }
  }));
  const [speaking, setSpeaking] = useState({ selfSpeaking: false, levels: {} });
  const [connState, setConnState] = useState({});
  const [iceState, setIceState] = useState({});
  const [candTypes, setCandTypes] = useState({});
  const [playBlocked, setPlayBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [micError, setMicError] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  // Private rooms: members + inviting friends in.
  const [showInvite, setShowInvite] = useState(false);
  const [friends, setFriends] = useState(null);
  const [invited, setInvited] = useState([]);
  const [inviteError, setInviteError] = useState('');
  const [leaving, setLeaving] = useState(false);
  // Roles & moderation (private rooms): local copy of the member list so
  // role actions refresh it without leaving the room; moderator-mute
  // state for me; whether I was kicked out of this room.
  const [members, setMembers] = useState(room.members || []);
  const [memberError, setMemberError] = useState('');
  const [modMuted, setModMuted] = useState(false);
  const [modMutedBy, setModMutedBy] = useState('');
  const [kicked, setKicked] = useState(false);
  // Orb tap popover + bounce: which orb's info card is open, and which
  // orb just got tapped (drives the one-shot .orb-tapped bounce).
  const [selectedOrb, setSelectedOrb] = useState(null);
  const [tapOrbId, setTapOrbId] = useState(null);
  const tapTimerRef = useRef(null);
  const voiceRef = useRef(null);
  const chatEndRef = useRef(null);
  const chatOpenRef = useRef(false);
  chatOpenRef.current = chatOpen;
  // Measured room area, so orbPositions can clamp orbs inside it — without
  // this, a wide orb near the edge is half cut off on narrow phones.
  const spaceRef = useRef(null);
  const [spaceSize, setSpaceSize] = useState({ width: 360, height: 480 });

  useEffect(() => {
    const el = spaceRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setSpaceSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const accent = room.accent || { from: '#8b5cf6', to: '#d946ef' };

  useEffect(() => {
    const socket = getSocket();
    const voice = new VoiceEngine({
      socket,
      roomId: room.id,
      selfId: user.id,
      onSpeaking: (s) => setSpeaking(s),
      onMicError: (msg) => setMicError(msg),
      onConnectionState: (socketId, state, ice, candidates) => {
        setConnState((prev) => ({ ...prev, [socketId]: state }));
        if (ice) setIceState((prev) => ({ ...prev, [socketId]: ice }));
        if (candidates !== undefined) {
          setCandTypes((prev) => ({ ...prev, [socketId]: candidates }));
        }
      },
      onPlaybackBlocked: () => setPlayBlocked(true)
    });
    voiceRef.current = voice;

    const onRoomState = ({ occupants: others, mutedByModerator }) => {
      setOccupants((prev) => {
        const next = { ...prev };
        for (const o of others || []) {
          next[o.socketId] = { socketId: o.socketId, userId: o.userId, name: o.name, muted: false };
        }
        return next;
      });
      // A moderator muted me before I (re)joined — start muted again.
      if (mutedByModerator) applyModeratorMute(true, '');
    };
    const onUserJoined = ({ socketId, userId, name }) => {
      setOccupants((prev) => ({
        ...prev,
        [socketId]: { socketId, userId, name, muted: false }
      }));
      playJoinSound();
    };
    const onUserLeft = ({ socketId }) => {
      setOccupants((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      setConnState((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      setIceState((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      setCandTypes((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
    };
    const onMicState = ({ socketId, muted: m }) => {
      setOccupants((prev) => {
        if (!prev[socketId]) return prev;
        return { ...prev, [socketId]: { ...prev[socketId], muted: m } };
      });
    };
    const onChatMessage = (msg) => {
      setMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev.slice(-99), msg];
      });
      if (!chatOpenRef.current && msg.userId !== user.id) setUnread((u) => u + 1);
    };
    // Moderator mute is cooperative (voice is P2P — the server cannot
    // force a client silent): my client honors it by muting itself.
    // setMuted broadcasts mic-state, so everyone else sees the 🔇 badge.
    const onModeratorMuted = ({ roomId, by }) => {
      if (roomId !== room.id) return;
      applyModeratorMute(true, by || '');
    };
    const onModeratorUnmuted = ({ roomId }) => {
      if (roomId !== room.id) return;
      applyModeratorMute(false, '');
    };
    // Kicked by the owner/moderator: stop voice and show a notice
    // instead of the room (the server already forced my sockets out).
    const onRoomKicked = ({ roomId }) => {
      if (roomId !== room.id) return;
      voiceRef.current?.leave();
      setKicked(true);
    };

    socket.on('room-state', onRoomState);
    socket.on('user-joined', onUserJoined);
    socket.on('user-left', onUserLeft);
    socket.on('mic-state', onMicState);
    socket.on('chat-message', onChatMessage);
    socket.on('moderator-muted', onModeratorMuted);
    socket.on('moderator-unmuted', onModeratorUnmuted);
    socket.on('room-kicked', onRoomKicked);

    apiJson(`/api/rooms/${room.id}/messages`).then(setMessages).catch(() => {});
    voice.join();

    return () => {
      voice.leave();
      socket.off('room-state', onRoomState);
      socket.off('user-joined', onUserJoined);
      socket.off('user-left', onUserLeft);
      socket.off('mic-state', onMicState);
      socket.off('chat-message', onChatMessage);
      socket.off('moderator-muted', onModeratorMuted);
      socket.off('moderator-unmuted', onModeratorUnmuted);
      socket.off('room-kicked', onRoomKicked);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  // Keep the member list in sync when the parent hands a fresh room
  // object (e.g. after a home-screen refresh).
  useEffect(() => {
    setMembers(room.members || []);
  }, [room]);

  useEffect(() => {
    if (chatOpen && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, chatOpen]);

  // Honor a moderator mute/unmute (or a rejoin with a mute already in
  // place): mute the engine (which broadcasts mic-state so the room sees
  // the 🔇 badge), mark my own orb, and remember who muted me.
  const applyModeratorMute = useCallback((isMuted, by) => {
    voiceRef.current?.setMuted(isMuted);
    setModMuted(isMuted);
    setModMutedBy(isMuted ? by : '');
    setMuted(isMuted);
    setOccupants((prev) => ({
      ...prev,
      self: { ...prev.self, muted: isMuted }
    }));
  }, []);

  const toggleMute = useCallback(() => {
    // While a moderator has me muted, the button is disabled — but
    // guard here too so nothing can unmute me from under them.
    if (modMuted) return;
    const next = !muted;
    voiceRef.current?.setMuted(next);
    setOccupants((prev) => ({
      ...prev,
      self: { ...prev.self, muted: next }
    }));
    setMuted(next);
    playMuteSound(next);
  }, [muted, modMuted]);

  const toggleDeafen = useCallback(() => {
    const next = !deafened;
    voiceRef.current?.setDeafened(next);
    setDeafened(next);
    playDeafenSound(next);
  }, [deafened]);

  // Tap an orb: quick bounce + toggle its info popover. The class is
  // removed and re-added on a later frame so a fast double-tap replays
  // the bounce instead of being swallowed by the still-present class.
  const tapOrb = useCallback((socketId) => {
    setTapOrbId(null);
    requestAnimationFrame(() => requestAnimationFrame(() => setTapOrbId(socketId)));
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    tapTimerRef.current = setTimeout(() => setTapOrbId(null), 380);
  }, []);

  const openChat = () => {
    setChatOpen((v) => !v);
    setUnread(0);
  };

  const openInvite = async () => {
    setShowInvite((v) => !v);
    if (friends === null) {
      try {
        const data = await getFriends();
        setFriends(data.friends || []);
      } catch {
        setFriends([]);
      }
    }
  };

  const inviteFriend = async (friendId) => {
    setInviteError('');
    try {
      await inviteToRoom(room.id, friendId);
      setInvited((prev) => [...prev, friendId]);
    } catch (err) {
      setInviteError(err.message);
    }
  };

  // Role actions — each answers with the fresh room JSON; the member
  // list refreshes from it. Errors surface under the members panel.
  const runMemberAction = async (fn) => {
    setMemberError('');
    try {
      const updated = await fn();
      if (updated?.members) setMembers(updated.members);
    } catch (err) {
      setMemberError(err.message);
    }
  };

  const myRole = (members.find((m) => m.id === user.id) || {}).role || null;
  const isOwner = myRole === 'owner';
  const isModerator = myRole === 'moderator';

  const promote = (memberId) => runMemberAction(() => promoteMember(room.id, memberId));
  const demote = (memberId) => runMemberAction(() => demoteMember(room.id, memberId));
  const kick = (member) => {
    if (!window.confirm(`Remove ${member.name || 'this member'} from "${room.name}"? They will need a new invite to come back.`)) return;
    runMemberAction(() => kickMember(room.id, member.id));
  };
  const transfer = (member) => {
    if (!window.confirm(`Make ${member.name || 'this member'} the owner of "${room.name}"? You will become a moderator.`)) return;
    runMemberAction(() => transferOwnership(room.id, member.id));
  };
  const mute = (member) => runMemberAction(() => muteMember(room.id, member.id));

  const leaveMembership = async () => {
    if (!window.confirm(`Leave the private room "${room.name}"? You will need a new invite to come back.`)) return;
    setLeaving(true);
    try {
      await leavePrivateRoom(room.id);
      onLeave();
    } catch (err) {
      setInviteError(err.message);
      setLeaving(false);
    }
  };

  const sendMessage = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    getSocket().emit('chat-message', { roomId: room.id, text });
  };

  const people = Object.values(occupants);
  const positions = orbPositions(people, spaceSize);
  const posById = Object.fromEntries(positions.map((p) => [p.id, p]));

  // Avatar data for the other occupants (presence rows carry only id +
  // name). Self comes from App's user prop. Fetched once per membership
  // change — rooms are small, so one bounded call covers everyone.
  const [occupantAvatars, setOccupantAvatars] = useState({});
  const occupantIds = people
    .map((p) => p.userId)
    .filter((id) => id && id !== user.id)
    .sort()
    .join(',');
  useEffect(() => {
    if (!occupantIds) return undefined;
    let cancelled = false;
    getUserAvatars(occupantIds.split(','))
      .then((list) => {
        if (cancelled) return;
        setOccupantAvatars((prev) => {
          const next = { ...prev };
          for (const a of list || []) next[a.id] = a;
          return next;
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [occupantIds]);

  const isSpeaking = (person) => {
    if (person.isSelf) return speaking.selfSpeaking;
    return (speaking.levels[person.socketId] || 0) > 0.25;
  };
  // Private-room role for the orb popover (owner / moderator / member).
  const roleOf = (userId) => (members.find((m) => m.id === userId) || {}).role || null;

  if (kicked) {
    return (
      <div className="room-view">
        <div className="card kicked-card">
          <h2>You were removed from “{room.name}”</h2>
          <p className="muted">The owner or a moderator kicked you out of this private room. You'll need a new invite to come back.</p>
          <button className="btn btn-primary" onClick={onLeave}>Back to rooms</button>
        </div>
      </div>
    );
  }

  return (
    <div className="room-view">
      <div className="room-header">
        <button className="btn btn-text" onClick={onLeave}>← Rooms</button>
        <div className="room-title">
          <strong>
            {room.isPrivate && <span className="lock-badge" title="Private room">🔒 </span>}
            {room.name}
          </strong>
          {room.topic && <span className="muted">{room.topic}</span>}
        </div>
        <span className="room-count">
          <span className="count-dot" /> {people.length} here
        </span>
      </div>

      {micError && <p className="mic-error">{micError}</p>}

      {room.isPrivate && (
        <div className="members-panel card">
          <div className="members-head">
            <strong>Members ({members.length})</strong>
            <span>
              <button className="btn btn-primary btn-small" onClick={openInvite}>
                {showInvite ? '✕ Close' : '＋ Invite a friend'}
              </button>
              {' '}
              <button className="btn btn-text btn-small" disabled={leaving} onClick={leaveMembership}>
                {leaving ? 'Leaving…' : 'Leave room'}
              </button>
            </span>
          </div>
          <div className="members-list">
            {members.map((m, i) => {
              const isMe = m.id === user.id;
              const label = m.role === 'owner' ? '👑 Owner' : m.role === 'moderator' ? '🛡️ Mod' : null;
              return (
                <div key={m.id} className="member-row stagger-in" style={{ animationDelay: `${i * 40}ms` }}>
                  <Avatar user={m} size="sm" className="person-orb" />
                  <span className="person-info">
                    <strong>{m.name || 'Unnamed'}{isMe ? ' (you)' : ''}</strong>
                    {label && <span className={`role-badge role-${m.role}`}>{label}</span>}
                  </span>
                  <span className="member-actions">
                    {isOwner && !isMe && m.role === 'member' && (
                      <button className="btn btn-text btn-small" onClick={() => promote(m.id)}>Promote</button>
                    )}
                    {isOwner && !isMe && m.role === 'moderator' && (
                      <button className="btn btn-text btn-small" onClick={() => demote(m.id)}>Demote</button>
                    )}
                    {isOwner && !isMe && (
                      <button className="btn btn-text btn-small" onClick={() => transfer(m)}>Make owner</button>
                    )}
                    {(isOwner || isModerator) && !isMe && m.role === 'member' && (
                      <button className="btn btn-text btn-small" onClick={() => kick(m)}>Kick</button>
                    )}
                    {(isOwner || isModerator) && !isMe && m.role !== 'owner' && (
                      <button className="btn btn-text btn-small" onClick={() => mute(m)}>Mute</button>
                    )}
                  </span>
                </div>
              );
            })}
            {members.length === 0 && (
              <span className="muted">No members listed.</span>
            )}
          </div>
          {memberError && <p className="error">{memberError}</p>}
          <p className="muted members-note">
            Moderator mute is cooperative — a muted member's app mutes itself, and a modified client could ignore it.
          </p>
          {showInvite && (
            <div className="invite-picker">
              {friends === null && <p className="muted">Loading friends…</p>}
              {friends !== null && friends.length === 0 && (
                <p className="muted">
                  No friends yet — add friends from the Friends tab to invite them here.
                </p>
              )}
              {friends !== null && friends.map((f, i) => {
                const alreadyMember = members.some((m) => m.id === f.id);
                const justInvited = invited.includes(f.id);
                return (
                  <div key={f.id} className="person-row stagger-in" style={{ animationDelay: `${i * 40}ms` }}>
                    <Avatar user={f} size="sm" className="person-orb" />
                    <span className="person-info">
                      <strong>{f.name || 'Unnamed'}</strong>
                      <span className="muted person-email">{f.email}</span>
                    </span>
                    {alreadyMember ? (
                      <span className="muted">Member ✓</span>
                    ) : justInvited ? (
                      <span className="muted">Invited ✓</span>
                    ) : (
                      <button className="btn btn-primary btn-small" onClick={() => inviteFriend(f.id)}>
                        Invite
                      </button>
                    )}
                  </div>
                );
              })}
              {inviteError && <p className="error">{inviteError}</p>}
            </div>
          )}
        </div>
      )}

      <div className="room-space" ref={spaceRef} onClick={() => setSelectedOrb(null)}>
        <div className="starfield" />
        <div className="starfield-twinkle starfield-twinkle-a" />
        <div className="starfield-twinkle starfield-twinkle-b" />
        <div className="nebula nebula-a" />
        <div className="nebula nebula-b" />
        <div
          className="room-halo"
          style={{ background: `radial-gradient(circle, ${accent.from}33, transparent 65%)` }}
        />
        {people.map((person) => {
          const pos = posById[person.socketId];
          if (!pos) return null;
          const speakingNow = isSpeaking(person);
          // Glide on transform (px), not left/top: orbLayout gives % of
          // the measured room, so convert once here. When someone joins
          // or leaves, every orb's target moves and the transition
          // glides them there instead of jumping.
          const px = (pos.x / 100) * spaceSize.width;
          const py = (pos.y / 100) * spaceSize.height;
          const role = person.isSelf ? myRole : roleOf(person.userId);
          const selected = selectedOrb === person.socketId;
          // Photo in the orb when the person has one (self from App's
          // user, others from the occupant avatar lookup); otherwise
          // initials over the room accent, as before. A photo skips the
          // hue-rotate so it is not tinted.
          const personAvatar = person.isSelf ? user : occupantAvatars[person.userId];
          const photo = personAvatar?.avatarImage || '';
          return (
            <div
              key={person.socketId}
              className={`orb-wrap ${selected ? 'selected' : ''}`}
              style={{
                '--tx': `${px}px`,
                '--ty': `${py}px`,
                width: pos.size,
                height: pos.size
              }}
              onClick={(e) => {
                e.stopPropagation();
                tapOrb(person.socketId);
                setSelectedOrb(selected ? null : person.socketId);
              }}
              role="button"
              aria-label={person.name}
              title={person.name}
            >
              <div
                className="orb-bob"
                style={{ animationDelay: `${pos.delay}s`, animationDuration: `${pos.duration}s` }}
              >
                <div
                  className={`orb ${speakingNow ? 'speaking' : ''} ${person.muted ? 'is-muted' : ''} ${tapOrbId === person.socketId ? 'orb-tapped' : ''}`}
                  style={photo
                    ? { backgroundImage: `url(${photo})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                    : {
                        background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
                        filter: `hue-rotate(${orbHue(person.userId)}deg)`
                      }}
                >
                  {!photo && <span className="orb-initials">{initials(person.name)}</span>}
                  <span className="orb-name">
                    {person.name.split(' ')[0]}{person.isSelf ? ' (you)' : ''}
                  </span>
                  {person.muted && <span className="orb-muted">🔇</span>}
                  {person.isSelf && modMuted && (
                    <span className="orb-mod-muted">Muted by moderator{modMutedBy ? ` — ${modMutedBy}` : ''}</span>
                  )}
                  {!person.isSelf && (
                    <span
                      className={`conn-dot conn-${connState[person.socketId] || 'new'}`}
                      title={`Voice: ${connState[person.socketId] || 'connecting…'}`}
                    />
                  )}
                </div>
              </div>
              {selected && (
                <div className={`orb-popover ${pos.y < 32 ? 'below' : ''}`}>
                  <span>
                    {person.name.split(' ')[0]}{person.isSelf ? ' (you)' : ''}
                  </span>
                  {role === 'owner' && <span className="role-badge role-owner">👑 Owner</span>}
                  {role === 'moderator' && <span className="role-badge role-mod">🛡️ Mod</span>}
                  {person.muted && <span>🔇 Muted</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* In flow (not absolute inside the room-space): an absolute hint
          at the space's bottom edge rested behind the fixed voice bar
          whenever the page was taller than the viewport. In flow it
          can only sit below the space, and the room-view's bottom
          padding keeps it clear of the voice bar at max scroll. */}
      {people.length === 1 && (
        <p className="room-hint">You're alone in here — friends join from the home screen.</p>
      )}

      {people.length > 1 && (
        <div className="voice-status">
          {people
            .filter((p) => !p.isSelf)
            .map((p) => (
              <span key={p.socketId}>
                {p.name.split(' ')[0]}: {connState[p.socketId] || '—'} /{' '}
                {iceState[p.socketId] || '—'}
                {candTypes[p.socketId] ? ` (${candTypes[p.socketId]})` : ''}
              </span>
            ))}
        </div>
      )}
      {playBlocked && (
        <button
          className="btn btn-primary sound-btn"
          onClick={async () => {
            const ok = await voiceRef.current?.retryPlayback();
            setPlayBlocked(!ok);
          }}
        >
          🔊 Tap to enable sound
        </button>
      )}

      {chatOpen && (
        <div className="chat-sheet">
          <div className="chat-head">
            <strong>Chat — {room.name}</strong>
            <button className="btn btn-text" onClick={() => setChatOpen(false)}>✕</button>
          </div>
          <div className="chat-messages">
            {messages.length === 0 && (
              <p className="muted chat-empty">No messages yet. Say hi 👋</p>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`chat-msg ${m.userId === user.id ? 'mine' : ''}`}>
                <span className="chat-name">{m.userId === user.id ? 'You' : m.name}</span>
                <span className="chat-text">{m.text}</span>
                <span className="chat-time">
                  {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-input" onSubmit={sendMessage}>
            <input
              placeholder={`Message ${room.name}…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={1000}
            />
            <button className="btn btn-primary" type="submit">Send</button>
          </form>
        </div>
      )}

      <div className="voice-bar">
        <button
          className={`voice-btn ${muted ? 'off' : ''}`}
          onClick={toggleMute}
          disabled={modMuted}
          title={modMuted ? 'Muted by moderator' : undefined}
          aria-label={modMuted ? 'Muted by moderator' : muted ? 'Unmute' : 'Mute'}
        >
          <span key={muted ? 'off' : 'on'} className="voice-ico">{muted ? '🔇' : '🎙️'}</span>
        </button>
        <button
          className={`voice-btn ${deafened ? 'off' : ''}`}
          onClick={toggleDeafen}
          aria-label={deafened ? 'Undeafen' : 'Deafen'}
        >
          <span key={deafened ? 'off' : 'on'} className="voice-ico">{deafened ? '🔕' : '🔊'}</span>
        </button>
        <button className="voice-btn" onClick={openChat} aria-label="Chat">
          💬
          {unread > 0 && <span className="unread-badge">{unread}</span>}
        </button>
        <button className="voice-btn leave" onClick={onLeave} aria-label="Leave room">
          📞
        </button>
      </div>
      {modMuted && (
        <p className="mod-muted-note">
          🔇 Muted by moderator{modMutedBy ? ` (${modMutedBy})` : ''} — you can still hear everyone, but they can't hear you.
        </p>
      )}
    </div>
  );
}
