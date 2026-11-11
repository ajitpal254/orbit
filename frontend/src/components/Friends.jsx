// Friends: find people by name/email, send/accept/decline requests, and
// remove friends. Only accepted friends can be invited to private rooms,
// so this screen is the front door to private rooms.
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  searchUsers, getFriends, sendFriendRequest,
  acceptFriendRequest, declineFriendRequest, removeFriend
} from '../api';
import { initials } from '../orbLayout';

export default function Friends({ refreshTick, onMessage }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [friends, setFriends] = useState([]);
  const [pendingReceived, setPendingReceived] = useState([]);
  const [pendingSent, setPendingSent] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null); // user id of the in-flight action
  const timerRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await getFriends();
      setFriends(data.friends || []);
      setPendingReceived(data.pendingReceived || []);
      setPendingSent(data.pendingSent || []);
    } catch {}
  }, []);

  useEffect(() => { load(); }, [load, refreshTick]);

  // Debounced search — fires 300ms after the last keystroke, and never
  // for a query shorter than 2 characters.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timerRef.current = setTimeout(async () => {
      try {
        setResults(await searchUsers(q));
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [query]);

  const act = async (userId, fn) => {
    setError('');
    setBusy(userId);
    try {
      await fn();
      await load();
      // A sent request should flip to "Requested" without retyping.
      if (query.trim().length >= 2) setResults(await searchUsers(query.trim()));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="view">
      <div className="greeting">
        <p className="date-line">Your people</p>
        <h2>Friends 👋</h2>
        <p className="muted">Add friends to invite them to private rooms.</p>
      </div>

      <input
        placeholder="Search by name or email…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoComplete="off"
      />
      {searching && <p className="muted">Searching…</p>}
      {error && <p className="error">{error}</p>}

      {results.length > 0 && (
        <section>
          <h3 className="section-title">Results</h3>
          <div className="people-list">
            {results.map((u) => (
              <PersonRow
                key={u.id}
                person={u}
                busy={busy === u.id}
                action={
                  u.friendship === 'friends' ? (
                    <span className="row-actions">
                      {onMessage && (
                        <button
                          className="btn btn-primary btn-small"
                          onClick={() => onMessage(u)}
                        >
                          Message
                        </button>
                      )}
                      <span className="muted">Friends ✓</span>
                    </span>
                  ) : u.friendship === 'pending-sent' ? (
                    <span className="muted">Requested ✓</span>
                  ) : u.friendship === 'pending-received' ? (
                    <button
                      className="btn btn-primary btn-small"
                      disabled={busy === u.id}
                      onClick={() => act(u.id, () => acceptFriendRequest(u.id))}
                    >
                      Accept
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary btn-small"
                      disabled={busy === u.id}
                      onClick={() => act(u.id, () => sendFriendRequest(u.id))}
                    >
                      Add
                    </button>
                  )
                }
              />
            ))}
          </div>
        </section>
      )}

      {pendingReceived.length > 0 && (
        <section>
          <h3 className="section-title">Requests for you</h3>
          <div className="people-list">
            {pendingReceived.map((u) => (
              <PersonRow
                key={u.id}
                person={u}
                busy={busy === u.id}
                action={
                  <span className="row-actions">
                    <button
                      className="btn btn-primary btn-small"
                      disabled={busy === u.id}
                      onClick={() => act(u.id, () => acceptFriendRequest(u.id))}
                    >
                      Accept
                    </button>
                    <button
                      className="btn btn-text btn-small"
                      disabled={busy === u.id}
                      onClick={() => act(u.id, () => declineFriendRequest(u.id))}
                    >
                      Decline
                    </button>
                  </span>
                }
              />
            ))}
          </div>
        </section>
      )}

      {pendingSent.length > 0 && (
        <section>
          <h3 className="section-title">Requests you sent</h3>
          <div className="people-list">
            {pendingSent.map((u) => (
              <PersonRow key={u.id} person={u} action={<span className="muted">Requested ✓</span>} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h3 className="section-title">
          Friends {friends.length > 0 && `(${friends.length})`}
        </h3>
        {friends.length === 0 ? (
          <p className="muted">No friends yet — search above to add someone.</p>
        ) : (
          <div className="people-list">
            {friends.map((u) => (
              <PersonRow
                key={u.id}
                person={u}
                busy={busy === u.id}
                action={
                  <span className="row-actions">
                    {onMessage && (
                      <button
                        className="btn btn-primary btn-small"
                        onClick={() => onMessage(u)}
                      >
                        Message
                      </button>
                    )}
                    <button
                      className="btn btn-text btn-small"
                      disabled={busy === u.id}
                      onClick={() => {
                        if (window.confirm(`Remove ${u.name || u.email} as a friend?`)) {
                          act(u.id, () => removeFriend(u.id));
                        }
                      }}
                    >
                      Remove
                    </button>
                  </span>
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function PersonRow({ person, action, busy }) {
  return (
    <div className={`person-row ${busy ? 'busy' : ''}`}>
      <span className="mini-orb person-orb">{initials(person.name || person.email)}</span>
      <span className="person-info">
        <strong>{person.name || 'Unnamed'}</strong>
        <span className="muted person-email">{person.email}</span>
      </span>
      {action}
    </div>
  );
}
