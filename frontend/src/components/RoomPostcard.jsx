// Room postcard: the recap card shown after leaving a room — room
// name, how long you were there, and who was there with you.
//
// In-memory only (App.jsx builds it from the voice session + the
// sightings RoomView hands over on leave); dismissing it forgets it.
// No entrance animation: the card just appears, so it stays still
// under prefers-reduced-motion like everything else.
import React, { useEffect, useState } from 'react';
import './RoomPostcard.css';
import Avatar from './Avatar';
import { Icon } from './icons';
import { canSavePostcardImage, drawPostcardImage } from '../postcard';

// Shown rows; the rest collapse to a "+N more" line.
const MAX_SHOWN = 8;

export default function RoomPostcard({ postcard, onDismiss }) {
  const [saveError, setSaveError] = useState('');
  const [saveStarted, setSaveStarted] = useState(false);

  // Esc dismisses, like the room view's chat / invite / popover.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  if (!postcard) return null;
  const people = postcard.participants || [];
  const shown = people.slice(0, MAX_SHOWN);
  const extra = people.length - shown.length;

  const saveAsImage = () => {
    setSaveError('');
    if (!drawPostcardImage(postcard)) {
      setSaveError('Could not save the image in this browser.');
      return;
    }
    setSaveStarted(true);
  };

  return (
    <section className="card postcard" role="dialog" aria-label={`Recap of ${postcard.roomName}`}>
      <div className="postcard-head">
        <span className="postcard-eyebrow"><Icon name="planet" size={13} /> Room postcard</span>
        <button className="btn btn-text btn-small" onClick={onDismiss} aria-label="Dismiss postcard">
          <Icon name="x" size={14} />
        </button>
      </div>
      <h2 className="postcard-room">{postcard.roomName}</h2>
      <p className="postcard-meta">{postcard.durationLabel} · {postcard.dateLabel}</p>
      {people.length === 0 ? (
        <p className="muted postcard-alone">Just you in here.</p>
      ) : (
        <>
          <p className="muted postcard-with">
            {people.length === 1 ? 'You were here with' : `You were here with ${people.length} friends`}
          </p>
          <ul className="postcard-people">
            {shown.map((person) => (
              <li key={person.id} className="postcard-person">
                <Avatar user={person} size="sm" className="person-orb" />
                <span>{person.name}</span>
              </li>
            ))}
          </ul>
          {extra > 0 && <p className="muted postcard-more">+{extra} more</p>}
        </>
      )}
      <div className="postcard-actions">
        {canSavePostcardImage() && (
          <button className="btn btn-text btn-small" onClick={saveAsImage}>
            <Icon name="download" size={13} /> Save as image
          </button>
        )}
        <button className="btn btn-primary btn-small" onClick={onDismiss}>Done</button>
      </div>
      {saveStarted && !saveError && <p className="muted postcard-saved">Saving your postcard…</p>}
      {saveError && <p className="error">{saveError}</p>}
    </section>
  );
}
