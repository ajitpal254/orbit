// Direct messages: 1:1 chat with accepted friends only (enforced
// server-side). Conversation list on the left, thread view with bubbles
// when one is open. Reuses the room-chat bubble styles from RoomView.
// A `dm-message` socket push (handled in App.jsx) bumps refreshTick, so
// lists and badges update live; opening a thread marks it read.
import React, { useEffect, useRef, useState } from 'react';
import { getDms, getDmThread, sendDm, uploadImage } from '../api';
import { validateImageFile, readImageDimensions } from '../media';
import ChatMessage from './ChatMessage';
import Avatar from './Avatar';
import { Icon } from './icons';

const timeOf = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export default function DirectMessages({ user, refreshTick, dmUser, clearDmUser, onMessagesRead }) {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null); // { userId, name, email }
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  // Media sharing (v0.8.0) — same flow as room chat: pick (button,
  // drag-and-drop onto the thread, or paste), thumbnail + progress,
  // send only after the upload completes.
  const [pendingImage, setPendingImage] = useState(null); // { file, previewUrl, width, height, progress, uploading }
  const [uploadError, setUploadError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
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
    setSelected({
      userId: dmUser.id, name: dmUser.name, email: dmUser.email,
      avatarPreset: dmUser.avatarPreset, avatarImage: dmUser.avatarImage
    });
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

  const send = async (e) => {
    e.preventDefault();
    const text = draft.trim();
    if ((!text && !pendingImage) || !selected || sending) return;
    setDraft('');
    setError('');
    setSending(true);
    let media;
    if (pendingImage) {
      setPendingImage((p) => p && { ...p, uploading: true });
      try {
        media = await uploadImage(pendingImage.file, {
          width: pendingImage.width,
          height: pendingImage.height,
          onProgress: (pct) => setPendingImage((p) => p && { ...p, progress: pct })
        });
      } catch (err) {
        setError(err.message);
        setPendingImage((p) => p && { ...p, uploading: false });
        setSending(false);
        setDraft(text);
        return;
      }
      setPendingImage((prev) => {
        if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl);
        return null;
      });
    }
    try {
      const msg = await sendDm(selected.userId, text, media);
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
      <div
        className={`view view-anim dm-thread ${dragOver ? 'chat-drag-over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer?.files?.[0];
          if (f) pickImage(f);
        }}
      >
        <div className="dm-thread-head">
          <button className="btn btn-text" onClick={() => setSelected(null)}><Icon name="chevron-left" size={16} /> Messages</button>
          <Avatar user={selected} size="sm" className="person-orb" />
          <span className="person-info">
            <strong>{selected.name || 'Unnamed'}</strong>
            <span className="muted person-email">{selected.email}</span>
          </span>
        </div>

        <div className="dm-messages">
          {messages.length === 0 && (
            <p className="muted chat-empty">No messages yet. Say hi</p>
          )}
          {messages.map((m) => (
            <ChatMessage
              key={m.id}
              name={m.senderId === user.id ? 'You' : m.senderName}
              mine={m.senderId === user.id}
              text={m.text}
              media={m.media}
              createdAt={m.createdAt}
            />
          ))}
          <div ref={endRef} />
        </div>

        {error && <p className="error">{error}</p>}
        <form className="dm-input" onSubmit={send}>
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
            placeholder={`Message ${selected.name || 'them'}…`}
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
    );
  }

  return (
    <div className="view view-anim">
      <div className="greeting">
        <p className="date-line">Private chats</p>
        <h2><Icon name="chat" size={22} /> Messages</h2>
        <p className="muted">Direct messages with your friends.</p>
      </div>

      {conversations.length === 0 ? (
        <div className="card empty-state">
          <span className="empty-icon"><Icon name="chat" size={26} /></span>
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
              onClick={() => setSelected({
                userId: c.userId, name: c.name, email: c.email,
                avatarPreset: c.avatarPreset, avatarImage: c.avatarImage
              })}
            >
              <Avatar user={c} size="sm" className="person-orb" />
              <span className="person-info">
                <strong>{c.name || 'Unnamed'}</strong>
                <span className={`dm-preview ${c.unreadCount > 0 ? 'unread' : ''}`}>
                  {c.lastMessage
                    ? `${c.lastMessage.fromMe ? 'You: ' : ''}${c.lastMessage.text || (c.lastMessage.media ? '📷 Photo' : '')}`
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
