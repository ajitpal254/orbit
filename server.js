require('dotenv').config();
const http = require('http');
const express = require('express');
const compression = require('compression');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const { Server } = require('socket.io');
const apiRoutes = require('./routes/api');
const { rateLimitMiddleware, csrfMiddleware } = require('./middleware/auth');
const { attachSocket, emitRoomsChanged, clearMutedForRoom } = require('./lib/socket');
const { startCleanupWorker } = require('./lib/fadingRooms');
const Room = require('./models/Room');
const Message = require('./models/Message');
const RoomInvite = require('./models/RoomInvite');
const logger = require('./lib/logger');
const { requestId, requestLog } = require('./middleware/requestLog');
const { securityHeaders } = require('./middleware/securityHeaders');
// Resolve the message-encryption key at boot so a missing
// DATA_ENCRYPTION_KEY logs its loud ephemeral-key warning in the startup
// logs (not silently on the first encrypted message).
require('./lib/crypto').getKey();
// Loud warning when the account TURN relay is not configured
// (TURN_SECRET unset) — voice still works via STUN + fallbacks.
require('./lib/turnCredentials').warnIfTurnSecretMissing(logger);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(compression());
app.use(securityHeaders);
app.use(requestId);
app.use(requestLog);

const corsOptions = {
  origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true,
  credentials: true,
  exposedHeaders: ['x-request-id']
};
app.use(cors(corsOptions));

app.use(express.json({ limit: '1mb' }));

// Liveness probe (before the rate limiter so monitoring never gets throttled).
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    version: process.version
  });
});

app.use('/api', rateLimitMiddleware());
app.use('/api', csrfMiddleware);
app.use('/api', apiRoutes);

// Unknown /api path: JSON 404 — not the SPA page, and not Express's
// bare finalhandler response (which would overwrite the CSP with its
// own "default-src 'none'" and drop the security headers).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Serve the built frontend.
app.use(express.static(path.join(__dirname, 'public')));

// SPA catch-all (Express 5 named wildcard).
app.get('/*splat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Central error handler: logs fully, responds with a safe { error } shape.
app.use((err, req, res, _next) => {
  (req.log || logger).error({ err, url: req.originalUrl }, 'Unhandled error');
  const status = err.status || 500;
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
});

process.on('unhandledRejection', (err) => logger.fatal({ err }, 'Unhandled rejection'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — exiting');
  process.exit(1);
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/orbit';

const httpServer = http.createServer(app);
const io = new Server(httpServer, { cors: corsOptions });
app.set('io', io);
attachSocket(io);

if (require.main === module) {
  mongoose.connect(MONGODB_URI)
    .then(() => {
      logger.info('MongoDB connected');
      // Campfire cleanup worker: sweeps due campfires every 15s and
      // deletes them (persisted expiresAt + atomic claim — restart-safe,
      // safe with two workers). Runs once immediately so rooms whose
      // deadline passed while the server was down fade on boot.
      startCleanupWorker({
        Room,
        Message,
        RoomInvite,
        clearMutedForRoom,
        log: (fields, msg) => (fields && fields.err ? logger.error(fields, msg) : logger.info(fields, msg)),
        onClosed: async (room) => {
          const id = String(room._id);
          io.to(id).emit('room-closed', { roomId: id });
          emitRoomsChanged(id);
        }
      });
      httpServer.listen(PORT, () => logger.info(`Orbit running on port ${PORT}`));
    })
    .catch((err) => {
      logger.fatal({ err }, 'MongoDB connection failed — exiting');
      process.exit(1);
    });
}

module.exports = { app, httpServer, io };
