/**
 * `@agentconnect.md/connection` — the shared connection layer.
 *
 * Wire-agnostic WebSocket primitives every network edge in the platform reuses,
 * so the daemon, relay, and control-plane don't each carry their own copy:
 *
 *  - {@link Clock} / {@link SystemClock} / {@link FakeClock} — the time seam
 *  - {@link Backoff} — exponential reconnect backoff with jitter
 *  - {@link ReqRep} — request/reply correlation + retransmit (generic per wire)
 *  - {@link ClientTransport} — dial-out socket + receive-idle watchdog (client side)
 *  - {@link WsServerTransport} + {@link attachKeepalive} — the accept side: a
 *    transport over an accepted socket + the half-open ping/pong sweep
 *
 * The wire CONTRACT (frame schemas, codecs) lives in `@agentconnect.md/protocol`;
 * this package is the transport MECHANISM that carries any of those wires.
 */
export { type Clock, type TimerHandle, SystemClock, systemClock, FakeClock } from './clock.js'
export { Backoff, type BackoffOpts, DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CAP_MS } from './backoff.js'
export { ReqRep, WireError, type WireFrameLike, type RequestOpts } from './correlator.js'
export {
  ClientTransport,
  armRxWatchdog,
  type Transport,
  type DialOpts,
  type WatchdogSocket,
  type WatchdogTimers
} from './ws-client-transport.js'
export { WsServerTransport, type ServerTransport } from './ws-server-transport.js'
export { attachKeepalive, type KeepaliveTimers } from './keepalive.js'
