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
const { attachSocket } = require('./lib/socket');
const logger = require('./lib/logger');
const { requestId, requestLog } = require('./middleware/requestLog');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(compression());
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
      httpServer.listen(PORT, () => logger.info(`Orbit running on port ${PORT}`));
    })
    .catch((err) => {
      logger.fatal({ err }, 'MongoDB connection failed — exiting');
      process.exit(1);
    });
}

module.exports = { app, httpServer, io };
