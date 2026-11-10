# 🪐 Orbit

**Spatial voice chat for friends — rooms, not servers.**

Orbit is a Discord-like voice app with its own design: no server sidebar, no channel tree. You open the app, see **live rooms as cards** showing who's talking right now, and tap one to drop in. Inside a room, friends appear as **floating orbs** on a dark cosmic background — the orb of whoever is speaking glows and pulses. A floating voice bar (Spotify-player style) holds mute / deafen / chat / leave, and text chat lives inside the room as a slide-over panel.

## Stack

Same family as Budget-Manager and Calorie-Tracker:

- **Backend:** Express 5 + Mongoose (MongoDB Atlas), cookie sessions (SHA-256 hashed tokens), double-submit CSRF, PBKDF2-SHA512 passwords, per-IP rate limit, pino structured logging, `GET /api/health` (pre-rate-limit), gzip compression before static files.
- **Frontend:** React 19 + Vite + PWA, build emits to repo-root `public/` (committed — Render serves it directly).
- **Voice:** mesh WebRTC + socket.io signaling. Audio only, Google STUN (`stun:stun.l.google.com:19302`) only — **no third-party voice infra, no TURN, no paid service**. Speaking detection via `AnalyserNode` per stream. The voice engine lives in its own module (`frontend/src/voice.js`) so it can be swapped for an SFU later.

## Features (v1)

1. Auth: register / login / logout, persistent sessions — plus Google one-tap sign-in when `GOOGLE_CLIENT_ID` is set (see Security).
2. Rooms: create (name, topic, accent color), list with live occupancy + who's inside + who's speaking, join / leave.
3. Voice room: floating orbs, speaking glow, mute / deafen / leave, participant names, listen-only fallback if the mic is denied.
4. Text chat per room: persisted in Mongo **AES-256-GCM encrypted at rest**, live via socket.io, bottom-sheet panel with unread badge.
5. PWA: installable, mobile-responsive, offline shell.

## Project layout

```
server.js            Express + http server + socket.io attach
routes/api.js        Auth, rooms, room chat (REST)
lib/socket.js        socket.io signaling + presence events
lib/presence.js      In-memory live occupancy registry
lib/rooms.js         Pure room validation / accents / initials
lib/passwords.js     PBKDF2 + token helpers
lib/logger.js        pino
middleware/          auth (sessions/CSRF/rate limit), requestLog
models/              User, Session, Room, Message
frontend/src/
  voice.js           Mesh WebRTC engine (the only WebRTC module)
  orbLayout.js       Deterministic spatial orb positions
  socket.js          socket.io client singleton
  api.js             fetch helper (cookie session + CSRF)
  components/        Auth, Home (room cards), RoomView (orbs + voice bar + chat)
tests/               node:test — pure-logic tests (no Mongo needed)
```

## Local dev

```bash
npm install
cd frontend && npm install --legacy-peer-deps && cd ..
# set MONGODB_URI in .env (Atlas cluster, db name `orbit`)
node server.js            # backend on :3000
cd frontend && npm run dev   # frontend dev server (proxies /api + /socket.io)
```

## Deploy (Render)

Ajit creates the service himself — **Web Service** (not Static Site):

| Setting | Value |
|---|---|
| Build command | `npm install` |
| Start command | `node server.js` |
| Env vars | `MONGODB_URI` (Atlas, db `orbit`), `DATA_ENCRYPTION_KEY` (see Security — required in production), `GOOGLE_CLIENT_ID` (optional — enables the Google button) |

Render sets `PORT` and `NODE_ENV` itself. **Important:** the frontend is served from the committed `public/` folder — Render never rebuilds it, so any UI change needs `npm run build` in `frontend/` + committing `public/` first.

## Security

**Login — password or Google one-tap.** Password login is unchanged. If `GOOGLE_CLIENT_ID` is set, the login screen also shows a "Continue with Google" button (Google Identity Services). The browser sends Google's signed ID token to `POST /api/auth/google`, the server verifies it with `google-auth-library`, then finds the user by Google id, links it to an existing account with the same email, or creates a new Google-only account (random unusable password hash). The same session cookie is issued either way. If no client ID is configured, no Google button renders at all. **Google only ever sees the login event** — no chat, room, or voice data goes to Google.

**Setting up Google sign-in (Ajit does this in Google Cloud Console):**
1. Create a project at [console.cloud.google.com](https://console.cloud.google.com) (or reuse an existing one).
2. APIs & Services → OAuth consent screen → create it (External, app name "Orbit", your email).
3. APIs & Services → Credentials → Create Credentials → OAuth client ID → **Web application**.
4. Under **Authorized JavaScript origins**, add your Render URL, e.g. `https://orbit-xxxx.onrender.com` (no path, no trailing slash).
5. Copy the **Client ID** (the `...apps.googleusercontent.com` string) into Render as `GOOGLE_CLIENT_ID`. No client secret is needed — this is the ID-token flow.

**Stored data is encrypted.** Chat messages and room topics are encrypted at rest with **AES-256-GCM** (`lib/crypto.js`, wire format base64 `iv:authTag:ciphertext`, fresh random IV per message). The 32-byte key comes from `DATA_ENCRYPTION_KEY` (base64). Generate it with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

⚠️ **Losing the encryption key makes old messages permanently unreadable — there is no recovery.** Keep it in Render env vars; never commit it. If the var is missing, the server generates an ephemeral key at boot and logs a loud warning — fine for local dev, never for production.

**What is encrypted and what is not (deliberate):**

| Data | Protection |
|---|---|
| Chat messages, room topics | AES-256-GCM at rest (MongoDB) |
| Voice | DTLS-SRTP peer-to-peer; the server never receives media |
| Passwords | PBKDF2-SHA512, 310k iterations (hashed, never encrypted) |
| Session tokens | SHA-256 hashed in DB, httpOnly cookies |
| User emails / names | Plaintext — needed for login lookup and Google matching |
| Transport | TLS via Render (HTTPS/WSS) |
| Database disk | MongoDB Atlas encryption at rest |

**No migration needed:** encryption landed before the first deploy, so there is no existing message data to migrate.

## Known v1 limits

- **Mesh voice scales to ~2–6 people.** Every peer connects to every other peer; beyond that, CPU/bandwidth grows fast. The upgrade path is a LiveKit SFU — `voice.js` is isolated so the swap touches one module.
- **No TURN server.** Google STUN only. Most home/mobile networks work; some strict corporate/symmetric NATs may fail to connect.
- **PWA only on mobile** — no native app yet. Install from the browser; mic access works in the PWA.
- **No DMs, roles, or screen share yet** — rooms + voice + chat only.
- **Presence is in-memory.** A server restart clears "who's in a room" (correct behavior — presence is ephemeral), but chat history and rooms persist in Mongo.
- Tests cover pure logic (room validation, presence, orb layout, password helpers). Route/socket integration tests need MongoDB and were **not** run in the sandbox — smoke-tested via module loads + live `/api/health` instead.

## CSRF lesson (from Calorie-Tracker)

First signup used to 403 because the double-submit CSRF check required a `csrfToken` cookie that only existed after login. Orbit includes the public `GET /api/auth/csrf-token` bootstrap endpoint, and `App.jsx` fetches it on load before any auth attempt.
