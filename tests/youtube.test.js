// Tests for the YouTube resolver (v0.10.0): lib/youtube.js.
// isYouTubeUrl is pure; resolveYouTubeAudio runs against a stubbed
// executor, so no test ever calls the real yt-dlp binary or the
// network. One test proves the real binary resolves from this
// sandbox (see the report) — that is a manual check, not a unit
// test, because CI must not depend on YouTube being reachable.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isYouTubeUrl,
  YouTubeUnavailableError,
  resolveYouTubeAudio
} = require('../lib/youtube');

const GOOD_URL = 'https://rr2---sn-p5qlsnd6.googlevideo.com/videoplayback?expire=1&sig=abc';
const YT_WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// A capturing logger: every call is recorded so the "never log the
// audio URL" assertion can inspect exactly what was logged.
const captureLog = () => {
  const calls = [];
  return {
    calls,
    log: {
      info: (fields, msg) => calls.push({ level: 'info', fields, msg }),
      warn: (fields, msg) => calls.push({ level: 'warn', fields, msg })
    }
  };
};

// --- isYouTubeUrl ---------------------------------------------------------------

test('isYouTubeUrl accepts the YouTube hosts', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtu.be/dQw4w9WgXcQ',
    'http://youtu.be/dQw4w9WgXcQ'
  ]) {
    assert.equal(isYouTubeUrl(url), true, url);
  }
});

test('isYouTubeUrl rejects everything else', () => {
  for (const url of [
    'https://example.com/watch?v=x',
    'https://www.googlevideo.com/videoplayback?x=1',
    'https://rr1---sn-abc.googlevideo.com/videoplayback',
    'https://www.youtube.com.evil.com/watch?v=x',
    'https://notyoutube.com/watch?v=x',
    'ftp://www.youtube.com/watch?v=x',
    'not a url',
    '',
    null,
    undefined,
    42
  ]) {
    assert.equal(isYouTubeUrl(url), false, String(url));
  }
});

// --- resolveYouTubeAudio with a stubbed executor ---------------------------------

const stubExecSuccess = (over = {}) => async (args) => {
  assert.ok(Array.isArray(args), 'executor receives argv');
  assert.ok(args.includes('--dump-json'), 'uses --dump-json for metadata + URL in one call');
  assert.ok(args.includes('bestaudio'), 'selects the best audio format');
  assert.ok(args.includes('--no-playlist'), 'never resolves a whole playlist');
  return {
    stdout: JSON.stringify({
      title: 'Rick Astley - Never Gonna Give You Up',
      duration: 213,
      url: GOOD_URL,
      ...over
    })
  };
};

test('resolve returns audioUrl + title + duration from one dump-json call', async () => {
  const { log, calls } = captureLog();
  const res = await resolveYouTubeAudio(YT_WATCH, { exec: stubExecSuccess(), log });
  assert.deepEqual(res, { audioUrl: GOOD_URL, title: 'Rick Astley - Never Gonna Give You Up', duration: 213 });
  // Success logs title/duration/host — never the signed audio URL.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, 'info');
  assert.equal(calls[0].fields.title, 'Rick Astley - Never Gonna Give You Up');
  assert.equal(calls[0].fields.duration, 213);
  assert.match(calls[0].fields.host, /\.googlevideo\.com$/);
  assert.ok(!JSON.stringify(calls).includes(GOOD_URL), 'the audio URL must never appear in logs');
  assert.ok(!JSON.stringify(calls).includes('sig=abc'), 'the signature must never appear in logs');
});

test('resolve tolerates a missing duration (null) and a missing title', async () => {
  const res = await resolveYouTubeAudio(YT_WATCH, {
    exec: stubExecSuccess({ duration: undefined, title: undefined })
  });
  assert.equal(res.duration, null);
  assert.equal(res.title, 'Unknown title');
  assert.equal(res.audioUrl, GOOD_URL);
});

test('resolve rejects a non-YouTube URL before running anything', async () => {
  let ran = false;
  const exec = async () => { ran = true; return { stdout: '{}' }; };
  await assert.rejects(
    resolveYouTubeAudio('https://example.com/video.mp4', { exec }),
    (err) => err.code === 'YOUTUBE_UNAVAILABLE'
  );
  assert.equal(ran, false, 'the executor must not run for a non-YouTube URL');
});

test('executor failure (non-zero exit) becomes YOUTUBE_UNAVAILABLE', async () => {
  const err = new Error('Command failed');
  err.code = 1;
  const exec = async () => { throw err; };
  await assert.rejects(
    resolveYouTubeAudio(YT_WATCH, { exec }),
    (e) => e instanceof YouTubeUnavailableError && e.code === 'YOUTUBE_UNAVAILABLE'
  );
});

test('executor timeout becomes YOUTUBE_UNAVAILABLE', async () => {
  const err = new Error('Command timed out');
  err.killed = true;
  err.code = 'ETIMEDOUT';
  const exec = async () => { throw err; };
  await assert.rejects(
    resolveYouTubeAudio(YT_WATCH, { exec }),
    (e) => e.code === 'YOUTUBE_UNAVAILABLE' && /timeout/.test(e.message)
  );
});

test('binary missing (ENOENT) becomes YOUTUBE_UNAVAILABLE', async () => {
  const err = new Error('spawn ENOENT');
  err.code = 'ENOENT';
  const exec = async () => { throw err; };
  await assert.rejects(
    resolveYouTubeAudio(YT_WATCH, { exec }),
    (e) => e.code === 'YOUTUBE_UNAVAILABLE'
  );
});

test('invalid JSON stdout becomes YOUTUBE_UNAVAILABLE', async () => {
  const exec = async () => ({ stdout: 'WARNING: [youtube] something\nnot json' });
  await assert.rejects(
    resolveYouTubeAudio(YT_WATCH, { exec }),
    (e) => e.code === 'YOUTUBE_UNAVAILABLE'
  );
});

test('JSON without a stream URL becomes YOUTUBE_UNAVAILABLE', async () => {
  const exec = async () => ({ stdout: JSON.stringify({ title: 'x', duration: 5 }) });
  await assert.rejects(
    resolveYouTubeAudio(YT_WATCH, { exec }),
    (e) => e.code === 'YOUTUBE_UNAVAILABLE'
  );
});

test('a non-googlevideo URL in the JSON is rejected (never queued)', async () => {
  const exec = async () => ({
    stdout: JSON.stringify({ title: 'x', duration: 5, url: 'https://www.youtube.com/watch?v=x' })
  });
  await assert.rejects(
    resolveYouTubeAudio(YT_WATCH, { exec }),
    (e) => e.code === 'YOUTUBE_UNAVAILABLE'
  );
});

test('failure logs only a coarse reason, never the URL', async () => {
  const { log, calls } = captureLog();
  const exec = async () => { throw Object.assign(new Error('boom'), { code: 1 }); };
  await assert.rejects(resolveYouTubeAudio(YT_WATCH, { exec, log }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].level, 'warn');
  assert.ok(!JSON.stringify(calls).includes(YT_WATCH), 'the input URL must not be logged either');
  assert.ok(!JSON.stringify(calls).includes(GOOD_URL));
});
