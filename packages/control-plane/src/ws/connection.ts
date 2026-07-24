/**
 * `DaemonConnection` — the per-socket lifecycle actor + FSM (design §4.4,
 * protocol §2.1).
 *
 * Owns the `LifecycleState`, gates which frames are legal in each state (before
 * READY only `auth`/`register`; anything else → `error PROTOCOL_STATE`), routes
 * correlated REPs to the `ReqRep`, and dispatches legal inbound frames to the
 * `FrameRouter`. Every byte crosses the {@link Transport} seam, so the
 * `InMemoryDaemonStub` drives it with no real socket.
 *
 * It also IS the `DaemonChannel` the orchestrator holds (issue fenced C→D
 * control via `request`/`send`) — but in Phase 2 only the inbound `auth`/
 * `register` path and the legal-frame gate are exercised.
 */
import { AnyFrame, type ControlExt, type ErrorCode, isFrame } from '@agentconnect.md/protocol'
import { decodeEnvelope, buildEnvelope, encode, type InboundControlExt } from './codec.js'
import { ReqRep, type RequestOpts } from './correlator.js'
import type { Transport } from './transport.js'
import { ConnectionClosed, type ConnChannel, type LifecycleState } from './registry.js'
import type { DaemonWsDeps } from './deps.js'
import type { FrameRouter } from './handlers/index.js'
import { FencingState, checkFencing } from '../orchestrator/fencing.js'
import { ProtocolError } from '../domain/errors.js'

export class DaemonConnection implements ConnChannel {
  state: LifecycleState = 'CONNECTING'
  daemonId = '' // set on auth/ok; "" until then (ConnChannel requires a string)
  /** Current fencing epoch for this daemon (set on auth/ok). */
  sessionEpoch = 0
  /** Per-agent fencing baseline (current launch + next-expected inbound seq). */
  readonly fencing = new FencingState()
  readonly correlator: ReqRep

  constructor(
    readonly transport: Transport,
    private readonly deps: DaemonWsDeps,
    private readonly router: FrameRouter
  ) {
    this.correlator = new ReqRep(deps.clock, deps.config.ACK_TIMEOUT_MS)
  }

  get remoteAddr(): string {
    return this.transport.remoteAddr
  }

  /** Begin: open the gate at AUTHENTICATING and wire transport callbacks. */
  start(): void {
    this.state = 'AUTHENTICATING'
    this.transport.onMessage((t) => {
      void this.onText(t)
    })
    this.transport.onClose((c, r) => this.onClose(c, r))
  }

  private async onText(text: string): Promise<void> {
    const decoded = decodeEnvelope(text)
    if (!decoded.ok) {
      // FRAME_TOO_LARGE / UNKNOWN_FRAME / invalid json / payload error → typed REP.
      const code = this.decodeErrorCode(decoded.msg)
      this.sendError(decoded.id, code, decoded.msg, false)
      if (decoded.corr) {
        this.correlator.reject(
          decoded.corr,
          new ProtocolError(code, `invalid correlated reply: ${decoded.msg}`, { retryable: false })
        )
      }
      return
    }
    const frame = decoded.frame

    // A correlated REP/error settles a CP-issued REQ — never re-dispatched.
    if (frame.corr && this.correlator.settle(frame)) return

    // §2.1 legal-frame gate.
    if (!this.isLegalInState(frame.type)) {
      this.sendError(frame.id, 'PROTOCOL_STATE', `${frame.type} illegal in ${this.state}`, false)
      return
    }

    // Fencing gate (protocol §4.2): any inbound control frame that carries a
    // ControlExt (epoch present) is validated epoch → launchId BEFORE dispatch.
    // A `agent/launched` first refreshes the launch fence so its own (new)
    // launchId is never rejected as stale.
    if (isFrame('agent/launched')(frame)) {
      this.fencing.setLaunch(frame.payload.agentId, frame.payload.launchId)
    }
    if (decoded.ext?.epoch !== undefined) {
      if (!this.gateFencing(frame, decoded.ext)) return
    }

    // Defense in depth: a handler that rejects (e.g. an unexpected persistence
    // error) must close the socket cleanly, never bubble to an unhandled
    // rejection that takes down the CP process.
    try {
      await this.router.dispatch(frame, this, this.deps)
    } catch {
      if (this.state !== 'CLOSED') this.close(1011, 'SERVER_INTERNAL')
    }
  }

  /**
   * Run the fencing gate for a frame carrying a `ControlExt`. On the first
   * failure, send the typed `error` REP (`corr` = frame id) and return false.
   */
  private gateFencing(frame: AnyFrame, ext: InboundControlExt): boolean {
    const agentId = ext.agentId
    const baseline = {
      sessionEpoch: this.sessionEpoch,
      currentLaunch: agentId ? this.fencing.currentLaunch(agentId) : undefined
    }
    const verdict = checkFencing(baseline, {
      epoch: ext.epoch!,
      ...(agentId ? { agentId } : {}),
      ...(ext.launchId ? { launchId: ext.launchId } : {})
    })
    if (!verdict.ok) {
      this.sendError(frame.id, verdict.code, verdict.code, false, verdict.details)
      return false
    }
    return true
  }

  /** Frames legal in the current state (protocol §2.1). */
  private isLegalInState(type: string): boolean {
    switch (this.state) {
      case 'AUTHENTICATING':
        return type === 'auth'
      case 'REGISTERING':
        return type === 'register'
      case 'READY':
      case 'DRAINING':
        return true
      default:
        return false
    }
  }

  private decodeErrorCode(msg: string): ErrorCode {
    if (msg === 'FRAME_TOO_LARGE') return 'FRAME_TOO_LARGE'
    if (msg === 'UNKNOWN_FRAME') return 'UNKNOWN_FRAME'
    return 'BAD_PAYLOAD'
  }

  // ── DaemonChannel surface (C→D) ───────────────────────────────────────────

  /**
   * Issue a fenced REQ and await its correlated REP (Phase 3 hot path). Resolves
   * with the reply's typed `payload` (an `error` REP rejects with a
   * `ProtocolError`, via the correlator).
   */
  async request<TReply = unknown>(
    type: string,
    payload: unknown,
    ext?: ControlExt,
    opts?: RequestOpts
  ): Promise<TReply> {
    const frame = buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload, ext ? { ext } : {})
    const rep = await this.correlator.request(frame, (e) => this.transport.send(e), opts)
    return rep.payload as TReply
  }

  /** Fire-and-forget EVT (C→D). */
  send(type: string, payload: unknown, ext?: ControlExt): void {
    const frame = buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload, ext ? { ext } : {})
    this.transport.send(encode(frame))
  }

  /** Reply to an inbound REQ with a correlated REP. */
  replyTo(req: AnyFrame, type: string, payload: unknown): void {
    const frame = buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload, { corr: req.id })
    this.transport.send(encode(frame))
  }

  /** Send a typed `error` REP correlated to `corr`. */
  sendError(
    corr: string,
    code: ErrorCode,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>
  ): void {
    const frame = buildEnvelope('error', { code, message, retryable, ...(details ? { details } : {}) }, { corr })
    this.transport.send(encode(frame))
  }

  close(code: number, reason: string): void {
    this.state = 'CLOSED'
    this.transport.close(code, reason)
  }

  private onClose(_code: number, _reason: string): void {
    this.state = 'CLOSED'
    this.correlator.rejectAll(new ConnectionClosed())
    // Remove the registry entry only while it is still OURS. On reconnect the new
    // connection's auth overwrites the entry (keyed by daemonId), and a half-dead
    // old socket's close event can arrive AFTER that — it must not evict the live
    // connection (the fleet would read `offline` while heartbeats keep flowing).
    if (this.daemonId && this.deps.connReg.get(this.daemonId)?.conn === this) {
      this.deps.connReg.remove(this.daemonId)
    }
  }
}
