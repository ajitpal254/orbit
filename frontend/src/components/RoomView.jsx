import React, { useEffect, useRef, useState, useCallback } from 'react';
import { apiJson } from '../api';
import { getSocket } from '../socket';
import { VoiceEngine } from '../voice';
import { orbPositions, initials, orbHue } from '../orbLayout';

export default function RoomView({ user, room, onLeave }) {
  const [occupants, setOccupants] = useState(() => ({
    self: { socketId: 'self', userId: user.id, name: user.name, muted: false, isSelf: true }
  }));
  const [speaking, setSpeaking] = useState({ selfSpeaking: false, levels: {} });
  const [connState, setConnState] = useState({});
  const [iceState, setIceState] = useState({});
  const [playBlocked, setPlayBlocked] = useState(false);
  const [muted, setMuted] = useState(false);
  const [deafened, setDeafened] = useState(false);
  const [micError, setMicError] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [unread, setUnread] = useState(0);
  const voiceRef = useRef(null);
  const chatEndRef = useRef(null);
  const chatOpenRef = useRef(false);
  chatOpenRef.current = chatOpen;

  const accent = room.accent || { from: '#8b5cf6', to: '#d946ef' };

  useEffect(() => {
    const socket = getSocket();
    const voice = new VoiceEngine({
      socket,
      roomId: room.id,
      selfId: user.id,
      onSpeaking: (s) => setSpeaking(s),
      onMicError: (msg) => setMicError(msg),
      onConnectionState: (socketId, state, ice) => {
        setConnState((prev) => ({ ...prev, [socketId]: state }));
        if (ice) setIceState((prev) => ({ ...prev, [socketId]: ice }));
      },
      onPlaybackBlocked: () => setPlayBlocked(true)
    });
    voiceRef.current = voice;

    const onRoomState = ({ occupants: others }) => {
      setOccupants((prev) => {
        const next = { ...prev };
        for (const o of others || []) {
          next[o.socketId] = { socketId: o.socketId, userId: o.userId, name: o.name, muted: false };
        }
        return next;
      });
    };
    const onUserJoined = ({ socketId, userId, name }) => {
      setOccupants((prev) => ({
        ...prev,
        [socketId]: { socketId, userId, name, muted: false }
      }));
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

    socket.on('room-state', onRoomState);
    socket.on('user-joined', onUserJoined);
    socket.on('user-left', onUserLeft);
    socket.on('mic-state', onMicState);
    socket.on('chat-message', onChatMessage);

    apiJson(`/api/rooms/${room.id}/messages`).then(setMessages).catch(() => {});
    voice.join();

    return () => {
      voice.leave();
      socket.off('room-state', onRoomState);
      socket.off('user-joined', onUserJoined);
      socket.off('user-left', onUserLeft);
      socket.off('mic-state', onMicState);
      socket.off('chat-message', onChatMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  useEffect(() => {
    if (chatOpen && chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, chatOpen]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      voiceRef.current?.setMuted(next);
      setOccupants((prev) => ({
        ...prev,
        self: { ...prev.self, muted: next }
      }));
      return next;
    });
  }, []);

  const toggleDeafen = useCallback(() => {
    setDeafened((d) => {
      const next = !d;
      voiceRef.current?.setDeafened(next);
      return next;
    });
  }, []);

  const openChat = () => {
    setChatOpen((v) => !v);
    setUnread(0);
  };

  const sendMessage = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    getSocket().emit('chat-message', { roomId: room.id, text });
  };

  const people = Object.values(occupants);
  const positions = orbPositions(people);
  const posById = Object.fromEntries(positions.map((p) => [p.id, p]));

  const isSpeaking = (person) => {
    if (person.isSelf) return speaking.selfSpeaking;
    return (speaking.levels[person.socketId] || 0) > 0.25;
  };

  return (
    <div className="room-view">
      <div className="room-header">
        <button className="btn btn-text" onClick={onLeave}>← Rooms</button>
        <div className="room-title">
          <strong>{room.name}</strong>
          {room.topic && <span className="muted">{room.topic}</span>}
        </div>
        <span className="room-count">
          <span className="count-dot" /> {people.length} here
        </span>
      </div>

      {micError && <p className="mic-error">{micError}</p>}

      <div className="room-space">
        <div className="starfield" />
        <div
          className="room-halo"
          style={{ background: `radial-gradient(circle, ${accent.from}33, transparent 65%)` }}
        />
        {people.map((person) => {
          const pos = posById[person.socketId];
          if (!pos) return null;
          const speakingNow = isSpeaking(person);
          return (
            <div
              key={person.socketId}
              className={`orb ${speakingNow ? 'speaking' : ''} ${person.muted ? 'is-muted' : ''}`}
              style={{
                left: `${pos.x}%`,
                top: `${pos.y}%`,
                width: pos.size,
                height: pos.size,
                background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
                filter: `hue-rotate(${orbHue(person.userId)}deg)`,
                animationDelay: `${pos.delay}s`,
                animationDuration: `${pos.duration}s`
              }}
            >
              <span className="orb-initials">{initials(person.name)}</span>
              <span className="orb-name">
                {person.name.split(' ')[0]}{person.isSelf ? ' (you)' : ''}
              </span>
              {person.muted && <span className="orb-muted">🔇</span>}
              {!person.isSelf && (
                <span
                  className={`conn-dot conn-${connState[person.socketId] || 'new'}`}
                  title={`Voice: ${connState[person.socketId] || 'connecting…'}`}
                />
              )}
            </div>
          );
        })}
        {people.length === 1 && (
          <p className="room-hint">You're alone in here — friends join from the home screen.</p>
        )}
      </div>

      {people.length > 1 && (
        <div className="voice-status">
          {people
            .filter((p) => !p.isSelf)
            .map((p) => (
              <span key={p.socketId}>
                {p.name.split(' ')[0]}: {connState[p.socketId] || 'connecting'} /{' '}
                {iceState[p.socketId] || 'checking'}
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
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? '🔇' : '🎙️'}
        </button>
        <button
          className={`voice-btn ${deafened ? 'off' : ''}`}
          onClick={toggleDeafen}
          aria-label={deafened ? 'Undeafen' : 'Deafen'}
        >
          {deafened ? '🔕' : '🔊'}
        </button>
        <button className="voice-btn" onClick={openChat} aria-label="Chat">
          💬
          {unread > 0 && <span className="unread-badge">{unread}</span>}
        </button>
        <button className="voice-btn leave" onClick={onLeave} aria-label="Leave room">
          📞
        </button>
      </div>
    </div>
  );
}
