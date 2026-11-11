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
7. Direct messages: 1:1 chat with accepted friends only, with a conversation list, unread badges, and live delivery. See "Direct messages" below.
8. Animated splash screen: branded loading screen (floating orbs) that shows before JS loads and while the app boots; the status text explains a Render free-tier cold start ("Waking up the server…") and a Retry button appears if the server still hasn't answered — the boot check times out after 20s and retries up to 3 times instead of spinning forever.

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

## Direct messages

1:1 chat with accepted friends — strangers and pending requests can't message you:

- **Messages tab** — one entry per accepted friend, sorted by last-message recency (friends with no messages go last, by name). Each row shows an avatar, a last-message preview ("You: …" for your own), a time, and an unread badge. A total-unread badge sits on the tab itself.
- **Thread view** — tap a conversation (or "Message" on a friend's row) to open the thread: bubbles, mine right in the accent gradient, theirs left on card background, auto-scroll to the newest message.
- **Live delivery** — sending broadcasts a `dm-message` push to the recipient's connected socket(s) (same join chime as a room invite); their list and badge update without a refresh. Opening a thread marks their messages to you as read.
- **Friends-only, enforced server-side** — `GET /api/dms/:userId` and `POST /api/dms/:userId` both 403 unless an accepted friendship exists; the client is never trusted. Text is validated with the same `validateMessageInput` as room chat (max 1000 chars) and stored **AES-256-GCM encrypted** exactly like room messages (`models/DirectMessage.js`, `read` flag for unread counts).
- **Rules, in one place** — the DM predicates live in `lib/dms.js` (`canDm`, `unreadFor`, `lastMessageFor`, `buildSummaries`, reusing `lib/friends.js` — no duplicated friendship logic) and are unit-tested in `tests/dms.test.js` without MongoDB. Route integration tests need MongoDB and were **not** run in the sandbox.

## Splash screen & cold starts

Render's free tier sleeps after ~1h idle, so the first request after a while takes 30–60s while the server wakes. The app used to show a bare "Loading…" with no timeout through that — it looked stuck, but wasn't. Now:

- `frontend/index.html` carries an inline `#splash` (self-contained `<style>`, no external assets): 🪐 Orbit wordmark, three animated orbs, "Connecting…". It paints before any JS loads, and the PWA serves it from cache too.
- `main.jsx` fades it out and removes it once React has painted its first frame (idempotent, StrictMode-safe).
- While the app boots, the React `components/Splash.jsx` takes over with staged status text — 0–8s "Connecting…", 8–25s "Waking up the server — free servers take a moment…", 25s+ "Still waking up…" plus a Retry button that re-runs the boot check.
- The `/api/auth/me` boot check has a 20s timeout (AbortController) with up to 3 attempts and short backoff. If all fail, the app stops loading and shows the login screen with the error and a Retry button — it never spins forever. Orb animation is disabled under `prefers-reduced-motion`.

## Roles & moderation (private rooms only)

Private rooms have three roles, stored on the member list as subdocuments `{ user, role }` (`models/Room.js`). Rooms created before roles existed store plain ObjectIds — `lib/roles.js` normalizes both shapes (`normalizeMembers`, `getRole`), treats a plain id as `member` except the creator (`createdBy` is always `owner`), and every read — routes, socket, serialization — goes through it. Writes rebuild the list from the normalized array, which migrates legacy entries to subdocuments as a side effect. All Room reads use `.lean()`: Mongoose 9 hydrating a legacy room mangles plain-ObjectId members into `{ role: 'member', i0, i1, … }` with no `user` field — the id is lost — so hydrated docs are never trusted for membership.

- **Owner 👑** — the room creator. Only the owner can promote a member to moderator, demote a moderator, transfer ownership, or delete the room. An owner cannot leave a non-empty private room until ownership is transferred (400 "transfer ownership first"); the last member out deletes the room as before. Transferring makes the old owner a moderator and updates `createdBy`, so delete permission follows ownership.
- **Moderator 🛡️** — can kick members (not the owner, not other moderators) and server-mute members. Kicking removes the member, deletes their pending invites for the room, and forces their sockets out with a `room-kicked` event.
- **Member** — no admin actions.
- **Moderator mute is cooperative, not enforced.** Voice is P2P — the server cannot force a client to stop sending audio. The server records the mute per room (in-memory `roomId → Set(userId)` in `lib/socket.js`), tells the target's sockets via `moderator-muted` / `moderator-unmuted` (`POST /api/rooms/:id/members/:userId/mute` toggles), and the target's client honors it by muting itself (`RoomView.jsx` — which also broadcasts `mic-state`, so everyone else sees the 🔇 badge). A rejoining muted user is muted again on join (`room-state` carries `mutedByModerator: true`). **A modified client could ignore it** — the UI labels it "Muted by moderator" and never presents it as enforced. A restart clears the in-memory mute map; a moderator can re-mute.
- Public rooms have no members list and no roles — the creator keeps delete-only as before.

Routes (all `authMiddleware`, mutating ones rate-limited, `{error: string}` contract): `POST /api/rooms/:id/members/:userId/promote`, `.../demote`, `.../kick`, `POST /api/rooms/:id/transfer { userId }`, `POST /api/rooms/:id/members/:userId/mute` (answers `{ muted, userId, roomId }`). Each answers with the fresh room JSON, whose private-room `members` are now `{ id, name, role }`. Permission logic lives in `lib/roles.js` (`canPromote`, `canDemote`, `canKick`, `canMute`, `canTransfer`, `canLeave`) and is unit-tested in `tests/roles.test.js`.

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
| Chat messages, room topics, DMs | AES-256-GCM at rest (MongoDB) |
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
- **No screen share yet** — rooms + voice + chat + friends + DMs + roles only.
- **Presence is in-memory.** A server restart clears "who's in a room" (correct behavior — presence is ephemeral), but chat history and rooms persist in Mongo.
- Tests cover pure logic (room validation, presence, orb layout, password helpers). Route/socket integration tests need MongoDB and were **not** run in the sandbox — smoke-tested via module loads + live `/api/health` instead.

## CSRF lesson (from Calorie-Tracker)

First signup used to 403 because the double-submit CSRF check required a `csrfToken` cookie that only existed after login. Orbit includes the public `GET /api/auth/csrf-token` bootstrap endpoint, and `App.jsx` fetches it on load before any auth attempt.
