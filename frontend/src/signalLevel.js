// Per-peer voice connection state -> the signal-bars shown on an orb.
// Pure helper (no React) so node --test can cover it.
//
//   connected            -> 4 bars, green
//   checking/connecting/new (or anything unknown / not yet reported)
//                        -> 2 bars, amber
//   disconnected/failed/closed -> 1 bar, red
export function signalLevel(state) {
  switch (state) {
    case 'connected':
      return { bars: 4, tone: 'connected' };
    case 'disconnected':
    case 'failed':
    case 'closed':
      return { bars: 1, tone: 'failed' };
    default:
      return { bars: 2, tone: 'connecting' };
  }
}
