// Per-request ID + access logging middleware.
const { randomUUID } = require('crypto');
const logger = require('../lib/logger');

const requestId = (req, res, next) => {
  req.id = req.headers['x-request-id'] || randomUUID();
  res.setHeader('x-request-id', req.id);
  req.log = logger.child({ reqId: req.id });
  next();
};

const requestLog = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    req.log.info(
      { method: req.method, url: req.originalUrl, status: res.statusCode, durationMs: Date.now() - start },
      'request'
    );
  });
  next();
};

module.exports = { requestId, requestLog };
