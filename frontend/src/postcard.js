// Room postcards (v0.7.0): the small recap shown when a permanent
// room ends — room name, how long you were there, and who was there
// with you. Permanent rooms only: campfires ("fading rooms") keep
// their hard-delete promise and never produce a postcard, so there is
// no tombstone or archive model anywhere here — a campfire simply
// ends, and the faded notice is the whole goodbye.
//
// Client-side, in-memory only: nothing is persisted to MongoDB and no
// server endpoint logs history, by design — fading chat and fading
// rooms mean Orbit keeps no logs, and a postcard is a souvenir of a
// session you were in, not a record anyone else can look up. The
// duration comes from the voice session's joinedAt (App.jsx /
// voiceSession.js); the participant list is accumulated in RoomView
// from the occupants the client actually saw during the stay.
//
// Pure logic only: no React, no DOM, no voice engine — except
// drawPostcardImage, which needs a canvas and is guarded so importing
// this module in node (tests) is safe. Unit-tested in
// tests/postcard.test.mjs.

import { initials } from './orbLayout.js';

// Human-friendly stay length: seconds stay seconds, minutes stay
// minutes, hours show hours + minutes — "42s", "12m", "1h 12m".
export function formatPostcardDuration(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor((elapsedMs || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// Short date for the card, playbook style: "Nov 11".
export function formatPostcardDate(epochMs) {
  if (epochMs == null) return '';
  const d = new Date(epochMs);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Who was there with you, from everyone the client saw during the
// stay (first-seen order). `seen` is an array of { id, name,
// avatarPreset?, avatarImage? } — one entry per sighting, so the same
// person rejoining on a new socket appears more than once. Rules:
// dedupe by user id (first sighting wins, so a rename mid-stay keeps
// the name you first saw), drop entries with no id, drop yourself —
// you know you were there — and fall back to "Unnamed" for a missing
// name. The result carries the avatar fields through so the card can
// render the shared Avatar component.
export function buildPostcardParticipants(seen, selfId) {
  const byId = new Map();
  for (const person of seen || []) {
    if (!person || person.id == null || String(person.id) === '') continue;
    const id = String(person.id);
    if (id === String(selfId)) continue;
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      name: person.name || 'Unnamed',
      avatarPreset: person.avatarPreset || '',
      avatarImage: person.avatarImage || ''
    });
  }
  return [...byId.values()];
}

// The whole card, or null when there is nothing to recap (no room
// name, or no session start — e.g. a leave that was never a join).
// `seen` is the raw sightings list; `selfId` is the current user.
// `ephemeral` is the room's effective campfire state at leave time
// (RoomView folds its local "kept" flag in, so a kept campfire —
// permanent now — still gets a card): a campfire never gets one.
export function buildPostcard({ roomName, joinedAt, leftAt, seen, selfId, ephemeral }) {
  if (!roomName || !joinedAt) return null;
  if (ephemeral) return null;
  const end = leftAt || Date.now();
  const durationMs = Math.max(0, end - joinedAt);
  const participants = buildPostcardParticipants(seen, selfId);
  return {
    roomName,
    joinedAt,
    endedAt: end,
    durationMs,
    durationLabel: formatPostcardDuration(durationMs),
    dateLabel: formatPostcardDate(end),
    participants,
    alone: participants.length === 0
  };
}

// --- Save as image (optional, canvas only) ---------------------------------
//
// Renders the card to a 640px PNG and triggers a download. Text and
// initial-circles only — no photos, so there is no cross-origin taint
// to worry about. Returns false when there is no DOM/canvas to draw
// with (server-side render, old browser); the caller hides or explains
// the button then. The download itself is async (toBlob), so a true
// return means "started", not "saved".
export function canSavePostcardImage() {
  try {
    if (typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    return !!(canvas && canvas.getContext && canvas.getContext('2d'));
  } catch {
    return false;
  }
}

const POSTCARD_WIDTH = 640;
const POSTCARD_HEIGHT = 420;
const POSTCARD_MAX_PEOPLE = 6;

export function drawPostcardImage(postcard) {
  try {
    if (!postcard || typeof document === 'undefined') return false;
    const canvas = document.createElement('canvas');
    canvas.width = POSTCARD_WIDTH;
    canvas.height = POSTCARD_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    // Deep-space card, same palette as the room view.
    const bg = ctx.createLinearGradient(0, 0, POSTCARD_WIDTH, POSTCARD_HEIGHT);
    bg.addColorStop(0, '#17122e');
    bg.addColorStop(1, '#0b0b18');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, POSTCARD_WIDTH, POSTCARD_HEIGHT);
    // Soft glow, top-left.
    const glow = ctx.createRadialGradient(120, 70, 10, 120, 70, 260);
    glow.addColorStop(0, 'rgba(139, 92, 246, 0.45)');
    glow.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, POSTCARD_WIDTH, POSTCARD_HEIGHT);

    ctx.fillStyle = '#a78bfa';
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.fillText('ORBIT · ROOM POSTCARD', 40, 52);

    ctx.fillStyle = '#f4f4f8';
    ctx.font = '700 38px system-ui, sans-serif';
    ctx.fillText((postcard.roomName || 'A room').slice(0, 28), 40, 104);

    ctx.fillStyle = '#b8b8cc';
    ctx.font = '400 21px system-ui, sans-serif';
    ctx.fillText(`${postcard.durationLabel || ''} · ${postcard.dateLabel || ''}`, 40, 142);

    const people = postcard.participants || [];
    ctx.fillStyle = '#8b8ba3';
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.fillText(people.length === 0 ? 'JUST YOU IN HERE' : `WITH ${people.length} ${people.length === 1 ? 'FRIEND' : 'FRIENDS'}`, 40, 190);

    const shown = people.slice(0, POSTCARD_MAX_PEOPLE);
    const hues = [262, 318, 16, 160, 190, 45];
    shown.forEach((person, i) => {
      const y = 224 + i * 34;
      ctx.beginPath();
      ctx.arc(56, y - 6, 13, 0, Math.PI * 2);
      ctx.fillStyle = `hsl(${hues[i % hues.length]} 70% 55%)`;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(initials(person.name || ''), 56, y - 1);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#e8e8f2';
      ctx.font = '400 18px system-ui, sans-serif';
      ctx.fillText((person.name || 'Unnamed').slice(0, 30), 80, y);
    });
    if (people.length > POSTCARD_MAX_PEOPLE) {
      ctx.fillStyle = '#8b8ba3';
      ctx.font = '400 16px system-ui, sans-serif';
      ctx.fillText(`+${people.length - POSTCARD_MAX_PEOPLE} more`, 80, 224 + shown.length * 34);
    }
    if (people.length === 0) {
      ctx.fillStyle = '#b8b8cc';
      ctx.font = '400 18px system-ui, sans-serif';
      ctx.fillText('Just you — the room was all yours.', 40, 224);
    }

    const slug = String(postcard.roomName || 'room').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'room';
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `orbit-postcard-${slug}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
    return true;
  } catch {
    return false;
  }
}
