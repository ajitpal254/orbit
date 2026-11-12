// Structured JSON logging (pino). Secrets are redacted so they never hit logs.
const pino = require('pino');

const loggerOptions = () => ({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    // Token-shaped fields are redacted as a backstop (audit I4/M2):
    // no log line should carry a credential, even if one is ever
    // attached to a logged object by mistake.
    paths: [
      'password', '*.password',
      'req.headers.cookie', 'req.headers.authorization',
      'token', '*.token',
      'credential', '*.credential',
      'sessionToken', '*.sessionToken',
      'csrfToken', '*.csrfToken'
    ],
    censor: '[REDACTED]'
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

const createLogger = (stream) => pino(loggerOptions(), stream);
const logger = createLogger();

module.exports = logger;
module.exports.createLogger = createLogger;
module.exports.loggerOptions = loggerOptions;
