/**
 * `attachKeepalive` — a WS-level ping/pong liveness sweep for a `noServer`
 * WebSocketServer.
 *
 * The daemon↔CP and relay↔CP heartbeats are application-level and
 * one-directional, so a half-open TCP connection — peer gone without a FIN/RST
 * (a node crash, an edge/middlebox dropping the flow) — leaves the CP holding a
 * socket it believes is live. A daemon read may then fan out to that zombie and
 * consume an RPC timeout, while a stale registry entry remains occupied.
 *
 * This sweeps every `intervalMs`: a socket with no inbound activity since the
 * last sweep is `terminate()`d (→ its `close` fires → the connection FSM drops
 * it from the registry); the rest are pinged. The peer's ws layer answers pings
 * automatically, so no peer-side code is required. A socket is thus torn down
 * after at most ~2 intervals of silence.
 *
 * Because these gateways run in `noServer` mode they never emit `'connection'`,
 * so the caller must `track()` each socket it accepts (inside its
 * `handleUpgrade` callback). Returns that `track` fn; the sweep timer is
 * `unref`'d and auto-cleared when the server closes.
 */
import type { WebSocket, WebSocketServer } from 'ws'

/** Injectable timer seams so the sweep is unit-testable with a manual driver. */
export interface KeepaliveTimers {
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void }
  clearInterval?: (handle: unknown) => void
}

export function attachKeepalive(
  wss: WebSocketServer,
  intervalMs: number,
  timers: KeepaliveTimers = {}
): (ws: WebSocket) => void {
  const setIv = timers.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms))
  const clearIv =
    timers.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof globalThis.setInterval>))

  // Sockets seen alive since the last sweep. WeakSet ⇒ no leak when a socket is GC'd.
  const alive = new WeakSet<WebSocket>()

  const timer = setIv(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue // CONNECTING/CLOSING/CLOSED — leave it to its own close
      if (!alive.has(ws)) {
        ws.terminate() // silent for a full interval → assume half-open
        continue
      }
      alive.delete(ws) // must prove itself alive again before the next sweep
      ws.ping()
    }
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  wss.on('close', () => clearIv(timer))

  return function track(ws: WebSocket): void {
    alive.add(ws)
    // Any inbound frame — a pong, an app message, or a peer ping — proves liveness.
    const mark = (): void => {
      alive.add(ws)
    }
    ws.on('pong', mark)
    ws.on('message', mark)
    ws.on('ping', mark)
  }
}
