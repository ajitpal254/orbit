// Client-side music helpers (v0.10.0): pure functions, no React, no
// DOM, so node --test can import them directly.
//
// The DJ model: the DJ's browser owns playback (RoomView renders a
// hidden <audio> element, captures it with captureStream, and hands
// the stream to the voice engine); the server is the source of truth
// for the queue + now-playing via `music-state`. These helpers only
// decide what a pasted URL is and how the panel talks about it —
// they never fetch anything.

export const MUSIC_SOURCES = ['youtube', 'radio'];

// Idle auto-disconnect (v0.10.0 scope addition): the server warns
// the room 60s before it stops the music for idleness (DJ alone for
// 4 minutes) and announces the stop itself. The client's copy of the
// stop message lives here so the panel and the tests agree on it.
export const IDLE_DISCONNECT_MESSAGE = 'Music Bot left — room was idle for 5 minutes';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'www.music.youtube.com',
  'youtu.be',
  'www.youtu.be'
]);

// youtube.com / youtu.be (incl. music.youtube.com) -> 'youtube';
// any other http(s) URL -> 'radio' (a direct audio URL / stream);
// anything unparseable or non-http(s) -> null (not a track URL).
export function detectMusicSource(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const url = rawUrl.trim();
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) return 'youtube';
  return 'radio';
}

export function isYouTubeUrl(rawUrl) {
  return detectMusicSource(rawUrl) === 'youtube';
}

// A radio track's title: the DJ's typed title wins; otherwise derive
// one from the URL's last path segment ("lofi-beats.mp3" -> "lofi
// beats"), falling back to the host, then a plain "Radio stream".
export function deriveRadioTitle(rawUrl, typedTitle) {
  if (typeof typedTitle === 'string' && typedTitle.trim()) return typedTitle.trim();
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch {
    return 'Radio stream';
  }
  const last = (parsed.pathname || '').split('/').filter(Boolean).pop() || '';
  const base = decodeURIComponent(last).replace(/\.[a-z0-9]+$/i, '').replace(/[-_+]+/g, ' ').trim();
  if (base) return base;
  return parsed.hostname || 'Radio stream';
}

// The queue-add payload for a direct audio URL (radio/MP3/stream).
// Duration is unknown for a live stream, so it stays null.
export function buildRadioTrack(rawUrl, typedTitle) {
  const url = String(rawUrl || '').trim();
  return {
    title: deriveRadioTitle(url, typedTitle),
    url,
    source: 'radio',
    duration: null
  };
}

// The queue-add payload for a resolved YouTube track: the server's
// POST /api/music/youtube already answered with the playable
// audioUrl, title and duration — the client only reshapes it.
export function buildYouTubeTrack(resolved) {
  return {
    title: resolved?.title || 'YouTube track',
    url: resolved?.audioUrl || '',
    source: 'youtube',
    duration: typeof resolved?.duration === 'number' ? resolved.duration : null
  };
}

// Validate a queue-add payload before it is emitted. The server
// re-validates (never trust the client), but a bad payload here is a
// UI bug — catch it where the form lives, not on the socket.
export function validateTrack(track) {
  if (!track || typeof track !== 'object') return { ok: false, error: 'That track is missing.' };
  if (typeof track.title !== 'string' || !track.title.trim()) {
    return { ok: false, error: 'Give the track a title.' };
  }
  if (typeof track.url !== 'string' || !/^https?:\/\//i.test(track.url.trim())) {
    return { ok: false, error: 'That track URL is not a valid http(s) link.' };
  }
  if (!MUSIC_SOURCES.includes(track.source)) {
    return { ok: false, error: 'That track has an unknown source.' };
  }
  if (track.duration !== null && track.duration !== undefined &&
      (!Number.isFinite(track.duration) || track.duration < 0)) {
    return { ok: false, error: 'That track has an invalid duration.' };
  }
  return { ok: true };
}

// The DJ element's src for a track: the SAME-ORIGIN audio proxy
// (/api/music/stream), never the raw track URL. captureStream()
// throws a SecurityError for cross-origin media, and radio /
// YouTube stream URLs are always cross-origin — the proxy is what
// makes captureStream work at all. The queue still stores the raw
// URL; only playback goes through the proxy.
export function playbackUrlFor(track) {
  const url = typeof track === 'string' ? track : track?.url;
  if (typeof url !== 'string' || !url) return '';
  return `/api/music/stream?u=${encodeURIComponent(url)}`;
}

// "3:24" for a 204s track; "—" when the duration is unknown (a live
// radio stream has none).
export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// Idle countdown: 60 -> "1:00", 59 -> "0:59", 5 -> "0:05". Clamped
// at zero — a stale warning never counts below it.
export function formatIdleCountdown(secondsRemaining) {
  const total = Math.max(0, Math.floor(Number(secondsRemaining) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// The idle-warning line, with the live countdown baked in.
export function idleWarningText(secondsRemaining) {
  return `Music Bot leaves in ${formatIdleCountdown(secondsRemaining)} — room is idle`;
}
