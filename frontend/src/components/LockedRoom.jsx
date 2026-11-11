// Locked room: a private room the user is not a member of, opened
// from a shared link, a deep link or a push tap. GET /api/rooms/:id
// answers such a room with a 403 + a locked stub ({ id, name }), and
// this screen turns that into a knock instead of a silent bounce to
// the rooms list. The owner/moderators answer from the room's members
// panel; an admit while this screen is open joins the room live.
import React, { useEffect, useState, useCallback } from 'react';
import { apiJson, getKnockStatus, knockOnRoom, withdrawKnock } from '../api';
import { getSocket } from '../socket';
import { Icon } from './icons';

export default function LockedRoom({ room, onJoined, onBack }) {
  const [status, setStatus] = useState(null); // { knock, isMember, canKnock, reason }
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [gone, setGone] = useState(''); // room faded / deleted while here

  const load = useCallback(async () => {
    try {
      const s = await getKnockStatus(room.id);
      setStatus(s);
      setError('');
      if (s.isMember) {
        // Admitted while this screen was open — fetch the full room
        // and join it instead of showing a stale lock.
        const full = await apiJson(`/api/rooms/${room.id}`);
        onJoined(full);
      }
    } catch (err) {
      if (err.status === 410) setGone(err.message || 'This room has faded');
      else if (err.status === 404) setGone('This room no longer exists');
      else setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [room.id, onJoined]);

  useEffect(() => { load(); }, [load]);

  // Live answer: an admit/decline while this screen is open refreshes
  // the state (an admit flows into onJoined via load's isMember check).
  useEffect(() => {
    const socket = getSocket();
    const onAnswered = ({ roomId } = {}) => {
      if (roomId === room.id) load();
    };
    socket.on('knock-admitted', onAnswered);
    socket.on('knock-declined', onAnswered);
    return () => {
      socket.off('knock-admitted', onAnswered);
      socket.off('knock-declined', onAnswered);
    };
  }, [room.id, load]);

  const knock = async () => {
    setBusy(true);
    setError('');
    try {
      const k = await knockOnRoom(room.id);
      setStatus((s) => ({ ...s, knock: k }));
    } catch (err) {
      if (err.status === 429 && err.knock) {
        // Already knocked within 30s — the server returns the pending
        // knock with the 429; show the pending state, not an error.
        setStatus((s) => ({ ...s, knock: err.knock }));
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setBusy(true);
    setError('');
    try {
      await withdrawKnock(room.id);
      setStatus((s) => ({ ...s, knock: null }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (gone) {
    return (
      <div className="view view-anim locked-room">
        <button className="btn btn-text back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Back</button>
        <div className="card locked-card">
          <span className="locked-icon"><Icon name="lock" size={26} /></span>
          <h2>{room.name}</h2>
          <p className="muted">{gone}</p>
        </div>
      </div>
    );
  }

  const pending = status?.knock;

  return (
    <div className="view view-anim locked-room">
      <button className="btn btn-text back-btn" onClick={onBack}><Icon name="chevron-left" size={16} /> Back</button>
      <div className="card locked-card">
        <span className="locked-icon locked-icon--pulse"><Icon name="lock" size={26} /></span>
        <h2>{room.name}</h2>
        <p className="muted">This room is private — only its members can see inside.</p>
        {loading && <p className="muted">Checking…</p>}
        {!loading && pending && (
          <>
            <p className="knock-pending">
              <Icon name="knock" size={16} /> You knocked — waiting for the owner to let you in.
            </p>
            <button className="btn btn-text" disabled={busy} onClick={withdraw}>
              Cancel knock
            </button>
          </>
        )}
        {!loading && !pending && status?.canKnock && (
          <button className="btn btn-primary" disabled={busy} onClick={knock}>
            <Icon name="knock" size={16} /> {busy ? 'Knocking…' : 'Knock to join'}
          </button>
        )}
        {!loading && !pending && !status?.canKnock && (
          <p className="muted">{status?.reason || 'You cannot knock on this room.'}</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
