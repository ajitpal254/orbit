// Per-request ID + access logging middleware.
const { randomUUID } = require('crypto');
const logger = require('../lib/logger');

const requestId = (req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.id);
  req.log = logger.child({ reqId: req.id });
  next();
};

// Invite tokens are 32 base64url chars (lib/inviteLinks.js). Any path
// segment shaped like one is treated as a credential and never logged.
const TOKEN_LIKE = /^[A-Za-z0-9_-]{32}$/;

// Scrub a raw path: drop the query string and replace token-shaped
// segments with :token. Used when no route matched (404s, unknown
// paths) so a credential in the URL can never reach the logs.
const scrubPath = (rawPath) => {
  const path = String(rawPath || '').split('?')[0];
  return path
    .split('/')
    .map((seg) => (TOKEN_LIKE.test(seg) ? ':token' : seg))
    .join('/');
};

// The path to log for a request (audit M2): the matched route pattern
// when the router has matched one (e.g. /api/invite-links/join — a
// pattern never contains a token), otherwise the scrubbed raw path.
// Never the raw originalUrl: full request URLs used to carry redeemed
// invite tokens straight into the server logs.
const requestPath = (req) => {
  if (req.route && typeof req.route.path === 'string') {
    return `${req.baseUrl || ''}${req.route.path}`;
  }
  return scrubPath(req.originalUrl || req.url || '');
};

const requestLog = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    // 'finish' fires after routing, so req.route is set for matched
    // routes and requestPath returns the pattern, not the raw URL.
    req.log.info(
      { method: req.method, url: requestPath(req), status: res.statusCode, durationMs: Date.now() - start },
      'request'
    );
  });
  next();
};

module.exports = { requestId, requestLog, requestPath, scrubPath };
