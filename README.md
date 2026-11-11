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
6. Friends & private rooms: add friends by name/email, send/accept/decline requests, and create private rooms that only members can see or join — invite friends from inside the room. See "Friends & private rooms" below.

## Project layout

```
server.js            Express + http server + socket.io attach
routes/api.js        Auth, rooms, room chat (REST)
lib/socket.js        socket.io signaling + presence events
lib/presence.js      In-memory live occupancy registry
lib/rooms.js         Pure room validation / accents / initials
lib/friends.js       Pure friendship / private-room predicates
lib/passwords.js     PBKDF2 + token helpers
lib/logger.js        pino
middleware/          auth (sessions/CSRF/rate limit), requestLog
models/              User, Session, Room, Message, Friendship, RoomInvite
frontend/src/
  voice.js           Mesh WebRTC engine (the only WebRTC module)
  orbLayout.js       Deterministic spatial orb positions
  socket.js          socket.io client singleton
  api.js             fetch helper (cookie session + CSRF)
  components/        Auth, Home (room cards), RoomView (orbs + voice bar + chat), Friends
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
| Env vars | `MONGODB_URI` (Atlas, db `orbit`), `DATA_ENCRYPTION_KEY` (see Security — required in production), `GOOGLE_CLIENT_ID` (optional — enables the Google button), `TURN_USERNAME` + `TURN_CREDENTIAL` (optional — see Voice connectivity below) |

Render sets `PORT` and `NODE_ENV` itself. **Important:** the frontend is served from the committed `public/` folder — Render never rebuilds it, so any UI change needs `npm run build` in `frontend/` + committing `public/` first.

## Voice connectivity (TURN)

STUN alone only lets two peers connect directly. On networks where a direct path fails (same-WiFi AP isolation, symmetric NAT, some mobile carriers), ICE can only complete through a TURN relay — without one the connection sits at "connecting / checking" and then fails, and the status line shows `(host+srflx)` with no `relay` candidate. The app therefore uses two TURN sources, in order:

1. **Built-in, no setup** — Metered's Open Relay static-auth endpoint (`staticauth.openrelay.metered.ca`). The client computes a 24h time-limited credential (HMAC-SHA1, see `frontend/src/turnAuth.js`). Best-effort: a free shared relay with no SLA.
2. **Your own Metered account (recommended, reliable)** — sign up free at https://dashboard.metered.ca/signup (20 GB/month free), create TURN credentials, then set these Render env vars (use the exact `urls` from the dashboard's "Show ICE Server Array" if they differ):
   - `TURN_USERNAME` and `TURN_CREDENTIAL` — required to enable it
   - `TURN_URLS` — optional, comma-separated; defaults to `turn:standard.relay.metered.ca:80,turn:standard.relay.metered.ca:443,turn:standard.relay.metered.ca:443?transport=tcp`

   The server exposes them via `GET /api/config`; the voice engine fetches them on join. Changing the env vars restarts the Render service automatically — no rebuild needed. TURN credentials are client-visible by nature (any WebRTC client must hold them to allocate); they are quota-limited, not secret.

Diagnosing: the per-peer status line under the room shows the gathered candidate types — `relay` appearing means TURN is producing candidates; a `failed / disconnected` line with only `host+srflx` means no relay was available and direct paths failed.

## Friends & private rooms

Public rooms work exactly as before — anyone can see and join them. Friends unlock private rooms:

- **Friends tab** — search people by name or email (min 2 characters), send a request, accept/decline incoming requests, see requests you sent, and remove friends. A friend request is one row (`models/Friendship.js`, `pending` → `accepted`); both directions are checked, so there is never a duplicate.
- **Private rooms** — the create form has a Public/Private toggle. A private room starts with its creator as the only member, shows a 🔒 badge and member count on its card, and is invisible to everyone else: the room list, room detail, messages, and the socket `join-room` all refuse non-members (403 / `error` event).
- **Invites** — inside a private room, any member can invite one of their accepted friends (never strangers, never existing members; a pending invite is returned instead of duplicated). The invitee gets a live `room-invite` push over their socket (same chime as someone joining) plus an ✉️ Room invites section on the home screen — Join drops them straight into the room, Decline dismisses it. Accepting adds them to `room.members`.
- **Leaving** — a member can leave a private room from the members panel; if the last member leaves, the room (and its chat + invites) is deleted. Public rooms have nothing to leave. Deleting a room stays creator-only.
- **Live notifications** — `friend-request`, `room-invite`, and `friend-accepted` are pushed to the recipient's connected socket(s) via a small in-memory userId → socket map in `lib/socket.js`; the app plays the join chime and refreshes the Friends tab / invites list. Offline users see everything on their next load.
- **Rules, in one place** — the visibility/invite predicates live in `lib/friends.js` (`areFriends`, `friendshipStatus`, `canSeeRoom`, `canInvite`, `findPendingInvite`) and are unit-tested in `tests/friends.test.js` without MongoDB. Route/socket integration tests need MongoDB and were **not** run in the sandbox — smoke-tested via module loads + live `/api/health` instead.

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
- **TURN is best-effort by default.** The built-in static-auth Open Relay TURN works with no setup, but it is a free shared relay with no SLA. For reliable calls, add your own free Metered TURN credentials (`TURN_USERNAME` / `TURN_CREDENTIAL` on Render) — see "Voice connectivity (TURN)".
- **PWA only on mobile** — no native app yet. Install from the browser; mic access works in the PWA.
- **No DMs, roles, or screen share yet** — rooms + voice + chat + friends only. Friends and private rooms are in (see "Friends & private rooms").
- **Presence is in-memory.** A server restart clears "who's in a room" (correct behavior — presence is ephemeral), but chat history and rooms persist in Mongo.
- Tests cover pure logic (room validation, presence, orb layout, password helpers). Route/socket integration tests need MongoDB and were **not** run in the sandbox — smoke-tested via module loads + live `/api/health` instead.

## CSRF lesson (from Calorie-Tracker)

First signup used to 403 because the double-submit CSRF check required a `csrfToken` cookie that only existed after login. Orbit includes the public `GET /api/auth/csrf-token` bootstrap endpoint, and `App.jsx` fetches it on load before any auth attempt.
