// Live hero card for the desktop Home: the busiest room right now,
// rendered with the REAL orb system (orbPositions + the same .orb
// classes RoomView uses — no second orb implementation), a pulsing
// LIVE tag, occupant count, and a one-click Drop in. When nobody is
// live it shows a calm empty state — a gently pulsing orb, one line of
// copy, and the two primary actions. Never fake activity: no live
// room, no hero room. Hidden below 900px (see index.css); Home only
// passes it data it already loads for the room list.
import React, { useEffect, useRef, useState } from 'react';
import { orbPositions, initials, orbHue } from '../orbLayout';
import { heroOccupants } from '../desktop';
import { Icon } from './icons';

export default function HeroCard({ room, onJoin, onStartRoom, onGoFriends }) {
  const stageRef = useRef(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) {
        setStageSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [room]);

  if (!room) {
    return (
      <section className="hero-card hero-empty" aria-label="No one is live right now">
        <div className="hero-empty-orb">
          <div className="orb" style={{ background: 'linear-gradient(135deg, #8b5cf6, #d946ef)' }}>
            <span className="orb-initials"><Icon name="planet" size={30} /></span>
          </div>
        </div>
        <strong>It's quiet in orbit</strong>
        <p className="muted">No one is talking right now — start a room and your friends will find you here.</p>
        <div className="hero-actions">
          <button className="btn btn-primary" onClick={onStartRoom}>Start a room</button>
          <button className="btn btn-text" onClick={onGoFriends}>Invite a friend</button>
        </div>
      </section>
    );
  }

  const accent = room.accent || { from: '#8b5cf6', to: '#d946ef' };
  const people = heroOccupants(room);
  const positions = stageSize.width > 0 ? orbPositions(people, stageSize) : [];
  const posById = Object.fromEntries(positions.map((p) => [p.id, p]));

  return (
    <section className="hero-card hero-live" aria-label={`Live now: ${room.name}`}>
      <div className="hero-stage" ref={stageRef}>
        <div className="starfield" />
        <div className="nebula nebula-a" />
        <div className="nebula nebula-b" />
        {people.map((person) => {
          const pos = posById[person.socketId];
          if (!pos) return null;
          const px = (pos.x / 100) * stageSize.width;
          const py = (pos.y / 100) * stageSize.height;
          return (
            <div
              key={person.socketId}
              className="orb-wrap"
              style={{ '--tx': `${px}px`, '--ty': `${py}px`, width: pos.size, height: pos.size }}
              title={person.name}
            >
              <div
                className="orb-bob"
                style={{ animationDelay: `${pos.delay}s`, animationDuration: `${pos.duration}s` }}
              >
                <div
                  className={`orb ${person.speaking ? 'speaking' : ''}`}
                  style={{
                    background: `linear-gradient(135deg, ${accent.from}, ${accent.to})`,
                    filter: `hue-rotate(${orbHue(person.userId)}deg)`
                  }}
                >
                  <span className="orb-initials">{initials(person.name)}</span>
                  <span className="orb-name">{person.name.split(' ')[0]}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="hero-info">
        <span className="hero-live-tag"><span className="live-dot" /> LIVE</span>
        <strong className="hero-room-name">
          {room.isPrivate && <span className="lock-badge" title="Private room"><Icon name="lock" size={12} /> </span>}
          {room.name}
        </strong>
        {room.topic && <span className="muted hero-topic">{room.topic}</span>}
        <span className="muted hero-count">
          {room.occupantCount} in room
          {room.occupants?.some((o) => o.speaking) ? ' · someone is talking' : ''}
        </span>
        <button className="btn btn-primary" onClick={() => onJoin(room)}>Drop in</button>
      </div>
    </section>
  );
}
