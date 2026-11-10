// Structured JSON logging (pino). Secrets are redacted so they never hit logs.
const pino = require('pino');

const loggerOptions = () => ({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: ['password', 'req.headers.cookie', 'req.headers.authorization', '*.password'],
    censor: '[REDACTED]'
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

const createLogger = (stream) => pino(loggerOptions(), stream);
const logger = createLogger();

module.exports = logger;
module.exports.createLogger = createLogger;
module.exports.loggerOptions = loggerOptions;
