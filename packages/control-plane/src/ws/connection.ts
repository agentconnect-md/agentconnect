/**
 * `DaemonConnection` — the per-socket lifecycle actor + FSM (design §4.4,
 * protocol §2.1).
 *
 * Owns the `LifecycleState`, gates which frames are legal in each state (`auth`,
 * then `register` or one bootstrap result; anything else → `error PROTOCOL_STATE`), routes
 * correlated REPs to the `ReqRep`, and dispatches legal inbound frames to the
 * `FrameRouter`. Every byte crosses the {@link Transport} seam, so the
 * `InMemoryDaemonStub` drives it with no real socket.
 *
 * It also IS the `DaemonChannel` the orchestrator holds (issue fenced C→D
 * control via `request`/`send`) — but in Phase 2 only the inbound `auth`/
 * `register` path and the legal-frame gate are exercised.
 */
import {
  AnyFrame,
  type ControlExt,
  type ErrorCode,
  checkInboundFrameOrg,
  checkReplyFrameOrg,
  isFrame,
  isInstallWideFrameType,
  type FrameOrgPeer
} from '@agentconnect.md/protocol'
import { decodeEnvelope, buildEnvelope, encode, type InboundControlExt } from './codec.js'
import { ReqRep, type RequestOpts } from './correlator.js'
import type { Transport } from './transport.js'
import { ConnectionClosed, type ConnChannel, type LifecycleState } from './registry.js'
import type { DaemonWsDeps } from './deps.js'
import type { FrameRouter } from './handlers/index.js'
import { DaemonId } from '../domain/ids.js'
import { FencingState, checkFencing } from '../orchestrator/fencing.js'
import { ProtocolError } from '../domain/errors.js'

export class DaemonConnection implements ConnChannel {
  state: LifecycleState = 'CONNECTING'
  daemonId = '' // set on auth/ok; "" until then (ConnChannel requires a string)
  /** Auth-scoped org; null for an install-wide pool member. */
  orgId: string | null = null
  /** The member set this connection may claim duties within (daemon-groups.md §3), resolved at
   *  auth; null ⇒ in no set, and the duty handlers refuse it. Tenancy is NOT re-checked from it:
   *  the write-time invariants on membership already decide what being in this set means. */
  setId: string | null = null
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
    // Returned, not swallowed: a live socket discards it, and the in-memory fake awaits it so a
    // test can barrier on the whole dispatch instead of pausing and hoping.
    this.transport.onMessage((t) =>
      this.onText(t).catch(() => {
        if (this.state !== 'CLOSED') this.close(1011, 'SERVER_INTERNAL')
      })
    )
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

    // A correlated REP/error settles a CP-issued REQ — never re-dispatched. It is fenced on the
    // org of the REQ it answers first: a reply naming another org fails that REQ and applies nothing.
    if (frame.corr) {
      const request = this.correlator.requested(frame.corr)
      if (request) {
        const verdict = checkReplyFrameOrg(request, frame, this.orgPeer())
        if (!verdict.ok) {
          this.deps.log.error(
            { daemonId: this.daemonId, type: frame.type, corr: frame.corr },
            `daemon reply rejected: ${verdict.message}`
          )
          this.correlator.reject(frame.corr, new ProtocolError('SCOPE_DENIED', verdict.message, { retryable: false }))
          return
        }
      }
      if (this.correlator.settle(frame)) return
    }

    // §2.1 legal-frame gate.
    if (!this.isLegalInState(frame.type)) {
      this.sendError(frame.id, 'PROTOCOL_STATE', `${frame.type} illegal in ${this.state}`, false)
      return
    }

    if (!this.gateOrganization(frame)) return

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

  private orgPeer(): FrameOrgPeer {
    return this.orgId ? { mode: 'connection', orgId: this.orgId } : { mode: 'frame', orgId: null }
  }

  /**
   * Connection-scoped tenancy for an ordinary daemon, frame-scoped for a pool member: the shared
   * frame-scope gate first (org required on an org-scoped frame, forbidden on an install-wide one, equal
   * to the connection's where it has one), then the org named against the resource the frame targets.
   */
  private gateOrganization(frame: AnyFrame): boolean {
    if (this.state === 'AUTHENTICATING' || this.state === 'REGISTERING') return true
    const verdict = checkInboundFrameOrg(frame, this.orgPeer())
    if (!verdict.ok) {
      this.sendError(frame.id, 'SCOPE_DENIED', verdict.message, false)
      return false
    }
    if (!frame.orgId || this.orgId) return true
    const targetedOrgId = this.organizationForInbound(frame)
    if (targetedOrgId === null || (targetedOrgId && targetedOrgId !== frame.orgId)) {
      this.sendError(frame.id, 'SCOPE_DENIED', 'organization does not match the targeted resource', false)
      return false
    }
    return true
  }

  private organizationForInbound(frame: AnyFrame): string | null | undefined {
    const payload = frame.payload && typeof frame.payload === 'object' ? (frame.payload as Record<string, unknown>) : {}
    const state = this.deps.connReg.get(this.daemonId)
    const organizations = new Set<string>()
    const collect = (value: unknown, map: Map<string, string> | undefined): void => {
      if (typeof value !== 'string') return
      const orgId = map?.get(value)
      if (orgId) organizations.add(orgId)
    }
    for (const key of ['agentId', 'requesterAgentId', 'sourceAgentId', 'callerAgentId', 'childAgentId']) {
      collect(payload[key], state?.orgByAgent)
    }
    collect(payload.integrationId, state?.orgByIntegration)
    collect(payload.cronId, state?.orgByCron)
    collect(payload.connectionId, state?.orgByMemoryConnection)
    const suggestions = Array.isArray(payload.suggestions) ? payload.suggestions : []
    for (const suggestion of suggestions) {
      if (suggestion && typeof suggestion === 'object') {
        collect((suggestion as Record<string, unknown>).sourceAgentId, state?.orgByAgent)
      }
    }
    if (organizations.size > 1) return null
    return organizations.values().next().value
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
        return type === 'register' || type === 'daemon/bootstrap/result'
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
    opts?: RequestOpts,
    orgId?: string
  ): Promise<TReply> {
    const scopedOrgId = this.outboundOrganization(type, payload, orgId)
    const frame = buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload, {
      ...(ext ? { ext } : {}),
      ...(scopedOrgId ? { orgId: scopedOrgId } : {})
    })
    const rep = await this.correlator.request(frame, (e) => this.transport.send(e), opts)
    return rep.payload as TReply
  }

  /** Fire-and-forget EVT (C→D). */
  send(type: string, payload: unknown, ext?: ControlExt, orgId?: string): void {
    const scopedOrgId = this.outboundOrganization(type, payload, orgId)
    const frame = buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload, {
      ...(ext ? { ext } : {}),
      ...(scopedOrgId ? { orgId: scopedOrgId } : {})
    })
    this.transport.send(encode(frame))
  }

  /** An install-wide frame to a pool member never carries an org, whatever a caller passed; the rest resolve one. */
  private outboundOrganization(type: string, payload: unknown, explicit?: string): string | undefined {
    if (!this.orgId && isInstallWideFrameType(type)) return undefined
    return explicit ?? this.organizationFor(type, payload)
  }

  private organizationFor(type: string, payload: unknown): string | undefined {
    if (this.orgId) return this.orgId
    if (isInstallWideFrameType(type)) return undefined
    const p = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const spec = p.spec && typeof p.spec === 'object' ? (p.spec as Record<string, unknown>) : undefined
    const state = this.deps.connReg.get(this.daemonId)
    const explicitOrgId =
      typeof p.orgId === 'string' ? p.orgId : typeof spec?.orgId === 'string' ? spec.orgId : undefined
    if (explicitOrgId) {
      const remember = (key: string, map: Map<string, string> | undefined): void => {
        const value = p[key] ?? spec?.[key]
        if (typeof value === 'string') map?.set(value, explicitOrgId)
      }
      remember('agentId', state?.orgByAgent)
      remember('integrationId', state?.orgByIntegration)
      remember('cronId', state?.orgByCron)
      remember('connectionId', state?.orgByMemoryConnection)
      return explicitOrgId
    }
    const from = (key: string, map: Map<string, string> | undefined): string | undefined =>
      typeof p[key] === 'string' ? map?.get(p[key]) : undefined
    const orgId =
      from('agentId', state?.orgByAgent) ??
      from('requesterAgentId', state?.orgByAgent) ??
      from('sourceAgentId', state?.orgByAgent) ??
      from('callerAgentId', state?.orgByAgent) ??
      from('childAgentId', state?.orgByAgent) ??
      from('integrationId', state?.orgByIntegration) ??
      from('cronId', state?.orgByCron) ??
      from('name', state?.orgByMcpServer) ??
      from('connectionId', state?.orgByMemoryConnection)
    if (!orgId) throw new ProtocolError('SCOPE_DENIED', `organization is required for ${type}`, { retryable: false })
    return orgId
  }

  /** Reply to an inbound REQ with a correlated REP. */
  replyTo(req: AnyFrame, type: string, payload: unknown): void {
    const frame = buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload, {
      corr: req.id,
      ...(req.orgId ? { orgId: req.orgId } : {})
    })
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
      void this.clearAwaitingApprovals(this.daemonId)
    }
  }

  /** A gone daemon releases nothing: clear its approval waits; its reconnect replay re-asserts live ones (slack-approval-dm.md §7). */
  private async clearAwaitingApprovals(daemonId: string): Promise<void> {
    try {
      const ts = new Date(this.deps.clock.now()).toISOString()
      for (const row of await this.deps.session.clearAwaitingPermissionForDaemon(DaemonId(daemonId))) {
        this.deps.events.publishState(DaemonId(daemonId), {
          agentId: row.agentId,
          sessionId: row.id,
          state: 'idle',
          ts
        })
      }
    } catch {
      // Best-effort: a refused write only delays the bell until the daemon's replay or the next reset.
    }
  }
}
