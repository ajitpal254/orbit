# Orbit on Render — Docker build.
#
# Why Docker: Render's native Node environment has no Python 3.11+,
# so `npm install` fails in youtube-dl-exec's preinstall check
# ("needs Python 3.11 or newer as python3") and blocks deploys
# (v0.10.0). This image installs Python 3.11 from Debian bookworm,
# so the check passes. The yt-dlp binary itself is standalone — the
# youtube-dl-exec postinstall downloads it with pure Node fetch —
# and needs no Python at runtime.
#
# Dashboard switch (no render.yaml — the service was created
# manually): Render → Orbit service → Settings → Environment →
# switch Native (Node) to Docker, Dockerfile path ./Dockerfile,
# save → redeploy. Env vars carry over unchanged.

# Node 24 to match the engines field in package.json; slim keeps the
# image lean. node:24-slim is Debian 12 (bookworm), whose python3
# package is 3.11.2 — above the preinstall check's 3.11 minimum.
FROM node:24-slim

# Python 3.11 for the youtube-dl-exec preinstall check, plus CA
# certificates so the postinstall binary download (Node fetch to
# GitHub) can verify TLS. --no-install-recommends keeps the image
# lean; the apt lists are removed in the same layer.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

WORKDIR /app

# Install production deps first (layer cache): the youtube-dl-exec
# postinstall downloads the standalone yt-dlp binary into
# node_modules during this step. Dev deps (playwright,
# mongodb-memory-server) are omitted — tests never run in the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime code + the committed built frontend (Render never builds
# the frontend; public/ is committed). scripts/ is included so the
# resend-verification runbook still works from Render Shell.
COPY server.js ./
COPY lib ./lib
COPY routes ./routes
COPY models ./models
COPY middleware ./middleware
COPY scripts ./scripts
COPY public ./public

# Run as the unprivileged node user. Render routes traffic to $PORT
# (the app reads process.env.PORT, default 3000); EXPOSE only
# documents the default.
USER node
EXPOSE 3000
CMD ["node", "server.js"]
