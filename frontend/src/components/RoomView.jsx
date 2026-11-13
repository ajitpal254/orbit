import React, { useEffect, useRef, useState, useCallback } from 'react';
import { apiJson, getFriends, getUserAvatars, inviteToRoom, leavePrivateRoom, promoteMember, demoteMember, kickMember, transferOwnership, muteMember, keepRoom, createInviteLink, getInviteLink, revokeInviteLink, getRoomKnocks, admitKnock, declineKnock, setRoomMode, updateProfile, uploadImage } from '../api';
import { buildInviteLinkUrl } from '../deepLink';
import { validateImageFile, readImageDimensions } from '../media';
import ChatMessage from './ChatMessage';
import { getSocket } from '../socket';
import { VoiceEngine } from '../voice';
import { normalizeMood, moodLabel, MOOD_META } from '../mood';
import MoodPicker from './MoodPicker';
import AudioSettings from './AudioSettings';
import { playJoinSound, playMuteSound, playDeafenSound, playFocusEndSound } from '../sounds';
import { remainingMs, focusProgress, formatFocusRemaining, FOCUS_PRESET_MINUTES } from '../focusTimer';
import { trackEvent } from '../analytics';
import { orbPositions, initials, orbHue } from '../orbLayout';
import { clusterHuddles, clampPosition, SPATIAL_AUDIO_ENABLED } from '../proximity';
import { supportsScreenShare, canStartSharing, SCREEN_SHARE_BUSY_MESSAGE } from '../screenShare';
import Avatar from './Avatar';
import CharacterArt from './CharacterAvatar';
import { avatarCharacterById } from '../avatars';
import { Icon, SignalBars } from './icons';

// Short relative age for a knock row ("just now", "5m ago", "3h ago") —
// a knock expires after 24h, so the owner can see at a glance how
// long one has been waiting.
const knockAge = (iso) => {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

export default function RoomView({ user, room, onLeave, onMinimize, session, dispatchSession, voiceEngineRef, onUserChange }) {
  const { muted, deafened, modMuted, modMutedBy, sharing, screenSharerId, screenSharerName, shareError } = session;
  const [occupants, setOccupants] = useState(() => ({
    self: { socketId: 'self', userId: user.id, name: user.name, muted: false, isSelf: true, mood: normalizeMood(user.mood) }
  }));
  // Postcard sightings: everyone the client saw in this room during my
  // stay, in first-seen order, keyed by user id (a rejoin on a new
  // socket is the same person). Handed to App on leave, which builds
  // the postcard from it — nothing here is sent to the server. Self is
  // recorded too and filtered out when the card is built.
  const seenRef = useRef(new Map([[String(user.id), {
    id: String(user.id),
    name: user.name,
    avatarPreset: user.avatarPreset || '',
    avatarImage: user.avatarImage || ''
  }]]));
  const [speaking, setSpeaking] = useState({ selfSpeaking: false, levels: {} });
  const [connState, setConnState] = useState({});
  const [iceState, setIceState] = useState({});
  const [candTypes, setCandTypes] = useState({});
  // Ref mirror of connState for the ICE-recovery gate below: the
  // engine's onIceRecovery callback closes over the effect's mount
  // render, so it reads the live map from here, not stale state.
  const connStateRef = useRef({});
  const [playBlocked, setPlayBlocked] = useState(false);
  const [micError, setMicError] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  // Media sharing (v0.8.0): a picked image waits in the composer as a
  // thumbnail + progress bar; the message is sent only after the
  // upload completes, with the returned URL in the payload. Dragging a
  // file onto the chat sheet or pasting one into the input picks it
  // the same way as the paperclip button.
  const [pendingImage, setPendingImage] = useState(null); // { file, previewUrl, width, height, progress, uploading }
  const [uploadError, setUploadError] = useState('');
  const [sending, setSending] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  // Private rooms: members + inviting friends in.
  const [showInvite, setShowInvite] = useState(false);
  // M1: on phones the members panel is collapsed by default (see the
  // ≤520px rules in index.css) so the orb stage gets the freed space.
  // The toggle only collapses ≤520px — on desktop the panel is always
  // fully visible, exactly as before.
  const [membersOpen, setMembersOpen] = useState(false);
  const [friends, setFriends] = useState(null);
  const [invited, setInvited] = useState([]);
  const [inviteError, setInviteError] = useState('');
  // Invite link (shareable join link): the panel under the header, the
  // fetched/created link, and copy feedback. One link per room — the
  // panel loads the existing one or creates it on first open.
  const [showLink, setShowLink] = useState(false);
  const [linkInfo, setLinkInfo] = useState(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState('');
  const [copied, setCopied] = useState(false);
  const linkInputRef = useRef(null);
  const copiedTimerRef = useRef(null);
  const [leaving, setLeaving] = useState(false);
  // Roles & moderation (private rooms): local copy of the member list so
  // role actions refresh it without leaving the room; moderator-mute
  // state for me; whether I was kicked out of this room.
  const [members, setMembers] = useState(room.members || []);
  const [memberError, setMemberError] = useState('');
  const [kicked, setKicked] = useState(false);
  // Room cap (v0.7.0): the server refuses join-room with code
  // 'room-full' when 8 people are already inside — stop voice and
  // show the full-room card instead of the stage, like kicked/faded.
  const [roomFull, setRoomFull] = useState(false);
  // Knocks (private rooms): pending knocks for the owner/moderators to
  // answer. Loaded only for owner/mods; quiet by default — the section
  // only renders while someone is knocking.
  const [knocks, setKnocks] = useState([]);
  const [knockError, setKnockError] = useState('');
  const [answeringKnock, setAnsweringKnock] = useState(null);
  // Orb tap popover + bounce: which orb's info card is open, and which
  // orb just got tapped (drives the one-shot .orb-tapped bounce).
  const [selectedOrb, setSelectedOrb] = useState(null);
  const [tapOrbId, setTapOrbId] = useState(null);
  // Proximity audio (v0.6.0): user-draggable orb positions. Overrides
  // hold positions that differ from the deterministic orbLayout
  // defaults — mine (drag / arrow keys / reset) and remotes' (from
  // the server's orb-move relay). Keyed by socketId ('self' is me).
  const [orbOverrides, setOrbOverrides] = useState({});
  const [spatialOn, setSpatialOn] = useState(SPATIAL_AUDIO_ENABLED);
  const [dragging, setDragging] = useState(false);
  const orbOverridesRef = useRef({});
  const selfPosRef = useRef(null);
  const prevHuddlesRef = useRef([]);
  const dragRef = useRef({ active: false, moved: false });
  const justDraggedRef = useRef(false);
  const emitMoveRef = useRef({ last: 0, pending: null, timer: null });
  // Campfires (fading rooms): whether this room was kept permanent,
  // whether it faded under us, and the keep request state.
  const [kept, setKept] = useState(false);
  const [faded, setFaded] = useState(false);
  const [keepBusy, setKeepBusy] = useState(false);
  const [keepError, setKeepError] = useState('');
  // Together mode: the room's mode (talk/focus) and the shared focus
  // session. The session carries the server's startedAt + durationSec;
  // remaining time is derived from those, so every client counts down
  // in sync and late joiners see the same remaining time (room-state
  // carries it). focusNow ticks once a second while a session runs —
  // the tick only re-renders; the server's numbers are the truth.
  const [mode, setMode] = useState(room.mode || 'talk');
  const [focusSession, setFocusSession] = useState(null);
  const [focusNow, setFocusNow] = useState(() => Date.now());
  const [focusMinutes, setFocusMinutes] = useState(25);
  const [focusBusy, setFocusBusy] = useState(false);
  const [focusError, setFocusError] = useState('');
  const [modeBusy, setModeBusy] = useState(false);
  // The end chime must play once per session even if both the local
  // expiry and the server's focus-ended broadcast fire for it.
  const chimedForRef = useRef(null);
  // Muted/deafened as a ref: the socket handlers close over the mount
  // render, so they read the live value from here instead of a stale
  // one when deciding whether the end chime may play.
  const soundOffRef = useRef(false);
  soundOffRef.current = muted || deafened || modMuted;
  // Audio settings (v0.7.0): the device picker + volume panel.
  // (Restored: the v0.8.0 screen-share commit dropped this declaration
  // while keeping its four usages, so any room render threw
  // `ReferenceError: showAudio is not defined` — caught by the smoke
  // test's "no uncaught page errors" assertion.)
  const [showAudio, setShowAudio] = useState(false);
  // Screen sharing (v0.8.0): the incoming remote share ({ socketId,
  // stream }) for the share layer, and whether this viewport is a
  // phone — sharing is view-only on phones, so the Share button never
  // renders there (matchMedia, same pattern as StoriesRow). The
  // share state itself (who holds the slot, am I sharing) lives in
  // the App-owned voice session, not here.
  const [remoteShare, setRemoteShare] = useState(null);
  const shareVideoRef = useRef(null);
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 520px)').matches
  );
  const sharingRef = useRef(false);
  sharingRef.current = sharing;
  const canShare = !isPhone && supportsScreenShare(
    typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
  );
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 520px)');
    const onChange = (e) => setIsPhone(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  // The video element for the incoming share: attach the stream when
  // a share arrives, detach when it ends. play() is best-effort — the
  // track carries no audio, so autoplay is not blocked, but a
  // backgrounded tab may still refuse it.
  useEffect(() => {
    const video = shareVideoRef.current;
    if (!video) return undefined;
    if (!remoteShare) {
      video.srcObject = null;
      return undefined;
    }
    video.srcObject = remoteShare.stream;
    video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [remoteShare]);
  const enterShareFullscreen = () => {
    const video = shareVideoRef.current;
    if (!video || !video.requestFullscreen) return;
    video.requestFullscreen().catch(() => {});
  };
  const remoteSharerName = remoteShare
    ? (occupants[remoteShare.socketId]?.name || screenSharerName || 'Someone')
    : '';
  // "Connection details" popover: the per-peer ICE/debug line lives
  // here instead of always-on under the orbs (see below).
  const [showConnDetails, setShowConnDetails] = useState(false);
  const tapTimerRef = useRef(null);
  const voiceRef = useRef(null);
  const chatEndRef = useRef(null);
  const chatOpenRef = useRef(false);
  chatOpenRef.current = chatOpen;
  // Measured room area, so orbPositions can clamp orbs inside it — without
  // this, a wide orb near the edge is half cut off on narrow phones.
  const spaceRef = useRef(null);
  const [spaceSize, setSpaceSize] = useState({ width: 360, height: 480 });

  // Play the focus-end chime once for a session (keyed by its
  // startedAt). The chime is a UI sound, not voice: it stays off while
  // the user is muted or deafened, per the spec.
  const chimeFocusEnd = useCallback((startedAt) => {
    if (startedAt != null && chimedForRef.current === startedAt) return;
    chimedForRef.current = startedAt ?? 'local';
    if (soundOffRef.current) return;
    playFocusEndSound();
  }, []);

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
        connStateRef.current = { ...connStateRef.current, [socketId]: state };
        if (ice) setIceState((prev) => ({ ...prev, [socketId]: ice }));
        if (candidates !== undefined) {
          setCandTypes((prev) => ({ ...prev, [socketId]: candidates }));
        }
      },
      // ICE recovery (v0.9.0): the engine reports a peer's recovery
      // phases. A room-level "Reconnecting…" only makes sense when no
      // peer is currently connected — one peer's blip while others
      // are live is their problem, not the call's. The reducer guards
      // both transitions, so a stale event cannot resurrect an ended
      // call. 'failed' is per-peer: the engine already dropped that
      // peer and its orb shows disconnected; the call stays up.
      onIceRecovery: (socketId, phase) => {
        if (phase === 'recovering') {
          const anyConnected = Object.values(connStateRef.current).some((s) => s === 'connected');
          if (!anyConnected) dispatchSession({ type: 'reconnecting' });
        } else if (phase === 'recovered') {
          dispatchSession({ type: 'reconnected' });
        }
      },
      onPlaybackBlocked: () => setPlayBlocked(true),
      // Screen sharing (v0.8.0): a video track on a peer connection is
      // a shared screen — it goes to the share layer, never the audio
      // path. The engine reports the track, the track ending, and my
      // own capture ending under me (browser chrome stop); RoomView
      // owns the socket claim + stop, so there is one stop sequence.
      onShareTrack: (socketId, stream) => setRemoteShare({ socketId, stream }),
      onShareEnded: (socketId) => setRemoteShare((prev) => (prev && prev.socketId === socketId ? null : prev)),
      onLocalShareEnded: () => { stopSharing(); }
    });
    voiceRef.current = voice;
    // App owns the session and needs the engine so the mini-player can
    // toggle mute while this view is hidden; cleared on teardown below.
    if (voiceEngineRef) voiceEngineRef.current = voice;

    const onRoomState = ({ occupants: others, mutedByModerator, focusSession: fs, screenSharer }) => {
      setOccupants((prev) => {
        const next = { ...prev };
        for (const o of others || []) {
          // Mood rides with presence (lib/socket.js): the orb glows
          // with it, no second fetch.
          next[o.socketId] = { socketId: o.socketId, userId: o.userId, name: o.name, muted: false, mood: normalizeMood(o.mood) };
        }
        return next;
      });
      // A focus session already running in this room arrives with
      // room-state — a late joiner sees the same remaining time as
      // everyone else. Absent means no session (or an expired one the
      // server already dropped); the server is the source of truth.
      setFocusSession(fs || null);
      if (fs) setFocusBusy(false);
      // A screen share already running arrives the same way — a late
      // joiner learns who is sharing (the video track itself arrives
      // with the first offer, which already carries it).
      if (screenSharer?.userId) {
        dispatchSession({
          type: 'share-started',
          userId: screenSharer.userId,
          name: screenSharer.name || '',
          isMine: String(screenSharer.userId) === String(user.id)
        });
      }
      // A moderator muted me before I (re)joined — start muted again.
      if (mutedByModerator) applyModeratorMute(true, '');
    };
    const onUserJoined = ({ socketId, userId, name, mood }) => {
      setOccupants((prev) => ({
        ...prev,
        [socketId]: { socketId, userId, name, muted: false, mood: normalizeMood(mood) }
      }));
      playJoinSound();
    };
    // Mood glow (v0.7.0): someone changed their mood mid-room —
    // re-glow their orb at once. The server already validated the
    // mood and the sender's membership before relaying it.
    const onMoodChanged = ({ socketId, mood } = {}) => {
      if (!socketId) return;
      setOccupants((prev) => {
        if (!prev[socketId]) return prev;
        return { ...prev, [socketId]: { ...prev[socketId], mood: normalizeMood(mood) } };
      });
    };
    const onUserLeft = ({ socketId, userId }) => {
      setOccupants((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      // Their connection state goes with them: a stale 'connected'
      // entry would lie to the ICE-recovery gate (it counts live
      // peers) and to the Connection details popover.
      setConnState((prev) => { const next = { ...prev }; delete next[socketId]; return next; });
      setIceState((prev) => { const next = { ...prev }; delete next[socketId]; return next; });
      setCandTypes((prev) => { const next = { ...prev }; delete next[socketId]; return next; });
      delete connStateRef.current[socketId];
      // Their orb leaves with them — drop the position override.
      setOrbOverrides((prev) => {
        const next = { ...prev };
        delete next[socketId];
        return next;
      });
      // If the leaver was sharing, the slot is gone with them — clear
      // the share state and the layer (the server also broadcasts
      // screen-share-stopped on leave, so this is the local half).
      if (userId) dispatchSession({ type: 'share-stopped', userId });
      setRemoteShare((prev) => (prev && prev.socketId === socketId ? null : prev));
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
    // setMuted broadcasts mic-state, so everyone else sees the mic-off badge.
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
    // Room cap (v0.7.0): the server refused my join-room because 8
    // people are already in here — stop voice (it never got past
    // join-room, so there are no peers to tear down) and show the
    // friendly full-room card. Other 'error' events (focus, room
    // gone) are not join refusals and are left alone.
    // Screen-share claim refused (v0.8.0): the room's one slot was
    // already held — roll the local capture back (removeTrack +
    // renegotiate, so no video keeps flowing) and surface the exact
    // message "Someone is already sharing".
    const onJoinError = ({ code, error } = {}) => {
      if (code === 'room-full') {
        voiceRef.current?.leave();
        setRoomFull(true);
        return;
      }
      if (code === 'screen-share-busy' || error === SCREEN_SHARE_BUSY_MESSAGE) {
        if (voiceRef.current?.shareStream) voiceRef.current.stopScreenShare();
        dispatchSession({ type: 'share-stopped' });
        dispatchSession({ type: 'share-error', error: SCREEN_SHARE_BUSY_MESSAGE });
      }
    };
    // Screen sharing (v0.8.0): the server broadcasts every claim and
    // release to the whole room, including the sender — so my own
    // start lands here as the confirmation, and a peer's start/stop
    // lands here as the layer + banner update.
    const onShareStarted = ({ userId: sharerId, roomId: r, name } = {}) => {
      if (!r || r !== room.id || !sharerId) return;
      dispatchSession({
        type: 'share-started',
        userId: sharerId,
        name: name || '',
        isMine: String(sharerId) === String(user.id)
      });
    };
    const onShareStopped = ({ userId: sharerId, roomId: r } = {}) => {
      if (!r || r !== room.id || !sharerId) return;
      dispatchSession({ type: 'share-stopped', userId: sharerId });
    };
    // A remote orb moved: the server already validated + clamped the
    // position and checked membership — apply it to the override map
    // and to the voice engine's gain math. My own moves come back
    // only to others (socket.to), so no self echo to guard against.
    const onOrbMove = ({ socketId, x, y }) => {
      if (!socketId) return;
      const pos = clampPosition(x, y);
      setOrbOverrides((prev) => ({ ...prev, [socketId]: pos }));
      voiceRef.current?.updateRemotePosition(socketId, pos.x, pos.y);
    };
    // This campfire faded while I was still showing it: only possible
    // when my socket died without a leave (presence emptied, the
    // worker closed the room). Stop voice and show a notice.
    const onRoomClosed = ({ roomId }) => {
      if (roomId !== room.id) return;
      voiceRef.current?.leave();
      setFaded(true);
    };
    // Together mode: the shared focus session started / stopped /
    // ended, or the room's mode changed. focus-ended is the
    // authoritative end — it chimes once (deduped by startedAt with
    // the local-expiry path below). A mode change to talk clears any
    // session; the server also sends focus-stopped for that case.
    const onFocusStarted = (s) => {
      if (!s || s.roomId !== room.id) return;
      setFocusSession(s);
      setFocusError('');
      setFocusBusy(false);
    };
    const onFocusStopped = ({ roomId } = {}) => {
      if (roomId !== room.id) return;
      setFocusSession(null);
    };
    const onFocusEnded = (s) => {
      if (!s || s.roomId !== room.id) return;
      setFocusSession(null);
      chimeFocusEnd(s.startedAt);
    };
    const onRoomModeChanged = ({ roomId, mode: m } = {}) => {
      if (roomId !== room.id) return;
      setMode(m);
      if (m !== 'focus') setFocusSession(null);
    };

    socket.on('room-state', onRoomState);
    socket.on('user-joined', onUserJoined);
    socket.on('user-left', onUserLeft);
    socket.on('mood-changed', onMoodChanged);
    socket.on('mic-state', onMicState);
    socket.on('orb-move', onOrbMove);
    socket.on('chat-message', onChatMessage);
    socket.on('moderator-muted', onModeratorMuted);
    socket.on('moderator-unmuted', onModeratorUnmuted);
    socket.on('room-kicked', onRoomKicked);
    socket.on('room-closed', onRoomClosed);
    socket.on('focus-started', onFocusStarted);
    socket.on('focus-stopped', onFocusStopped);
    socket.on('focus-ended', onFocusEnded);
    socket.on('room-mode-changed', onRoomModeChanged);
    socket.on('screen-share-started', onShareStarted);
    socket.on('screen-share-stopped', onShareStopped);
    socket.on('error', onJoinError);

    // Transport recovery (v0.9.0): the signaling socket died
    // mid-call. Show "Reconnecting…" until it comes back — the peer
    // connections are P2P and may survive, so nothing is torn down
    // here. On reconnect, tell the server to cancel the 15s grace
    // and restore my presence (reconnect-to-room); the server answers
    // with room-state and the engine re-offers to the occupants. The
    // reducer guards both transitions, so a disconnect before any
    // join (or after a leave) is a no-op, and a stale reconnect
    // cannot resurrect an ended call. The initial connect fires
    // before this effect runs, so it never trips the reconnect path.
    const onSocketDisconnect = () => {
      if (voiceRef.current?.joined) dispatchSession({ type: 'reconnecting' });
    };
    const onSocketConnect = () => {
      if (!voiceRef.current?.joined) return;
      socket.emit('reconnect-to-room', { roomId: room.id });
      dispatchSession({ type: 'reconnected' });
    };
    socket.on('disconnect', onSocketDisconnect);
    socket.on('connect', onSocketConnect);

    // Real tab close (v0.9.0): tell the server at once via a beacon,
    // so the room sees the departure now instead of after the 15s
    // disconnect grace. Best-effort — if the beacon never lands, the
    // grace still fires. This is the ONLY unload handler in the voice
    // path: no beforeunload, no visibilitychange, and nothing here
    // tears the call down (a tab switch or backgrounding must never
    // end it).
    const onPageHide = () => {
      if (!voiceRef.current?.joined) return;
      try {
        navigator.sendBeacon(`/api/rooms/${room.id}/leave-beacon`);
      } catch {}
    };
    window.addEventListener('pagehide', onPageHide);

    apiJson(`/api/rooms/${room.id}/messages`).then(setMessages).catch(() => {});
    voice.join();

    return () => {
      voice.leave();
      if (voiceEngineRef) voiceEngineRef.current = null;
      socket.off('disconnect', onSocketDisconnect);
      socket.off('connect', onSocketConnect);
      window.removeEventListener('pagehide', onPageHide);
      socket.off('room-state', onRoomState);
      socket.off('user-joined', onUserJoined);
      socket.off('user-left', onUserLeft);
      socket.off('mood-changed', onMoodChanged);
      socket.off('mic-state', onMicState);
      socket.off('orb-move', onOrbMove);
      if (emitMoveRef.current.timer) clearTimeout(emitMoveRef.current.timer);
      socket.off('chat-message', onChatMessage);
      socket.off('moderator-muted', onModeratorMuted);
      socket.off('moderator-unmuted', onModeratorUnmuted);
      socket.off('room-kicked', onRoomKicked);
      socket.off('room-closed', onRoomClosed);
      socket.off('focus-started', onFocusStarted);
      socket.off('focus-stopped', onFocusStopped);
      socket.off('focus-ended', onFocusEnded);
      socket.off('room-mode-changed', onRoomModeChanged);
      socket.off('screen-share-started', onShareStarted);
      socket.off('screen-share-stopped', onShareStopped);
      socket.off('error', onJoinError);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  // Keep the member list in sync when the parent hands a fresh room
  // object (e.g. after a home-screen refresh).
  useEffect(() => {
    setMembers(room.members || []);
  }, [room]);

  // A new room resets the campfire state — RoomView stays mounted
  // when App swaps rooms, so this cannot live in the mount effect.
  useEffect(() => {
    setKept(false);
    setFaded(false);
    setKeepError('');
    // Fresh room, fresh stage: drop every orb override and huddle.
    setOrbOverrides({});
    orbOverridesRef.current = {};
    prevHuddlesRef.current = [];
    setMode(room.mode || 'talk');
    setFocusSession(null);
    setFocusError('');
    setFocusBusy(false);
    chimedForRef.current = null;
    // A new room has no share (yet): drop the layer and the slot
    // state — the new room's room-state carries its own sharer.
    setRemoteShare(null);
    dispatchSession({ type: 'share-stopped' });
    // Same reset for the postcard sightings: a new room is a new stay.
    seenRef.current = new Map([[String(user.id), {
      id: String(user.id),
      name: user.name,
      avatarPreset: user.avatarPreset || '',
      avatarImage: user.avatarImage || ''
    }]]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  // Tick the focus countdown once a second while a session runs. The
  // displayed time is derived from the server's startedAt, not from a
  // local countdown, so every client agrees — the tick only re-renders.
  useEffect(() => {
    if (!focusSession) return undefined;
    const t = setInterval(() => setFocusNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [focusSession]);

  // Local end-of-timer backstop: the server broadcasts focus-ended
  // when the timer fires, but if that push is missed (reconnect, a
  // backgrounded tab) the client still ends cleanly — and chimes once
  // — when its own derived remaining time hits zero.
  useEffect(() => {
    if (!focusSession) return;
    if (remainingMs(focusSession, focusNow) <= 0) {
      const startedAt = focusSession.startedAt;
      setFocusSession(null);
      chimeFocusEnd(startedAt);
    }
  }, [focusSession, focusNow, chimeFocusEnd]);

  useEffect(() => {
    if (chatOpen && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, chatOpen]);

  // Honor a moderator mute/unmute (or a rejoin with a mute already in
  // place): mute the engine (which broadcasts mic-state so the room sees
  // the mic-off badge), mark my own orb, and record it in the App-owned
  // session, so the mini-player agrees. My orb's mic-off badge follows
  // via the sync effect on session.muted below.
  const applyModeratorMute = useCallback((isMuted, by) => {
    voiceRef.current?.setMuted(isMuted);
    dispatchSession({ type: 'set-mod-muted', muted: isMuted, by: by || '' });
  }, [dispatchSession]);

  // Mood glow (v0.7.0): my mood, set from the picker below. The orb
  // re-glows at once (local state), the room hears it live (socket
  // 'mood' — the server validates + relays it), and the profile
  // PATCH persists it for the next room. A failed save stays local
  // for this session and never blocks the room.
  const setMood = useCallback(async (m) => {
    const mood = normalizeMood(m);
    setOccupants((prev) => ({ ...prev, self: { ...prev.self, mood } }));
    getSocket().emit('mood', { mood });
    try {
      const data = await updateProfile({ mood });
      if (data?.user && onUserChange) onUserChange(data.user);
    } catch {}
  }, [onUserChange]);

  const toggleMute = useCallback(() => {
    // While a moderator has me muted, the button is disabled — but
    // guard here too so nothing can unmute me from under them.
    if (modMuted) return;
    const next = !muted;
    voiceRef.current?.setMuted(next);
    dispatchSession({ type: 'set-muted', muted: next });
    playMuteSound(next);
  }, [muted, modMuted, dispatchSession]);

  // Screen sharing (v0.8.0): start captures the screen and adds the
  // video track to every peer connection, then claims the room's one
  // slot over the socket. The server broadcast echoes the claim back
  // (including to me) and sets the session state; a refused claim
  // arrives as an 'error' event and the handler above rolls the local
  // track back. Stop removes the track from every peer, renegotiates,
  // and releases the slot. Leaving the room auto-stops the share: the
  // engine stops the capture on teardown and the server releases the
  // slot on leave-room / disconnect, so no explicit stop is needed on
  // the leave path.
  const startSharing = useCallback(async () => {
    if (sharingRef.current) return;
    dispatchSession({ type: 'share-clear-error' });
    if (!canStartSharing({ sharerUserId: screenSharerId, selfId: user.id })) {
      dispatchSession({ type: 'share-error', error: SCREEN_SHARE_BUSY_MESSAGE });
      return;
    }
    const res = await voiceRef.current?.startScreenShare();
    if (!res?.ok) {
      dispatchSession({ type: 'share-error', error: res?.error || 'Could not start screen sharing.' });
      return;
    }
    getSocket().emit('screen-share-started', { roomId: room.id });
  }, [room.id, screenSharerId, user.id, dispatchSession]);

  const stopSharing = useCallback(async () => {
    if (!sharingRef.current && !voiceRef.current?.shareStream) return;
    await voiceRef.current?.stopScreenShare();
    getSocket().emit('screen-share-stopped', { roomId: room.id });
    dispatchSession({ type: 'share-stopped' });
  }, [room.id, dispatchSession]);

  const toggleDeafen = useCallback(() => {
    const next = !deafened;
    voiceRef.current?.setDeafened(next);
    dispatchSession({ type: 'set-deafened', deafened: next });
    playDeafenSound(next);
  }, [deafened, dispatchSession]);

  // The mute state lives in App (the mini-player shares it): mirror it
  // onto my own orb so the 🔇 badge follows a mute toggled from the
  // mini-player while this view was hidden.
  useEffect(() => {
    setOccupants((prev) => ({
      ...prev,
      self: { ...prev.self, muted }
    }));
  }, [muted]);

  // Broadcast my orb position, throttled to ~10 Hz (playbook spec):
  // the leading move goes out at once, the latest position during
  // the 100ms window is flushed by a trailing timer, and the final
  // position is sent immediately on pointer-up / reset.
  const emitOrbMove = useCallback((x, y, immediate = false) => {
    const socket = getSocket();
    const st = emitMoveRef.current;
    const now = Date.now();
    if (immediate || now - st.last >= 100) {
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      st.last = now;
      st.pending = null;
      socket.emit('orb-move', { roomId: room.id, x, y });
    } else {
      st.pending = { x, y };
      if (!st.timer) {
        st.timer = setTimeout(() => {
          st.timer = null;
          if (st.pending) {
            st.last = Date.now();
            const p = st.pending;
            st.pending = null;
            socket.emit('orb-move', { roomId: room.id, x: p.x, y: p.y });
          }
        }, 100 - (now - st.last));
      }
    }
  }, [room.id]);

  // Move my orb (drag / arrow keys / reset): clamp into the room,
  // update the override + the voice engine's gain math, and broadcast.
  const moveSelf = useCallback((x, y, immediate = false) => {
    const pos = clampPosition(x, y);
    orbOverridesRef.current = { ...orbOverridesRef.current, self: pos };
    setOrbOverrides((prev) => ({ ...prev, self: pos }));
    voiceRef.current?.setSelfPosition(pos.x, pos.y);
    emitOrbMove(pos.x, pos.y, immediate);
  }, [emitOrbMove]);

  // Reset my orb to its deterministic layout spot: drop the override
  // (so a later join/leave reshuffle moves me with the layout again)
  // and broadcast the default position at once.
  const resetPosition = () => {
    const defaults = orbPositions(Object.values(occupants), spaceSize);
    const mine = defaults.find((p) => p.id === 'self');
    const pos = mine ? { x: mine.x, y: mine.y } : { x: 50, y: 46 };
    const next = { ...orbOverridesRef.current };
    delete next.self;
    orbOverridesRef.current = next;
    setOrbOverrides(next);
    voiceRef.current?.setSelfPosition(pos.x, pos.y);
    emitOrbMove(pos.x, pos.y, true);
  };

  const toggleSpatial = () => {
    const next = !spatialOn;
    setSpatialOn(next);
    voiceRef.current?.setSpatialEnabled(next);
  };

  // Drag my orb (pointer events, so mouse + touch share the path):
  // pointer capture keeps moves flowing to the orb even off-stage,
  // positions convert from client px to % of the room stage, and a
  // drag that actually moved suppresses the tap that follows it (so
  // dragging never opens the orb popover by accident).
  const onSelfPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragRef.current = { active: true, moved: false };
    setDragging(true);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  };
  const onSelfPointerMove = (e) => {
    if (!dragRef.current.active) return;
    const el = spaceRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    const cur = selfPosRef.current || { x: 50, y: 46 };
    if (Math.abs(x - cur.x) + Math.abs(y - cur.y) > 1) dragRef.current.moved = true;
    moveSelf(x, y);
  };
  const onSelfPointerUp = () => {
    if (!dragRef.current.active) return;
    dragRef.current.active = false;
    setDragging(false);
    const cur = selfPosRef.current;
    if (cur) emitOrbMove(cur.x, cur.y, true); // flush the final spot
    if (dragRef.current.moved) {
      justDraggedRef.current = true;
      setTimeout(() => { justDraggedRef.current = false; }, 150);
    }
  };

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

  // Keyboard shortcuts (desktop only): M mute, D deafen, C chat,
  // Esc closes the chat sheet / invite picker / connection popover /
  // orb popover. Arrow keys move my orb (Shift = bigger step) —
  // the keyboard path for proximity, mirroring the drag.
  // Ignored while typing (input, textarea, contenteditable) or with
  // a modifier held.
  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? 6 : 2;
        const cur = selfPosRef.current || { x: 50, y: 46 };
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        e.preventDefault();
        moveSelf(cur.x + dx, cur.y + dy);
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'm') { toggleMute(); return; }
      if (key === 'd') { toggleDeafen(); return; }
      if (key === 'c') { openChat(); return; }
      if (e.key === 'Escape') {
        if (chatOpen) setChatOpen(false);
        else if (showAudio) setShowAudio(false);
        else if (showInvite) setShowInvite(false);
        else if (showLink) setShowLink(false);
        else if (showConnDetails) setShowConnDetails(false);
        else if (selectedOrb) setSelectedOrb(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMute, toggleDeafen, chatOpen, showAudio, showInvite, showLink, showConnDetails, selectedOrb, moveSelf]);

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

  // Invite link: load the room's active link, or create it when there
  // is none yet. The server returns the existing link instead of
  // duplicating it, so opening the panel twice is safe.
  const loadOrCreateLink = async () => {
    setLinkLoading(true);
    setLinkError('');
    try {
      const data = await getInviteLink(room.id);
      if (data?.link) {
        setLinkInfo(data.link);
      } else {
        setLinkInfo(await createInviteLink(room.id));
      }
    } catch (err) {
      setLinkError(err.message);
    } finally {
      setLinkLoading(false);
    }
  };

  const openLinkPanel = () => {
    const next = !showLink;
    setShowLink(next);
    if (next && !linkInfo && !linkLoading) loadOrCreateLink();
  };

  const linkUrl = linkInfo ? buildInviteLinkUrl(window.location.origin, linkInfo.token) : '';

  // Copy the link: Clipboard API first, with a select-the-input
  // fallback for browsers/contexts where it is unavailable.
  const copyLink = async () => {
    if (!linkUrl) return;
    try {
      await navigator.clipboard.writeText(linkUrl);
    } catch {
      linkInputRef.current?.select();
    }
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const revokeLink = async () => {
    if (!window.confirm(`Revoke the invite link for "${room.name}"? Anyone holding it will no longer be able to join with it.`)) return;
    setLinkError('');
    try {
      await revokeInviteLink(room.id);
      setLinkInfo(null);
      setCopied(false);
    } catch (err) {
      setLinkError(err.message);
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
  const canAnswerKnocks = isOwner || isModerator;
  // Together mode control: owner or moderator — same people who answer
  // knocks and mute. Public rooms have no member list, so the creator
  // (who is the role-owner server-side) is covered by the createdBy
  // check, exactly like the campfire "Keep this room" button.
  const canControlFocusUi = isOwner || isModerator ||
    String(room.createdBy) === String(user.id);

  // Pending knocks for this room, for the members panel. A 403 (plain
  // member) is expected and stays quiet — only owner/mods ever see it.
  const loadKnocks = useCallback(async () => {
    if (!room.isPrivate || !canAnswerKnocks) return;
    try {
      setKnocks(await getRoomKnocks(room.id));
    } catch {
      // Stay quiet: a failed refresh keeps the last-known list.
    }
  }, [room.id, room.isPrivate, canAnswerKnocks]);

  // Refresh the knocks live when one arrives or is withdrawn, and when
  // the role becomes known (members load after mount).
  useEffect(() => { loadKnocks(); }, [loadKnocks]);
  useEffect(() => {
    const socket = getSocket();
    const onKnock = ({ roomId } = {}) => {
      if (roomId === room.id) loadKnocks();
    };
    socket.on('knock-received', onKnock);
    socket.on('knock-withdrawn', onKnock);
    return () => {
      socket.off('knock-received', onKnock);
      socket.off('knock-withdrawn', onKnock);
    };
  }, [room.id, loadKnocks]);

  // Answer a knock: admit adds the knocker as a member (the response
  // carries the fresh room JSON); decline just clears it. Either way
  // the row leaves the panel at once — a failed answer reloads the
  // list instead of guessing.
  const answerKnock = async (knockId, admit) => {
    setAnsweringKnock(knockId);
    setKnockError('');
    try {
      const res = admit ? await admitKnock(knockId) : await declineKnock(knockId);
      setKnocks((prev) => prev.filter((k) => k.id !== knockId));
      if (admit && res.room?.members) setMembers(res.room.members);
    } catch (err) {
      setKnockError(err.message);
      loadKnocks();
    } finally {
      setAnsweringKnock(null);
    }
  };

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

  // Campfire "Keep this room": make this room permanent. The server
  // answers 410 if the room already faded (lost the race to cleanup);
  // the button hides on success and the room list refreshes live from
  // the server's rooms-changed push.
  const keepThisRoom = async () => {
    setKeepError('');
    setKeepBusy(true);
    try {
      await keepRoom(room.id);
      setKept(true);
    } catch (err) {
      setKeepError(err.message);
    } finally {
      setKeepBusy(false);
    }
  };

  const leaveMembership = async () => {
    if (!window.confirm(`Leave the private room "${room.name}"? You will need a new invite to come back.`)) return;
    setLeaving(true);
    try {
      await leavePrivateRoom(room.id);
      onLeave(buildSnapshot());
    } catch (err) {
      setInviteError(err.message);
      setLeaving(false);
    }
  };

  const pickImage = async (file) => {
    const check = validateImageFile(file);
    if (!check.ok) { setUploadError(check.error); return; }
    setUploadError('');
    let dims = {};
    try {
      dims = await readImageDimensions(file);
    } catch {
      setUploadError('That file is not a valid image');
      return;
    }
    setPendingImage((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return {
        file, previewUrl: URL.createObjectURL(file),
        width: dims.width, height: dims.height, progress: 0, uploading: false
      };
    });
  };

  const cancelPendingImage = () => {
    setPendingImage((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setUploadError('');
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    const text = draft.trim();
    if ((!text && !pendingImage) || sending) return;
    setSending(true);
    let media;
    if (pendingImage) {
      // Upload first — the message carries the returned URL, so a
      // failed upload never sends a broken image.
      setPendingImage((p) => p && { ...p, uploading: true });
      try {
        media = await uploadImage(pendingImage.file, {
          width: pendingImage.width,
          height: pendingImage.height,
          onProgress: (pct) => setPendingImage((p) => p && { ...p, progress: pct })
        });
      } catch (err) {
        setUploadError(err.message);
        setPendingImage((p) => p && { ...p, uploading: false });
        setSending(false);
        return;
      }
      setPendingImage((prev) => {
        if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
        return null;
      });
    }
    setDraft('');
    setSending(false);
    getSocket().emit('chat-message', { roomId: room.id, text, media });
  };

  // Together mode: start/stop the shared focus timer, and switch the
  // room's mode. Start/stop go over the socket (the server broadcasts
  // the result to the whole room); the mode switch is a REST call
  // whose response carries the fresh room, and the server also
  // broadcasts 'room-mode-changed' to the other members. Starting
  // while one runs is a server-side conflict — the second start is
  // refused, never a second session.
  const startFocus = () => {
    if (focusBusy) return;
    setFocusError('');
    setFocusBusy(true);
    getSocket().emit('focus-start', { roomId: room.id, durationSec: focusMinutes * 60 });
    // GA4: the initiator's click only (the 'focus-started' broadcast
    // reaches every occupant, so tracking there would count once per
    // person in the room). Coarse numeric param only — no room/user id.
    trackEvent('focus_started', { duration_minutes: focusMinutes });
    // focus-started clears the spinner; the timeout covers the error
    // path, where no session arrives to clear it.
    setTimeout(() => setFocusBusy(false), 1500);
  };
  const stopFocus = () => {
    getSocket().emit('focus-stop', { roomId: room.id });
  };
  const switchMode = async (next) => {
    if (next === mode || modeBusy) return;
    setModeBusy(true);
    setFocusError('');
    try {
      const updated = await setRoomMode(room.id, next);
      setMode(updated?.mode || next);
    } catch (err) {
      setFocusError(err.message);
    } finally {
      setModeBusy(false);
    }
  };

  const people = Object.values(occupants);
  // My mood: the live presence row wins (it just changed in-room);
  // the profile is the fallback for the first render.
  const myMood = normalizeMood(occupants.self?.mood ?? user.mood);
  // Effective orb positions: deterministic layout defaults, with
  // drag/keyboard/remote overrides on top. A reshuffle (join/leave)
  // moves only the orbs nobody has placed by hand.
  const defaultPositions = orbPositions(people, spaceSize);
  const positions = defaultPositions.map((p) => {
    const ov = orbOverrides[p.id];
    return ov ? { ...p, x: ov.x, y: ov.y } : p;
  });
  // Together mode, derived for render: remaining time from the
  // server's startedAt (never a local countdown), the ring's elapsed
  // fraction, and the wall-clock end time.
  const focusRemaining = focusSession ? remainingMs(focusSession, focusNow) : 0;
  const focusActive = !!focusSession && focusRemaining > 0;
  const focusProg = focusSession ? focusProgress(focusSession, focusNow) : 0;
  const focusEndsAt = focusSession
    ? new Date(focusSession.startedAt + focusSession.durationSec * 1000)
    : null;
  const posById = Object.fromEntries(positions.map((p) => [p.id, p]));

  // Keep the voice engine's "my position" in step with the effective
  // position — including layout reshuffles, which moveSelf never sees.
  // (moveSelf already sets it on drag/keys/reset; this is idempotent.)
  const selfPos = posById.self;
  useEffect(() => {
    if (!selfPos) return;
    selfPosRef.current = { x: selfPos.x, y: selfPos.y };
    voiceRef.current?.setSelfPosition(selfPos.x, selfPos.y);
  }, [selfPos?.x, selfPos?.y]);

  // Huddles: clusters of orbs closer than the threshold, with
  // hysteresis from the previous frame so a bubble does not flicker
  // while two orbs hover near the boundary.
  const huddles = clusterHuddles(
    positions.map((p) => ({ id: p.id, x: p.x, y: p.y })),
    prevHuddlesRef.current
  );
  useEffect(() => { prevHuddlesRef.current = huddles; });

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

  // Record every occupant sighting for the postcard: someone who was
  // here for part of my stay counts even if they left before I did,
  // so the list is the whole stay, not just the moment I leave. First
  // sighting wins per user id; avatar data merges in when the lookup
  // above resolves (photos/presets render via the shared Avatar).
  useEffect(() => {
    for (const person of Object.values(occupants)) {
      if (!person?.userId) continue;
      const id = String(person.userId);
      const avatar = person.isSelf ? user : occupantAvatars[person.userId];
      const prev = seenRef.current.get(id);
      seenRef.current.set(id, {
        id,
        name: person.name || prev?.name || 'Unnamed',
        avatarPreset: avatar?.avatarPreset || prev?.avatarPreset || '',
        avatarImage: avatar?.avatarImage || prev?.avatarImage || ''
      });
    }
  }, [occupants, occupantAvatars, user]);

  const isSpeaking = (person) => {
    if (person.isSelf) return speaking.selfSpeaking;
    return (speaking.levels[person.socketId] || 0) > 0.25;
  };
  // Private-room role for the orb popover (owner / moderator / member).
  const roleOf = (userId) => (members.find((m) => m.id === userId) || {}).role || null;

  // The postcard handover: the sightings list, with the freshest
  // avatar data merged in, plus the room's effective campfire state.
  // App builds the card from this + the voice session's joinedAt;
  // a leave with no snapshot (kicked, logout) simply shows no card.
  // `ephemeral` is the effective state at leave time: a campfire the
  // owner kept (kept) is permanent now, so it gets a card; a campfire
  // that was never kept does not. The faded screen below never passes
  // a snapshot at all, so a campfire fading under you shows no card
  // either — its hard-delete promise is untouched.
  const buildSnapshot = useCallback(() => ({
    ephemeral: room.ephemeral && !kept,
    seen: [...seenRef.current.values()].map((person) => {
      const avatar = occupantAvatars[person.id];
      return {
        ...person,
        avatarPreset: avatar?.avatarPreset || person.avatarPreset || '',
        avatarImage: avatar?.avatarImage || person.avatarImage || ''
      };
    })
  }), [occupantAvatars, kept, room.ephemeral]);

  const handleLeave = useCallback(() => {
    onLeave(buildSnapshot());
  }, [onLeave, buildSnapshot]);

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

  if (faded) {
    return (
      <div className="room-view">
        <div className="card kicked-card">
          <h2>This campfire faded</h2>
          <p className="muted">“{room.name}” closed 1 minute after the last person left. Campfires are temporary — create a new one anytime.</p>
          {/* No snapshot here, by design: campfires never get a
              postcard (permanent rooms only), and the room is gone —
              the faded notice is the whole goodbye. */}
          <button className="btn btn-primary" onClick={onLeave}>Back to rooms</button>
        </div>
      </div>
    );
  }

  if (roomFull) {
    return (
      <div className="room-view">
        <div className="card kicked-card">
          <h2>“{room.name}” is full</h2>
          <p className="muted">8 people are already in here — voice works best with a small group. Try again when someone leaves.</p>
          <button className="btn btn-primary" onClick={onLeave}>Back to rooms</button>
        </div>
      </div>
    );
  }

  return (
    <div className={`room-view${sharing || remoteShare ? ' room-view--sharing' : ''}`} style={{ '--room-from': accent.from, '--room-to': accent.to }}>
      <div className="room-header">
        <button className="btn btn-text" onClick={handleLeave}><Icon name="chevron-left" size={16} /> Rooms</button>
        <div className="room-title">
          <strong>
            {room.isPrivate && <span className="lock-badge" title="Private room"><Icon name="lock" size={12} /> </span>}
            {room.name}
          </strong>
          {room.topic && <span className="muted">{room.topic}</span>}
        </div>
        <span className="room-count">
          <span className="count-dot" /> {people.length} here
        </span>
        <button
          className="btn btn-text invite-link-btn"
          onClick={openLinkPanel}
          title="Copy invite link"
          aria-label="Copy invite link"
          aria-expanded={showLink}
        >
          <Icon name="link" size={16} />
        </button>
        {/* Minimize (v0.9.0): leave the room VIEW without leaving the
            call — the view hides, RoomView stays mounted, and the
            MiniPlayer takes over. The way back is the MiniPlayer.
            Distinct from the "‹ Rooms" button above, which leaves
            the call entirely (and builds the postcard). */}
        <button
          className="btn btn-text"
          onClick={onMinimize}
          title="Minimize — keep the call running"
          aria-label="Minimize room view, keep call running"
        >
          <Icon name="chevron-down" size={16} /> Minimize
        </button>
      </div>

      {/* Campfire state: everyone in the room sees that it fades; the
          owner (creator, or the role-owner after a transfer) can keep
          it permanent. No countdown — the playbook states the 1-minute
          rule, it does not ask for a ticking timer. */}
      {room.ephemeral && !kept && (
        <p className="campfire-line">
          <Icon name="flame" size={14} /> Campfire — closes 1 min after everyone leaves.
          {(String(room.createdBy) === String(user.id) || isOwner) && (
            <button className="btn btn-text btn-small" disabled={keepBusy} onClick={keepThisRoom}>
              {keepBusy ? 'Keeping…' : 'Keep this room'}
            </button>
          )}
        </p>
      )}
      {room.ephemeral && kept && (
        <p className="campfire-line campfire-line--kept">
          <Icon name="flame" size={14} /> Kept — this room won’t fade.
        </p>
      )}
      {keepError && <p className="mic-error">{keepError}</p>}

      {/* Together mode: the room-mode switch (owner/moderators only)
          and, in a focus room, the shared focus timer. The ring is a
          plain SVG whose stroke updates from React state once a
          second — no CSS animation on it, so it stays calm under
          prefers-reduced-motion by construction (the global rule
          stills its 1s transition too). */}
      {canControlFocusUi && (
        <div className="mode-toggle" role="group" aria-label="Room mode">
          <span className="muted">Room mode:</span>
          <button
            type="button"
            className={mode !== 'focus' ? 'selected' : ''}
            disabled={modeBusy}
            onClick={() => switchMode('talk')}
          >
            Talk
          </button>
          <button
            type="button"
            className={mode === 'focus' ? 'selected' : ''}
            disabled={modeBusy}
            onClick={() => switchMode('focus')}
          >
            Focus
          </button>
        </div>
      )}
      {mode === 'focus' && (
        <div className="focus-panel card">
          <div className="focus-ring-wrap">
            <svg
              className="focus-ring"
              width="72"
              height="72"
              viewBox="0 0 72 72"
              role="img"
              aria-label={focusActive ? `Focus timer, ${formatFocusRemaining(focusRemaining)} remaining` : 'No focus session running'}
            >
              <circle className="focus-ring-track" cx="36" cy="36" r="30" />
              <circle
                className="focus-ring-fill"
                cx="36"
                cy="36"
                r="30"
                strokeDasharray="188.5"
                strokeDashoffset={188.5 * (1 - focusProg)}
                transform="rotate(-90 36 36)"
              />
            </svg>
            <span className="focus-time" aria-hidden="true">
              {focusActive ? formatFocusRemaining(focusRemaining) : '—'}
            </span>
          </div>
          <div className="focus-info">
            <strong>{focusActive ? 'Focusing together' : 'Focus room'}</strong>
            <span className="muted">
              {focusActive
                ? 'Quiet time — everyone is here, working. The timer ends with a soft chime.'
                : 'A quiet room. The owner or a moderator starts a shared timer.'}
            </span>
            {focusActive && focusEndsAt && (
              <span className="muted">
                Ends {focusEndsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
          {canControlFocusUi && (
            <div className="focus-controls">
              {focusActive ? (
                <button className="btn btn-text" onClick={stopFocus}>Stop timer</button>
              ) : (
                <>
                  <label className="focus-duration">
                    <span className="muted">Timer</span>
                    <select
                      value={focusMinutes}
                      onChange={(e) => setFocusMinutes(Number(e.target.value))}
                      aria-label="Focus duration in minutes"
                    >
                      {FOCUS_PRESET_MINUTES.map((m) => (
                        <option key={m} value={m}>{m} min</option>
                      ))}
                    </select>
                  </label>
                  <button className="btn btn-primary btn-small" disabled={focusBusy} onClick={startFocus}>
                    {focusBusy ? 'Starting…' : 'Start focus'}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {focusError && <p className="error">{focusError}</p>}

      {micError && <p className="mic-error">{micError}</p>}

      {/* Screen sharing (v0.8.0): the floating "You are sharing"
          banner with its Stop button, and the refusal error (the
          room's one slot was already held). The banner has no
          animation, so prefers-reduced-motion needs nothing extra. */}
      {sharing && (
        <div className="sharing-banner" role="status">
          <Icon name="screen" size={16} /> You are sharing your screen
          <button className="btn btn-text btn-small" onClick={stopSharing}>Stop sharing</button>
        </div>
      )}
      {shareError && (
        <p className="mic-error" role="alert">
          {shareError}{' '}
          <button className="btn btn-text btn-small" onClick={() => dispatchSession({ type: 'share-clear-error' })}>Dismiss</button>
        </p>
      )}

      {/* Invite link panel: the room's shareable join link. In flow
          below the header (not absolute), so it can never hide behind
          the voice bar. */}
      {showLink && (
        <div className="invite-link-panel card">
          <div className="invite-link-head">
            <strong><Icon name="link" size={15} /> Invite link</strong>
            <button className="btn btn-text btn-small" onClick={() => setShowLink(false)} aria-label="Close invite link">
              <Icon name="x" size={14} />
            </button>
          </div>
          {linkLoading && <p className="muted">Making your link…</p>}
          {!linkLoading && linkInfo && (
            <>
              <div className="invite-link-row">
                <input
                  ref={linkInputRef}
                  readOnly
                  value={linkUrl}
                  onClick={(e) => e.target.select()}
                  aria-label="Invite link"
                />
                <button className="btn btn-primary btn-small" onClick={copyLink}>
                  {copied ? (<><Icon name="check" size={13} /> Copied</>) : 'Copy'}
                </button>
              </div>
              <p className="muted members-note">
                {room.isPrivate ? (
                  <>
                    Only friends of {linkInfo.createdBy.id === user.id ? 'yours' : (linkInfo.createdBy.name || 'the person who made this link')} can join with this link.
                    {linkInfo.expiresAt ? (
                      <> It expires {new Date(linkInfo.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' })} — revoke it and make a new one for a fresh link.</>
                    ) : null}
                  </>
                ) : (
                  'Anyone with this link can join — this room is public.'
                )}
              </p>
              <div className="invite-link-actions">
                <button className="btn btn-text btn-small" onClick={revokeLink}>Revoke link</button>
              </div>
            </>
          )}
          {!linkLoading && !linkInfo && !linkError && (
            <p className="muted">
              No invite link yet.{' '}
              <button className="btn btn-text btn-small" onClick={loadOrCreateLink}>Create one</button>
            </p>
          )}
          {linkError && <p className="error">{linkError}</p>}
        </div>
      )}

      {/* Room body: members panel + orb stage. They stack on mobile;
          on desktop (min-width: 900px in index.css) the panel becomes
          a sticky side column next to the stage. */}
      <div className={`room-body${room.isPrivate ? ' room-body--with-panel' : ''}`}>
      {room.isPrivate && (
        <div className={`members-panel card${membersOpen ? ' members-panel--open' : ''}`}>
          <div className="members-head">
            <button
              className="members-toggle"
              onClick={() => setMembersOpen((v) => !v)}
              aria-expanded={membersOpen}
              aria-controls="members-list"
            >
              <Icon name="users" size={15} /> Members ({members.length})
              <span className="members-toggle-chev" aria-hidden="true"><Icon name="chevron-left" size={14} /></span>
            </button>
            {canAnswerKnocks && knocks.length > 0 && (
              <span className="knock-badge" title={`${knocks.length} ${knocks.length === 1 ? 'person is' : 'people are'} knocking`}>
                <Icon name="knock" size={12} /> {knocks.length}
              </span>
            )}
            <span>
              <button className="btn btn-primary btn-small" onClick={openInvite}>
                {showInvite ? (<><Icon name="x" size={14} /> Close</>) : (<><Icon name="plus" size={14} /> Invite a friend</>)}
              </button>
              {' '}
              <button className="btn btn-text btn-small" disabled={leaving} onClick={leaveMembership}>
                {leaving ? 'Leaving…' : 'Leave room'}
              </button>
            </span>
          </div>
          <div className="members-list" id="members-list">
            {members.map((m, i) => {
              const isMe = m.id === user.id;
              const label = m.role === 'owner' ? (<><Icon name="crown" size={11} /> Owner</>) : m.role === 'moderator' ? (<><Icon name="shield" size={11} /> Mod</>) : null;
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
          {canAnswerKnocks && knocks.length > 0 && (
            <div className="knocks-section">
              <h4 className="knocks-title"><Icon name="knock" size={15} /> Knocking ({knocks.length})</h4>
              {knocks.map((k) => (
                <div key={k.id} className="person-row knock-row">
                  <Avatar user={k.user} size="sm" className="person-orb" />
                  <span className="person-info">
                    <strong>{k.user.name || 'Unnamed'}</strong>
                    <span className="muted person-email">Knocked {knockAge(k.createdAt)} — wants to join</span>
                  </span>
                  <span className="row-actions">
                    <button
                      className="btn btn-primary btn-small"
                      disabled={answeringKnock === k.id}
                      onClick={() => answerKnock(k.id, true)}
                    >
                      Admit
                    </button>
                    <button
                      className="btn btn-text btn-small"
                      disabled={answeringKnock === k.id}
                      onClick={() => answerKnock(k.id, false)}
                    >
                      Decline
                    </button>
                  </span>
                </div>
              ))}
              {knockError && <p className="error">{knockError}</p>}
            </div>
          )}
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
                      <span className="muted"><Icon name="check" size={13} /> Member</span>
                    ) : justInvited ? (
                      <span className="muted"><Icon name="check" size={13} /> Invited</span>
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

      <div className="room-stage">
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
        {/* Screen share layer (v0.8.0): a fixed z-index:0 element
            behind the orbs (z-index:2) that renders the incoming
            <video> for non-sharers — my own screen needs no preview.
            It sits after the starfield/nebula in the DOM so it paints
            above the sky, below the orbs. No animation or transition
            on the layer, ever (see share.css). */}
        {remoteShare && (
          <div className="share-layer" role="region" aria-label={`Screen shared by ${remoteSharerName}`}>
            <video ref={shareVideoRef} className="share-video" autoPlay playsInline />
            <span className="share-layer-label">{remoteSharerName} is sharing their screen</span>
            <button type="button" className="share-fullscreen-btn" onClick={enterShareFullscreen}>
              Tap to view full screen
            </button>
          </div>
        )}
        {/* Huddle bubbles: a soft dashed ring around each cluster of
            close orbs, with a text label naming who is in it. The
            dashed border + label are the non-colour cue — a huddle is
            never colour alone — and the bubble has no animation, so
            prefers-reduced-motion needs nothing extra here. */}
        {huddles.map((h) => {
          const w = (h.radius * 2 / 100) * spaceSize.width;
          const cx = (h.cx / 100) * spaceSize.width;
          const cy = (h.cy / 100) * spaceSize.height;
          const names = h.ids
            .map((id) => (occupants[id] ? occupants[id].name.split(' ')[0] : ''))
            .filter(Boolean)
            .join(' & ');
          return (
            <div
              key={h.ids.join('-')}
              className="huddle-bubble"
              style={{ left: cx - w / 2, top: cy - w / 2, width: w, height: w }}
              role="group"
              aria-label={`Huddle: ${names}`}
            >
              <span className="huddle-bubble-label">Huddle · {names}</span>
            </div>
          );
        })}
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
          // Mood glow (v0.7.0): my mood from the live row, theirs
          // from presence. The class sets the ring + pulse speed
          // (mood.css); the popover + aria-label carry the text, so
          // the state is never colour alone.
          const mood = person.isSelf ? myMood : normalizeMood(person.mood);
          // Photo in the orb when the person has one (self from App's
          // user, others from the occupant avatar lookup); otherwise
          // initials over the room accent, as before. A photo skips the
          // hue-rotate so it is not tinted. An animated character
          // (v0.7.0) fills the orb on its own gradient backdrop — also
          // without the hue-rotate, which would tint the character.
          const personAvatar = person.isSelf ? user : occupantAvatars[person.userId];
          const photo = personAvatar?.avatarImage || '';
          const character = !photo ? avatarCharacterById(personAvatar?.avatarPreset) : null;
          return (
            <div
              key={person.socketId}
              className={`orb-wrap ${selected ? 'selected' : ''}${person.isSelf ? ' orb-wrap--draggable' : ''}${person.isSelf && dragging ? ' orb-wrap--dragging' : ''}`}
              style={{
                '--tx': `${px}px`,
                '--ty': `${py}px`,
                width: pos.size,
                height: pos.size
              }}
              onClick={(e) => {
                e.stopPropagation();
                // A drag that moved the orb must not open its popover.
                if (justDraggedRef.current) return;
                tapOrb(person.socketId);
                setSelectedOrb(selected ? null : person.socketId);
              }}
              onPointerDown={person.isSelf ? onSelfPointerDown : undefined}
              onPointerMove={person.isSelf ? onSelfPointerMove : undefined}
              onPointerUp={person.isSelf ? onSelfPointerUp : undefined}
              onPointerCancel={person.isSelf ? onSelfPointerUp : undefined}
              role="button"
              tabIndex={0}
              aria-label={person.isSelf ? `${person.name} — your orb, ${moodLabel(mood)}, drag or use arrow keys to move` : `${person.name}, ${moodLabel(mood)}`}
              title={person.isSelf ? `${person.name} — ${moodLabel(mood)}, drag to move` : `${person.name} — ${moodLabel(mood)}`}
            >
              <div
                className="orb-bob"
                style={{ animationDelay: `${pos.delay}s`, animationDuration: `${pos.duration}s` }}
              >
                <div
                  className={`orb mood-${mood} ${speakingNow ? 'speaking' : ''} ${person.muted ? 'is-muted' : ''} ${tapOrbId === person.socketId ? 'orb-tapped' : ''}`}
                  style={photo
                    ? { backgroundImage: `url(${photo})`, backgroundSize: 'cover', backgroundPosition: 'center', '--mood-pulse': `${MOOD_META[mood].pulseSeconds}s` }
                    : character
                      ? { background: `linear-gradient(135deg, ${character.from}, ${character.to})`, '--mood-pulse': `${MOOD_META[mood].pulseSeconds}s` }
                      : {
                        background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
                        filter: `hue-rotate(${orbHue(person.userId)}deg)`,
                        '--mood-pulse': `${MOOD_META[mood].pulseSeconds}s`
                      }}
                >
                  {!photo && !character && <span className="orb-initials">{initials(person.name)}</span>}
                  {!photo && character && (
                    <span className="orb-character">
                      <CharacterArt characterId={character.id} label={`${character.name} avatar`} />
                    </span>
                  )}
                  <span className="orb-name">
                    {person.name.split(' ')[0]}{person.isSelf ? ' (you)' : ''}
                  </span>
                  {person.muted && <span className="orb-muted"><Icon name="mic-off" size={13} /></span>}
                  {person.isSelf && modMuted && (
                    <span className="orb-mod-muted"><Icon name="mic-off" size={12} /> Muted by moderator{modMutedBy ? ` — ${modMutedBy}` : ''}</span>
                  )}
                  {!person.isSelf && (
                    <SignalBars state={connState[person.socketId] || 'new'} />
                  )}
                </div>
              </div>
              {selected && (
                <div className={`orb-popover ${pos.y < 32 ? 'below' : ''}`}>
                  <span>
                    {person.name.split(' ')[0]}{person.isSelf ? ' (you)' : ''}
                  </span>
                  <span className="orb-mood-label">{moodLabel(mood)}</span>
                  {role === 'owner' && <span className="role-badge role-owner"><Icon name="crown" size={11} /> Owner</span>}
                  {role === 'moderator' && <span className="role-badge role-mod"><Icon name="shield" size={11} /> Mod</span>}
                  {person.muted && <span><Icon name="mic-off" size={13} /> Muted</span>}
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

      {/* The per-peer connection / ICE text used to sit here as an
          always-on debug line. It now lives behind a "Connection
          details" popover; each orb carries a small signal-bars icon
          instead (see SignalBars). */}
      {people.length > 1 && (
        <div className="conn-details">
          <button
            className="conn-details-btn"
            onClick={() => setShowConnDetails((v) => !v)}
            aria-expanded={showConnDetails}
          >
            Connection details
          </button>
          {showConnDetails && (
            <div className="conn-popover" role="dialog" aria-label="Connection details">
              {people
                .filter((p) => !p.isSelf)
                .map((p) => (
                  <div key={p.socketId} className="conn-popover-row">
                    <span>{p.name.split(' ')[0]}</span>
                    <span>
                      {connState[p.socketId] || '—'} / {iceState[p.socketId] || '—'}
                      {candTypes[p.socketId] ? ` (${candTypes[p.socketId]})` : ''}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
      <p className="shortcuts-hint">
        <kbd>M</kbd> mute · <kbd>D</kbd> deafen · <kbd>C</kbd> chat · <kbd>Esc</kbd> close · <kbd>←↑↓→</kbd> move your orb
      </p>
      {/* Proximity controls: reset my orb to its layout spot, and the
          spatial-audio switch (the runtime half of the
          SPATIAL_AUDIO_ENABLED kill switch — off restores flat voice).
          The hint states the deal in one line: closer = louder. */}
      <div className="proximity-controls">
        <button className="btn btn-text btn-small" onClick={resetPosition}>
          Reset position
        </button>
        <button
          className="btn btn-text btn-small"
          onClick={toggleSpatial}
          aria-pressed={spatialOn}
          title={spatialOn ? 'Spatial audio on — closer sounds louder' : 'Spatial audio off — everyone at full volume'}
        >
          Spatial audio: {spatialOn ? 'On' : 'Off'}
        </button>
        <span className="muted proximity-note">Drag your orb to move closer — louder up close, quieter far away.</span>
      </div>
      {/* Mood + audio settings (v0.7.0): my mood picker lives here
          (the orb popover is pointer-events: none, so it cannot hold
          buttons), and the audio panel opens in flow below it. */}
      <div className="mood-row">
        <span className="muted">My mood:</span>
        <MoodPicker value={myMood} onChange={setMood} label="My mood" />
        <button
          className="btn btn-text btn-small"
          onClick={() => setShowAudio((v) => !v)}
          aria-expanded={showAudio}
          title="Microphone, speaker and volume settings"
        >
          <Icon name="settings" size={14} /> Audio settings
        </button>
      </div>
      {showAudio && (
        <AudioSettings
          voiceRef={voiceRef}
          peers={people.filter((p) => !p.isSelf).map((p) => ({ socketId: p.socketId, name: p.name }))}
          onClose={() => setShowAudio(false)}
        />
      )}
      {playBlocked && (
        <button
          className="btn btn-primary sound-btn"
          onClick={async () => {
            const ok = await voiceRef.current?.retryPlayback();
            setPlayBlocked(!ok);
          }}
        >
          <Icon name="volume" size={16} /> Tap to enable sound
        </button>
      )}

      {chatOpen && (
        <div
          className={`chat-sheet ${dragOver ? 'chat-drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer?.files?.[0];
            if (f) pickImage(f);
          }}
        >
          <div className="chat-head">
            <strong>Chat — {room.name}</strong>
            <button className="btn btn-text" onClick={() => setChatOpen(false)} aria-label="Close chat"><Icon name="x" size={16} /></button>
          </div>
          <div className="chat-messages">
            {messages.length === 0 && (
              <p className="muted chat-empty">No messages yet. Say hi</p>
            )}
            {messages.map((m) => (
              <ChatMessage
                key={m.id}
                name={m.userId === user.id ? 'You' : m.name}
                mine={m.userId === user.id}
                text={m.text}
                media={m.media}
                createdAt={m.createdAt}
              />
            ))}
            <div ref={chatEndRef} />
          </div>
          <form className="chat-input" onSubmit={sendMessage}>
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) pickImage(f);
                e.target.value = '';
              }}
            />
            <button type="button" className="btn btn-text chat-attach" onClick={() => fileInputRef.current?.click()} aria-label="Attach an image" title="Attach an image" disabled={sending}>
              <Icon name="image" size={18} />
            </button>
            <input
              placeholder={`Message ${room.name}…`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={1000}
              onPaste={(e) => {
                const f = e.clipboardData?.files?.[0];
                if (f) pickImage(f);
              }}
            />
            <button className="btn btn-primary" type="submit" disabled={sending}><Icon name="send" size={15} /> Send</button>
          </form>
          {pendingImage && (
            <div className="chat-upload">
              <img src={pendingImage.previewUrl} alt={pendingImage.file.name} />
              <div className="chat-upload-meta">
                <span className="chat-upload-name">{pendingImage.file.name}</span>
                <div className="chat-upload-bar" role="progressbar" aria-valuenow={pendingImage.progress} aria-valuemin={0} aria-valuemax={100}>
                  <span style={{ width: `${pendingImage.progress}%` }} />
                </div>
                <span className="muted">{pendingImage.uploading ? `Uploading… ${pendingImage.progress}%` : 'Ready to send'}</span>
              </div>
              <button type="button" className="btn btn-text" onClick={cancelPendingImage} aria-label="Remove image" disabled={pendingImage.uploading}>
                <Icon name="x" size={14} />
              </button>
            </div>
          )}
          {uploadError && <p className="error chat-upload-error">{uploadError}</p>}
          <p className="muted chat-fade-note">Messages disappear after 24 hours.</p>
        </div>
      )}

      <div className="voice-bar">
        <button
          className={`voice-btn ${muted ? 'off' : ''}`}
          onClick={toggleMute}
          disabled={modMuted}
          title={modMuted ? 'Muted by moderator' : 'Mute (M)'}
          aria-label={modMuted ? 'Muted by moderator' : muted ? 'Unmute' : 'Mute'}
        >
          <span key={muted ? 'off' : 'on'} className="voice-ico"><Icon name={muted ? 'mic-off' : 'mic'} size={26} /></span>
        </button>
        <button
          className={`voice-btn ${deafened ? 'off' : ''}`}
          onClick={toggleDeafen}
          title="Deafen (D)"
          aria-label={deafened ? 'Undeafen' : 'Deafen'}
        >
          <span key={deafened ? 'off' : 'on'} className="voice-ico"><Icon name={deafened ? 'headphones-off' : 'headphones'} size={26} /></span>
        </button>
        <button className="voice-btn" onClick={openChat} title="Chat (C)" aria-label="Chat">
          <Icon name="chat" size={26} />
          {unread > 0 && <span className="unread-badge">{unread}</span>}
        </button>
        {/* Screen sharing (v0.8.0): desktop only — phones are
            view-only, so canShare is false ≤520px and the button never
            renders there (JS gate, not CSS, so the single ≤520px media
            block stays untouched). While sharing it doubles as Stop. */}
        {canShare && (
          <button
            className={`voice-btn voice-btn--share ${sharing ? 'sharing' : ''}`}
            onClick={sharing ? stopSharing : startSharing}
            title={sharing ? 'Stop sharing' : 'Share your screen'}
            aria-label={sharing ? 'Stop sharing' : 'Share your screen'}
            aria-pressed={sharing}
          >
            <Icon name="screen" size={26} />
          </button>
        )}
        <button className="voice-btn leave" onClick={handleLeave} title="Leave room" aria-label="Leave room">
          <Icon name="phone" size={26} />
        </button>
      </div>
      {/* Reconnecting (v0.9.0): the transport dropped mid-call and
          recovery is running — say so instead of failing silently.
          Plain text, no animation, so prefers-reduced-motion needs
          nothing special here. */}
      {session.status === 'reconnecting' && (
        <p className="reconnecting-note" role="status" title="Your connection dropped — trying to reconnect. The call resumes on its own when the network is back.">
          Reconnecting…
        </p>
      )}
      {modMuted && (
        <p className="mod-muted-note">
          <Icon name="mic-off" size={12} /> Muted by moderator{modMutedBy ? ` (${modMutedBy})` : ''} — you can still hear everyone, but they can't hear you.
        </p>
      )}
      </div>
      </div>
    </div>
  );
}
