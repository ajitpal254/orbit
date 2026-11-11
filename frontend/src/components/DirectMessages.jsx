// Direct messages: 1:1 chat with accepted friends only (enforced
// server-side). Conversation list on the left, thread view with bubbles
// when one is open. Reuses the room-chat bubble styles from RoomView.
// A `dm-message` socket push (handled in App.jsx) bumps refreshTick, so
// lists and badges update live; opening a thread marks it read.
import React, { useEffect, useRef, useState } from 'react';
import { getDms, getDmThread, sendDm } from '../api';
import { initials } from '../orbLayout';

const timeOf = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function DirectMessages({ user, refreshTick, dmUser, clearDmUser, onMessagesRead }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null); // { userId, name, email }
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef(null);
  const onMessagesReadRef = useRef(onMessagesRead);
  onMessagesReadRef.current = onMessagesRead;

  const loadList = async () => {
    try {
      setConversations(await getDms());
    } catch {}
  };

  useEffect(() => { loadList(); }, [refreshTick]);

  // A friend picked from the Friends tab ("Message") opens their thread.
  useEffect(() => {
    if (!dmUser) return;
    setSelected({ userId: dmUser.id, name: dmUser.name, email: dmUser.email });
    clearDmUser();
  }, [dmUser, clearDmUser]);

  // Thread load: on select and whenever a DM arrives (refreshTick).
  // After loading, if any of their messages to me were unread, tell App
  // to refresh — the next fetch then finds them read, so this never loops.
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    getDmThread(selected.userId)
      .then((data) => {
        if (cancelled) return;
        setMessages(data || []);
        if ((data || []).some((m) => m.senderId !== user.id && !m.read)) {
          onMessagesReadRef.current();
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [selected, refreshTick, user.id]);

  // Auto-scroll to the newest message.
  useEffect(() => {
    if (selected && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, selected]);

  const send = async (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !selected || sending) return;
    setDraft('');
    setError('');
    setSending(true);
    try {
      const msg = await sendDm(selected.userId, text);
      setMessages((prev) => [...prev, msg]);
      await loadList();
    } catch (err) {
      setError(err.message);
      setDraft(text);
    } finally {
      setSending(false);
    }
  };

  if (selected) {
    return (
      <div className="view view-anim dm-thread">
        <div className="dm-thread-head">
          <button className="btn btn-text" onClick={() => setSelected(null)}>← Messages</button>
          <span className="mini-orb person-orb">{initials(selected.name || selected.email)}</span>
          <span className="person-info">
            <strong>{selected.name || 'Unnamed'}</strong>
            <span className="muted person-email">{selected.email}</span>
          </span>
        </div>

        <div className="dm-messages">
          {messages.length === 0 && (
            <p className="muted chat-empty">No messages yet. Say hi 👋</p>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.senderId === user.id ? 'mine' : ''}`}>
              <span className="chat-name">{m.senderId === user.id ? 'You' : m.senderName}</span>
              <span className="chat-text">{m.text}</span>
              <span className="chat-time">{timeOf(m.createdAt)}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {error && <p className="error">{error}</p>}
        <form className="dm-input" onSubmit={send}>
          <input
            placeholder={`Message ${selected.name || 'them'}…`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={1000}
          />
          <button className="btn btn-primary" type="submit" disabled={sending}>Send</button>
        </form>
      </div>
    );
  }

  return (
    <div className="view view-anim">
      <div className="greeting">
        <p className="date-line">Private chats</p>
        <h2>Messages 💬</h2>
        <p className="muted">Direct messages with your friends.</p>
      </div>

      {conversations.length === 0 ? (
        <div className="card empty-state">
          <span className="big-emoji">💬</span>
          <p className="muted">
            No conversations yet — add a friend, then tap Message on their row.
          </p>
        </div>
      ) : (
        <div className="people-list">
          {conversations.map((c, i) => (
            <button
              key={c.userId}
              className="person-row dm-row stagger-in"
              style={{ animationDelay: `${i * 40}ms` }}
              onClick={() => setSelected({ userId: c.userId, name: c.name, email: c.email })}
            >
              <span className="mini-orb person-orb">{initials(c.name || c.email)}</span>
              <span className="person-info">
                <strong>{c.name || 'Unnamed'}</strong>
                <span className={`dm-preview ${c.unreadCount > 0 ? 'unread' : ''}`}>
                  {c.lastMessage
                    ? `${c.lastMessage.fromMe ? 'You: ' : ''}${c.lastMessage.text}`
                    : 'No messages yet'}
                </span>
              </span>
              <span className="dm-side">
                {c.lastMessage && <span className="dm-time">{timeOf(c.lastMessage.createdAt)}</span>}
                {c.unreadCount > 0 && <span className="dm-badge">{c.unreadCount}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
