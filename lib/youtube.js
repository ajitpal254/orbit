// YouTube audio resolution (v0.10.0): turn a YouTube watch URL
// into a direct audio stream URL the DJ's browser can play.
//
// How it works: yt-dlp runs server-side (the `youtube-dl-exec`
// package downloads the standalone yt-dlp binary at install time —
// no Python at runtime; the binary is PyInstaller-packaged). One
// call, `-f bestaudio --dump-json --no-playlist`, yields the
// selected format's stream URL plus the title and duration.
//
// The returned URL is a signed googlevideo URL: it carries a
// signature and expires, so it is NEVER logged — success logs only
// the title, duration and host; failures log only a coarse reason.
// The client resolves through POST /api/music/youtube first and
// only the resolved googlevideo URL may be queued (see
// lib/musicQueue.js validateTrack) — a raw youtube.com URL never
// reaches the queue. Radio / direct-MP3 playback never touches
// this module.
//
// The executor is injectable so tests stub it and never call the
// real binary: `exec` receives the argv array and resolves to
// { stdout }. The default executor shells out to the yt-dlp binary
// with a ~15s timeout (execFile's timeout kills the child). Any
// failure — binary missing, non-zero exit, timeout, blocked, bad
// JSON, no URL — throws an error with .code 'YOUTUBE_UNAVAILABLE';
// the route turns that into a 502 and the server never crashes.
// The binary path resolves from YT_DLP_PATH first (documented
// override for installs where the postinstall download could not
// run), else the youtube-dl-exec bundled binary.

const { execFile } = require('child_process');

const YT_DLP_TIMEOUT_MS = 15_000;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be'
]);

// Only these YouTube hosts may be resolved — anything else (a
// googlevideo URL pasted directly, another video site, a bare
// domain) is not a YouTube link.
const isYouTubeUrl = (raw) => {
  if (typeof raw !== 'string') return false;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return YOUTUBE_HOSTS.has(url.hostname.toLowerCase());
};

class YouTubeUnavailableError extends Error {
  constructor(reason) {
    super(`YouTube audio unavailable: ${reason}`);
    this.name = 'YouTubeUnavailableError';
    this.code = 'YOUTUBE_UNAVAILABLE';
    this.reason = reason;
  }
}

// Where the yt-dlp binary lives: YT_DLP_PATH wins (manual installs,
// CI images where the postinstall download is skipped), else the
// binary youtube-dl-exec downloaded at install time.
const resolveYtDlpPath = (env = process.env) => {
  if (typeof env.YT_DLP_PATH === 'string' && env.YT_DLP_PATH.trim()) {
    return env.YT_DLP_PATH.trim();
  }
  try {
    return require.resolve('youtube-dl-exec/bin/yt-dlp');
  } catch {
    return null;
  }
};

// The real executor: run yt-dlp and return its stdout. Separated
// from resolveYouTubeAudio so tests can stub at the `exec` seam
// without touching child_process.
const runYtDlp = (binaryPath, args, { timeoutMs = YT_DLP_TIMEOUT_MS } = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      args,
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(err);
        resolve({ stdout: String(stdout || '') });
      }
    );
  });

// Resolve a YouTube URL to { audioUrl, title, duration }.
//   - url: a YouTube watch / shorts / music link (isYouTubeUrl).
//   - exec: injectable executor (args) => Promise<{ stdout }>;
//     defaults to the real yt-dlp binary.
//   - timeoutMs: kill the extraction after this long (~15s).
//   - log: optional logger (pino-style); only title/duration/host
//     are ever logged, never the audio URL.
// Throws YouTubeUnavailableError (.code 'YOUTUBE_UNAVAILABLE') on
// every failure mode — the caller answers 502.
const resolveYouTubeAudio = async (url, {
  exec = null,
  timeoutMs = YT_DLP_TIMEOUT_MS,
  log = null
} = {}) => {
  if (!isYouTubeUrl(url)) {
    throw new YouTubeUnavailableError('not-a-youtube-url');
  }
  const args = ['-f', 'bestaudio', '--dump-json', '--no-playlist', '--no-warnings', String(url)];
  let stdout;
  try {
    const run = exec || ((argv) => {
      const binary = resolveYtDlpPath();
      if (!binary) throw new YouTubeUnavailableError('yt-dlp-binary-missing');
      return runYtDlp(binary, argv, { timeoutMs });
    });
    ({ stdout } = await run(args));
  } catch (err) {
    if (err && err.code === 'YOUTUBE_UNAVAILABLE') throw err;
    const reason = err && err.killed ? 'timeout' : (err && err.code) || 'extraction-failed';
    log?.warn?.({ reason }, 'YouTube audio extraction failed');
    throw new YouTubeUnavailableError(reason);
  }
  let data;
  try {
    data = JSON.parse(String(stdout || '').trim());
  } catch {
    log?.warn?.({ reason: 'invalid-json' }, 'YouTube audio extraction failed');
    throw new YouTubeUnavailableError('invalid-json');
  }
  const audioUrl = data && typeof data.url === 'string' ? data.url : '';
  let host = null;
  try {
    host = new URL(audioUrl).hostname;
  } catch {
    host = null;
  }
  // The resolved URL must be a googlevideo stream — anything else
  // (a youtube.com page URL, a redirect, garbage) is not playable
  // audio and must never reach the queue.
  if (!audioUrl || !host || !host.endsWith('.googlevideo.com')) {
    log?.warn?.({ reason: 'no-stream-url' }, 'YouTube audio extraction failed');
    throw new YouTubeUnavailableError('no-stream-url');
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Unknown title';
  const duration = Number.isFinite(data.duration) && data.duration >= 0 ? data.duration : null;
  log?.info?.({ title, duration, host }, 'YouTube audio resolved');
  return { audioUrl, title, duration };
};

module.exports = {
  YT_DLP_TIMEOUT_MS,
  YOUTUBE_HOSTS,
  isYouTubeUrl,
  YouTubeUnavailableError,
  resolveYtDlpPath,
  runYtDlp,
  resolveYouTubeAudio
};
