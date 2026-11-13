// ICE recovery state machine for one peer connection (pure — no DOM,
// no RTCPeerConnection — so it is unit-testable with injected time).
//
// A brief network blip (Wi-Fi → cell handoff) puts ICE in
// 'disconnected', not 'failed'. That is transient: wait out a short
// grace, then restart ICE; only a 'failed' state — or a restart that
// never recovers — earns a full peer reconnect (fresh pc + fresh
// offer). Only when THAT also fails is the peer given up on.
//
// Phases: 'stable' → 'waiting' (grace) → 'restarting' → 'stable'
// (recovered) | 'recreate-peer' (fresh pc, machine back to 'stable'
// with recreated: true, so the next failure gives up) → 'done'.
//
// The engine drives it: on every ice state change it steps the
// machine with the live state, performs the returned action, and
// re-steps when a grace/restart timer fires (re-reading the live
// state — the machine never runs on its own clock).

export const ICE_DISCONNECTED_GRACE_MS = 2000;
export const ICE_RESTART_TIMEOUT_MS = 10000;

export function createIceRecovery() {
  return { phase: 'stable', since: null, recreated: false };
}

// Step the machine with the peer's current ICE state.
//   machine: { phase, since, recreated } (see createIceRecovery)
//   iceState: pc.iceConnectionState
//   now: ms epoch (Date.now() in the engine; injected in tests)
//   durations: { graceMs, restartTimeoutMs } — the engine passes its
//     configured values (constructor options, so tests can use short
//     ones); defaults are the production 2s / 10s.
// Returns { machine, action } — action is 'none' | 'restart-ice' |
// 'recreate-peer' | 'give-up'. The engine performs the action; the
// machine only decides.
export function iceRecoveryStep(machine, iceState, now = Date.now(), durations = {}) {
  const graceMs = durations.graceMs ?? ICE_DISCONNECTED_GRACE_MS;
  const restartTimeoutMs = durations.restartTimeoutMs ?? ICE_RESTART_TIMEOUT_MS;
  const m = { ...machine };

  // Recovery: back to connected/completed from any phase resets the
  // budget — a fresh connection gets a fresh grace + restart.
  if (iceState === 'connected' || iceState === 'completed') {
    return { machine: { phase: 'stable', since: null, recreated: false }, action: 'none' };
  }
  // The pc is gone — nothing left to recover.
  if (iceState === 'closed') {
    return { machine: { phase: 'done', since: m.since, recreated: m.recreated }, action: 'none' };
  }
  // Terminal: already gave up on this peer.
  if (m.phase === 'done') return { machine: m, action: 'none' };

  // 'failed' skips the grace: the transport already told us it is
  // dead. One full reconnect (fresh pc + fresh offer); a second
  // failure after that gives up on this peer.
  if (iceState === 'failed') {
    if (m.recreated) return { machine: { ...m, phase: 'done' }, action: 'give-up' };
    return { machine: { phase: 'stable', since: null, recreated: true }, action: 'recreate-peer' };
  }

  if (iceState === 'disconnected') {
    if (m.phase === 'stable') {
      return { machine: { phase: 'waiting', since: now, recreated: m.recreated }, action: 'none' };
    }
    if (m.phase === 'waiting') {
      if (now - (m.since ?? now) >= graceMs) {
        return { machine: { phase: 'restarting', since: now, recreated: m.recreated }, action: 'restart-ice' };
      }
      return { machine: m, action: 'none' };
    }
    if (m.phase === 'restarting') {
      if (now - (m.since ?? now) >= restartTimeoutMs) {
        if (m.recreated) return { machine: { ...m, phase: 'done' }, action: 'give-up' };
        return { machine: { phase: 'stable', since: null, recreated: true }, action: 'recreate-peer' };
      }
      return { machine: m, action: 'none' };
    }
    return { machine: m, action: 'none' };
  }

  // 'checking' / 'new' / anything else: no transition. A 'checking'
  // during 'restarting' is progress — keep waiting for the timeout.
  return { machine: m, action: 'none' };
}
