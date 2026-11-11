// Auth middleware: cookie sessions, double-submit CSRF, in-memory rate limit.
const crypto = require('crypto');
const Session = require('../models/Session');
const User = require('../models/User');
const { hashToken } = require('../lib/passwords');

const parseCookies = (header = '') =>
  Object.fromEntries(
    header.split(';').map((c) => {
      const i = c.indexOf('=');
      return i < 0 ? [] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }).filter((p) => p.length === 2)
  );

const authMiddleware = async (req, res, next) => {
  try {
    const token = parseCookies(req.headers.cookie).sessionToken;
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const session = await Session.findOne({ tokenHash: hashToken(token) });
    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }
    const user = await User.findById(session.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

// Double-submit CSRF: state-changing requests must carry the csrfToken
// cookie value in the x-csrf-token header.
const csrfMiddleware = (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookie = parseCookies(req.headers.cookie).csrfToken;
  const header = req.headers['x-csrf-token'];
  // Compare lengths first: timingSafeEqual throws on unequal lengths,
  // which would 500 instead of cleanly rejecting a stale/truncated token.
  if (!cookie || !header || cookie.length !== header.length ||
      !crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header))) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
};

// Sliding-window in-memory rate limiter (per IP).
const rateLimitMiddleware = (max = 120, windowMs = 60 * 1000) => {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (arr.length > max) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
};

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { parseCookies, authMiddleware, csrfMiddleware, rateLimitMiddleware, asyncHandler };
