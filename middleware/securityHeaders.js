// Security headers (audit M6) — explicit, no helmet dependency.
// Applied to every response in server.js, before the API router and
// the static serving, so API, static, SPA, and error responses all
// carry them.
//
// What the frontend actually loads (checked 2026-11-11, so the policy
// does not break the app):
//   - JS/CSS/fonts/icons/manifest/service worker: all same-origin.
//     Fonts are self-hosted via @fontsource (woff2, bundled); no
//     Google Fonts CDN anywhere.
//   - Google Identity Services: one external script,
//     https://accounts.google.com/gsi/client, injected by
//     frontend/src/googleSignIn.js; it renders the button in an
//     iframe from accounts.google.com (hence frame-src).
//   - socket.io: ws:/wss: to self (same origin).
//   - Avatar images: data: URLs (client-downscaled uploads).
//   - Inline styles: unavoidable — index.html has an inline <style>
//     splash block, and React sets inline style attributes everywhere
//     (orb positions, gradients, animation delays). style-src therefore
//     needs 'unsafe-inline'; there is no inline <script> anywhere, so
//     script-src stays tight without it.
//   - No other external hosts: no analytics, no CDNs, no embeds.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://accounts.google.com/gsi/client",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss: https://accounts.google.com",
  "frame-src https://accounts.google.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "worker-src 'self'",
  "manifest-src 'self'"
].join('; ');

const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': CONTENT_SECURITY_POLICY
};

const securityHeaders = (req, res, next) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
  next();
};

module.exports = { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, securityHeaders };
