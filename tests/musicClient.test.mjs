// Tests for the music bot's client-side helpers (frontend/src/
// music.js, v0.10.0) — URL source detection, radio title derivation,
// queue payloads, duration / idle-countdown formatting — plus the
// source-level wiring assertions for the RoomView listeners and the
// MusicPanel idle UI, in the density.test.mjs style (no React, no DOM).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  detectMusicSource,
  isYouTubeUrl,
  deriveRadioTitle,
  buildRadioTrack,
  buildYouTubeTrack,
  validateTrack,
  formatDuration,
  formatIdleCountdown,
  idleWarningText,
  playbackUrlFor,
  IDLE_DISCONNECT_MESSAGE
} from '../frontend/src/music.js';
import { readCssBundle } from './cssBundle.js';

test('detectMusicSource: YouTube hosts are youtube, everything else http(s) is radio', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ'
  ]) {
    assert.equal(detectMusicSource(url), 'youtube', url);
    assert.equal(isYouTubeUrl(url), true, url);
  }
  for (const url of [
    'https://example.com/lofi.mp3',
    'http://stream.example.com:8000/live',
    'https://cdn.example.com/audio/track.MP3?x=1'
  ]) {
    assert.equal(detectMusicSource(url), 'radio', url);
    assert.equal(isYouTubeUrl(url), false, url);
  }
  // A lookalike host is not YouTube; non-http(s) and garbage are not tracks.
  assert.equal(detectMusicSource('https://notyoutube.com/watch?v=x'), 'radio');
  assert.equal(detectMusicSource('https://youtube.com.evil.example/x'), 'radio');
  assert.equal(detectMusicSource('ftp://example.com/song.mp3'), null);
  assert.equal(detectMusicSource('not a url'), null);
  assert.equal(detectMusicSource(''), null);
  assert.equal(detectMusicSource(null), null);
});

test('deriveRadioTitle: typed title wins, then the URL filename, then the host', () => {
  assert.equal(deriveRadioTitle('https://x.com/lofi-beats.mp3', 'My Lofi'), 'My Lofi');
  assert.equal(deriveRadioTitle('https://x.com/lofi-beats.mp3', '  '), 'lofi beats');
  assert.equal(deriveRadioTitle('https://x.com/lofi_beats.MP3', ''), 'lofi beats');
  assert.equal(deriveRadioTitle('https://x.com/stream', ''), 'stream');
  assert.equal(deriveRadioTitle('garbage', ''), 'Radio stream');
});

test('buildRadioTrack / buildYouTubeTrack shape the queue-add payload', () => {
  assert.deepEqual(buildRadioTrack('https://x.com/lofi-beats.mp3', ''), {
    title: 'lofi beats',
    url: 'https://x.com/lofi-beats.mp3',
    source: 'radio',
    duration: null
  });
  assert.deepEqual(
    buildYouTubeTrack({ audioUrl: 'https://googlevideo.example/a', title: 'Song', duration: 204 }),
    { title: 'Song', url: 'https://googlevideo.example/a', source: 'youtube', duration: 204 }
  );
  // A resolved track with no duration stays null, never NaN.
  assert.equal(buildYouTubeTrack({ audioUrl: 'https://g.example/a', title: 'T' }).duration, null);
});

test('validateTrack accepts good payloads and rejects bad ones', () => {
  const good = { title: 'Lofi', url: 'https://x.com/a.mp3', source: 'radio', duration: null };
  assert.deepEqual(validateTrack(good), { ok: true });
  assert.equal(validateTrack({ ...good, title: '  ' }).ok, false);
  assert.equal(validateTrack({ ...good, url: 'notaurl' }).ok, false);
  assert.equal(validateTrack({ ...good, source: 'spotify' }).ok, false);
  assert.equal(validateTrack({ ...good, duration: -1 }).ok, false);
  assert.equal(validateTrack(null).ok, false);
});

test('formatDuration: m:ss, unknown stays an em dash', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65), '1:05');
  assert.equal(formatDuration(204), '3:24');
  assert.equal(formatDuration(3600), '60:00');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(undefined), '—');
  assert.equal(formatDuration(-5), '—');
});

test('formatIdleCountdown: 60 -> 1:00, 59 -> 0:59, clamped at 0:00', () => {
  assert.equal(formatIdleCountdown(60), '1:00');
  assert.equal(formatIdleCountdown(59), '0:59');
  assert.equal(formatIdleCountdown(5), '0:05');
  assert.equal(formatIdleCountdown(0), '0:00');
  assert.equal(formatIdleCountdown(-3), '0:00');
});

test('idleWarningText carries the live countdown; the disconnect message is the contract string', () => {
  assert.equal(idleWarningText(59), 'Music Bot leaves in 0:59 — room is idle');
  assert.equal(idleWarningText(60), 'Music Bot leaves in 1:00 — room is idle');
  assert.equal(IDLE_DISCONNECT_MESSAGE, 'Music Bot left — room was idle for 5 minutes');
});

// --- wiring: the listeners and the panel, asserted from source ---

const roomView = readFileSync(new URL('../frontend/src/components/RoomView.jsx', import.meta.url), 'utf8');
const musicPanel = readFileSync(new URL('../frontend/src/components/MusicPanel.jsx', import.meta.url), 'utf8');
const css = readCssBundle();

test('RoomView listens for music-state / music-error / idle events and cleans them up', () => {
  for (const event of ['music-state', 'music-error', 'music-idle-warning', 'music-idle-disconnect']) {
    assert.ok(roomView.includes(`socket.on('${event}'`), `RoomView must listen for ${event}`);
    assert.ok(roomView.includes(`socket.off('${event}'`), `RoomView must remove its ${event} listener on teardown`);
  }
});

test('playbackUrlFor: the DJ element loads the same-origin proxy, never the raw URL', () => {
  // captureStream() throws a SecurityError for cross-origin media,
  // and radio / YouTube stream URLs are always cross-origin — the
  // proxy is what makes captureStream work at all.
  assert.equal(
    playbackUrlFor('https://rr2---sn-p5qlsnd6.googlevideo.com/videoplayback?expire=1&sig=abc'),
    '/api/music/stream?u=https%3A%2F%2Frr2---sn-p5qlsnd6.googlevideo.com%2Fvideoplayback%3Fexpire%3D1%26sig%3Dabc'
  );
  assert.equal(playbackUrlFor({ url: 'https://example.com/stream.mp3' }), '/api/music/stream?u=https%3A%2F%2Fexample.com%2Fstream.mp3');
  assert.equal(playbackUrlFor(''), '');
  assert.equal(playbackUrlFor(null), '');
});

test('RoomView drives DJ playback from music-state via captureStream, never createMediaElementSource', () => {
  assert.ok(roomView.includes('captureStream'), 'DJ playback must use captureStream()');
  assert.ok(!roomView.includes('createMediaElementSource'), 'Web Audio createMediaElementSource would silence cross-origin streams');
  assert.ok(roomView.includes('playbackUrlFor'), 'the DJ element must load the same-origin proxy, never the raw track URL');
  assert.ok(roomView.includes('el.src = playbackUrl'), 'the playback effect must set the proxy URL on the element');
  assert.ok(roomView.includes('Couldn’t share this track’s audio'), 'a captureStream throw must degrade to a panel error, not an unhandled rejection');
  assert.ok(roomView.includes('getAudioTracks().length > 0'), 'the DJ must wait until captureStream() yields a live audio track — capturing right after play() can return a trackless stream');
  assert.ok(roomView.includes('!started.ok'), 'a refused startMusic must surface its error instead of caching a dead stream');
  assert.ok(roomView.includes("emit('music-skip'"), "the DJ element's ended event must advance the queue");
  assert.ok(roomView.includes('djAudioRef'), 'the DJ <audio> element must live in RoomView (stays mounted on minimize)');
});

test('RoomView renders the Music Bot member row and the Music dock button', () => {
  assert.ok(roomView.includes('Music Bot'), 'the members list must show a Music Bot row while music is active');
  assert.ok(roomView.includes('member-row--music-bot'), 'the Music Bot row must carry its own class');
  assert.ok(roomView.includes('<MusicPanel'), 'RoomView must render the Music panel');
  assert.ok(roomView.includes('aria-label="Music"'), 'the voice dock must have a Music button');
});

test('MusicPanel renders the idle countdown and the disconnect notice with a dismiss', () => {
  assert.ok(musicPanel.includes('idleWarningText(idleWarning.secondsRemaining)'), 'the panel must show the idle countdown');
  assert.ok(musicPanel.includes('music-idle-warning'), 'the countdown must carry its class for the smoke test');
  assert.ok(musicPanel.includes('music-idle-notice'), 'the disconnect notice must carry its class');
  assert.ok(musicPanel.includes('onDismissIdleNotice'), 'the disconnect notice must be dismissible');
  assert.ok(musicPanel.includes("YouTube couldn't fetch this track right now"), 'a 502 must explain itself inline and leave radio working');
  assert.ok(musicPanel.includes('data-music-live'), 'the panel must expose whether a music track is live, for the smoke test');
});

test('music.css is in the bundle and carries the sheet + bot-row + dock styles', () => {
  const main = readFileSync(new URL('../frontend/src/main.jsx', import.meta.url), 'utf8');
  assert.ok(main.includes("import './css/music.css';"), 'main.jsx must import music.css');
  for (const cls of ['.music-sheet', '.music-queue', '.music-idle-warning', '.music-idle-notice', '.music-bot-avatar', '.music-dot', '.dj-audio']) {
    assert.ok(css.includes(cls), `the CSS bundle must define ${cls}`);
  }
});
