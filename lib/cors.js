// CORS allow-list (audit L1).
//
// The old default reflected ANY origin (`origin: true` with
// credentials) whenever CORS_ORIGIN was unset — the whole API's
// cross-origin safety then rested on the SameSite=Lax cookie alone.
// Now an unset CORS_ORIGIN falls back to the known origins only:
// the hosted app + local dev. An explicitly set CORS_ORIGIN still
// wins (comma-separated list).
//
// Pure: takes { env, log } so tests can pass a fake env/logger
// without touching process.env.
const RENDER_ORIGIN = 'https://orbit-3lzs.onrender.com';
const DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'];

const resolveCorsOrigins = ({ env = process.env, log = null } = {}) => {
  const configured = String(env.CORS_ORIGIN || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  if (env.NODE_ENV === 'production' && log) {
    log.warn(
      'CORS_ORIGIN is not set — defaulting to the hosted origin + ' +
      'localhost dev origins. Set CORS_ORIGIN in production if the ' +
      'app is served from anywhere else.'
    );
  }
  return [RENDER_ORIGIN, ...DEV_ORIGINS];
};

module.exports = { RENDER_ORIGIN, DEV_ORIGINS, resolveCorsOrigins };
