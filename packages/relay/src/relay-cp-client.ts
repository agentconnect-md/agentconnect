/**
 * `RelayCpClient` — the relay-side control-plane WebSocket client FSM
 * (shared-bot-relay.md §7.1 / §8). Dials OUT to the CP `/api/v1/relays/ws`, runs
 * the `rc/auth` → `rc/register` handshake, then emits `rc/heartbeat`, dispatches
 * the CP's `rc/daemon-revoke` EVTs, and reconnects with backoff.
 *
 * It is the relay's ONE link to the CP and carries ONLY control signaling — never
 * message content (that flows on the rd/* daemon wire, PR 2). Structurally the
 * mirror of the daemon's `CpClient`, built on the shared `@agentconnect.md/connection`
 * primitives (transport, correlator, backoff) so the two clients don't fork.
 *
 * Milestone A drives registration + heartbeat; `verify()` is the seam PR 2's
 * daemon-facing `rd/hello` handler calls to delegate credential checks to the CP.
 */
import {
  buildRelayCpFrame,
  decodeRelayCpFrame,
  type RelayCpFrame,
  type RcAuthOk,
  type RcRegistered,
  type RcVerify,
  type RcVerifyResult,
  type RcGithubCommentAuthz,
  type RcGithubRerequest,
  type RcGithubRerequestResult,
  type RcDaemonRevoke,
  type RcBotAssign,
  type RcBotUnassign,
  type RcRoutes,
  type RcAssign,
  type RcParticipantAssign,
  type RcHookAssign,
  type RcHookRemove,
  type RcRunReport,
  type RcGithubInstallation,
  type RcSetChannelAgent,
  type RcBotChannels,
  type RcBotConversation,
  type RcBotRevoked,
  type RcNoticePosted,
  type RcThreadAssign,
  type RcThreadParticipant,
  type RcThreadLookup,
  type RcThreadLookupOk,
  type RcCollabRoutes,
  type RcMcpAssign,
  type RcMcpUnassign,
  type RcMemoryConnectionAssign,
  type RcMemoryConnectionUnassign,
  type ErrorCode
} from '@agentconnect.md/protocol'
import {
  Backoff,
  ReqRep,
  WireError,
  type Clock,
  type RequestOpts,
  type TimerHandle,
  type Transport
} from '@agentconnect.md/connection'
import type { Logger } from './log.js'
import type { RelayAuthCredential } from './config.js'

const ACK_TIMEOUT_MS = 5000

/** CP close code for a rejected credential — fatal, never auto-retry (mirrors the daemon's 4401). */
const AUTH_FAILED_CLOSE = 4401

export type RelayCpState = 'CONNECTING' | 'AUTHENTICATING' | 'REGISTERING' | 'READY' | 'CLOSED' | 'DEGRADED'

export interface RelayCpClientDeps {
  /** The §8 credential presented on `rc/auth` (shared token or per-relay ApiKey). */
  auth: RelayAuthCredential
  /** Deployment identity — the CP's `relay` upsert key (`rc/register.name`). */
  name: string
  /** Per-instance-routable address daemons dial (`rc/register.daemonUrl`). */
  daemonUrl: string
  /** Heartbeat cadence fallback when `rc/auth/ok` carries none. */
  heartbeatDefaultMs: number
  clock: Clock
  /** Dial factory — prod passes a `ClientTransport.dial(...)`; tests inject a fake. */
  connect: () => Promise<Transport>
  log: Logger
  /** Backoff jitter in [0,1); defaults to Math.random. Injected as `() => 0` in tests. */
  jitter?: () => number
  /** Called with the CP-assigned relayId on every successful `rc/register`. */
  onRegistered?: (relayId: string) => void
  /** Called on a CP `rc/daemon-revoke` EVT (PR 2 drops the daemon's rd/* connection). */
  onRevoke?: (daemonId: string) => void
  /** Shared-bot control (§7.1 / §10): assign/release a bot's ingest, hot-update its
   *  routes, and seed durable thread affinity. */
  onBotAssign?: (a: RcBotAssign) => void
  onBotUnassign?: (a: RcBotUnassign) => void
  onRoutes?: (r: RcRoutes) => void
  onAssign?: (a: RcAssign) => void
  onParticipantAssign?: (a: RcParticipantAssign) => void
  /** Called on a CP `rc/hook-assign` EVT — upsert one compiled hook rule
   *  (webhook-triggers doc). The rule carries `hmacSecret` — NEVER log it. */
  onHookAssign?: (rule: RcHookAssign) => void
  /** Called on a CP `rc/hook-remove` EVT — drop one hook rule. */
  onHookRemove?: (hookId: string) => void
  /** Called on a CP `rc/collab-routes` EVT — FULL-REPLACE the bot-agnostic
   *  collaboration routing snapshot (agent-collaboration §2.3/§6.2). */
  onCollabRoutes?: (snap: RcCollabRoutes) => void
  /** Called on a CP `rc/mcp-assign` EVT — load/replace one MCP provider's proxy binding
   *  (centralized-tool-management.md §5.2). Carries the upstream credential — NEVER log. */
  onMcpAssign?: (a: RcMcpAssign) => void
  /** Called on a CP `rc/mcp-unassign` EVT — drop a whole provider or retire one grant hash. */
  onMcpUnassign?: (a: RcMcpUnassign) => void
  /** Purpose-separated daemon-private memory plugin proxy bindings. */
  onMemoryConnectionAssign?: (a: RcMemoryConnectionAssign) => void
  onMemoryConnectionUnassign?: (a: RcMemoryConnectionUnassign) => void
  /** Called once the relay reaches READY on each (re)connect. */
  onReady?: () => void
}

export class RelayCpClient {
  state: RelayCpState = 'CLOSED'
  relayId?: string

  private transport?: Transport
  private readonly correlator: ReqRep<RelayCpFrame>
  private readonly backoff: Backoff
  private stopped = false
  private fatal = false // AUTH_FAILED — never auto-retry
  private reconnectTimer?: TimerHandle
  private heartbeatTimer?: TimerHandle
  private heartbeatMs = 0

  constructor(private readonly deps: RelayCpClientDeps) {
    this.correlator = new ReqRep<RelayCpFrame>(deps.clock, ACK_TIMEOUT_MS)
    this.backoff = new Backoff(deps.jitter ? { jitter: deps.jitter } : {})
  }

  /** Non-blocking: kicks off the connect loop and returns. */
  start(): void {
    this.stopped = false
    this.fatal = false
    void this.attemptConnect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer !== undefined) {
      this.deps.clock.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.stopHeartbeat()
    this.correlator.rejectAll(new Error('stopping'))
    this.transport?.close(1000, 'shutdown')
    this.state = 'CLOSED'
  }

  /** True once the relay↔CP link has completed registration and is heartbeating. */
  isReady(): boolean {
    return this.state === 'READY'
  }

  /**
   * Delegate a credential check to the CP (`rc/verify` → `rc/verify/ok`). The
   * relay holds no database, so the daemon-facing `rd/hello` handler (PR 2) and
   * the browser webchat handshake (PR 3) resolve their credentials this way.
   * Usable only while READY; throws a retryable {@link WireError} otherwise.
   */
  async verify(kind: RcVerify['kind'], credential: string): Promise<RcVerifyResult> {
    if (this.state !== 'READY' || !this.transport) {
      throw new WireError('INTERNAL', `relay↔CP link not ready (${this.state})`, true)
    }
    const request: RcVerify =
      kind === 'webchat-token' ? { kind, credential, conversationBinding: 'v1' } : { kind, credential }
    const rep = await this.sendRequest(buildRelayCpFrame('rc/verify', request))
    if (rep.type !== 'rc/verify/ok') {
      throw new WireError('INTERNAL', `expected rc/verify/ok, got ${rep.type}`, false)
    }
    return rep.payload
  }

  /**
   * Resolve an untrusted/stale GitHub comment association against the App's
   * current repository permission. This request is deliberately single-shot:
   * GitHub deliveries are already deduplicated by delivery id, and retrying the
   * control RPC could duplicate an expensive upstream permission lookup.
   */
  async authorizeGithubComment(request: RcGithubCommentAuthz): Promise<boolean> {
    if (this.state !== 'READY' || !this.transport) {
      throw new WireError('INTERNAL', `relay↔CP link not ready (${this.state})`, true)
    }
    const rep = await this.sendRequest(buildRelayCpFrame('rc/github-comment-authz', request), {
      maxTries: 1,
      ackTimeoutMs: ACK_TIMEOUT_MS
    })
    if (rep.type !== 'rc/github-comment-authz/ok') {
      throw new WireError('INTERNAL', `expected rc/github-comment-authz/ok, got ${rep.type}`, false)
    }
    return rep.payload.allowed
  }

  /** Resolve a signature-verified Check run or suite rerequest to current
   * informational projection targets. Single-shot: GitHub redelivery keeps the
   * same delivery key and the daemon/hook stores provide the retry fence. */
  async authorizeGithubRerequest(request: RcGithubRerequest): Promise<RcGithubRerequestResult> {
    if (this.state !== 'READY' || !this.transport) {
      throw new WireError('INTERNAL', `relay↔CP link not ready (${this.state})`, true)
    }
    const rep = await this.sendRequest(buildRelayCpFrame('rc/github-rerequest', request), {
      maxTries: 1,
      ackTimeoutMs: ACK_TIMEOUT_MS
    })
    if (rep.type !== 'rc/github-rerequest/ok') {
      throw new WireError('INTERNAL', `expected rc/github-rerequest/ok, got ${rep.type}`, false)
    }
    return rep.payload
  }

  /**
   * Emit one delivery-stage bookkeeping EVT (`rc/run-report`, fire-and-forget).
   * A CP outage drops the report — by design the TRIGGER survives (the daemon
   * already has the fire) and only the console record suffers; the reaper and a
   * late `hook/report` converge the row when the CP returns.
   */
  emitRunReport(report: RcRunReport): void {
    if (this.state !== 'READY' || !this.transport) {
      this.deps.log.warn(`relay: dropping rc/run-report ${report.hookId}:${report.deliveryKey} (link ${this.state})`)
      return
    }
    this.transport.send(JSON.stringify(buildRelayCpFrame('rc/run-report', report)))
  }

  /**
   * Emit one installation doorbell EVT (`rc/github-installation`, fire-and-forget,
   * decision 11). A drop is safe: the CP's pull-based sync paths (setup callback /
   * manual Sync / mint-failure markRevoked) converge without the poke.
   */
  emitGithubInstallation(poke: RcGithubInstallation): void {
    if (this.state !== 'READY' || !this.transport) {
      this.deps.log.warn(`relay: dropping rc/github-installation ${poke.installationId} (link ${this.state})`)
      return
    }
    this.transport.send(JSON.stringify(buildRelayCpFrame('rc/github-installation', poke)))
  }

  /** Emit `rc/set-channel-agent` (fire-and-forget) — the config modal picked a
   *  channel's default agent. Dropped if the CP link is down (the operator can retry). */
  emitSetChannelAgent(m: RcSetChannelAgent): void {
    if (this.state !== 'READY' || !this.transport) {
      this.deps.log.warn(`relay: dropping rc/set-channel-agent for ${m.botId} (link ${this.state})`)
      return
    }
    this.transport.send(JSON.stringify(buildRelayCpFrame('rc/set-channel-agent', m)))
  }

  /** Emit the latest complete channel-membership snapshot for one HTTP Slack bot.
   *  The manager retains the snapshot when this returns false and retries on READY. */
  emitBotChannels(m: RcBotChannels): boolean {
    if (this.state !== 'READY' || !this.transport) {
      this.deps.log.warn(`relay: deferring rc/bot-channels for ${m.botId} (link ${this.state})`)
      return false
    }
    this.transport.send(JSON.stringify(buildRelayCpFrame('rc/bot-channels', m)))
    return true
  }

  /** Emit one DELIVERED §14.3 DM gating-notice report. Best-effort: a drop costs at
   *  most one duplicate notice later, never a lost enablement path. */
  emitNoticePosted(m: RcNoticePosted): boolean {
    if (this.state !== 'READY' || !this.transport) {
      this.deps.log.warn(`relay: dropping rc/notice-posted for ${m.botId} (link ${this.state})`)
      return false
    }
    this.transport.send(JSON.stringify(buildRelayCpFrame('rc/notice-posted', m)))
    return true
  }

  /** Emit one incremental gated-DM conversation report (§14.3). Best-effort: a drop
   *  self-heals on the counterpart's next DM, so there is no pending-retry queue. */
  emitBotConversation(m: RcBotConversation): boolean {
    if (this.state !== 'READY' || !this.transport) {
      this.deps.log.warn(`relay: dropping rc/bot-conversation for ${m.botId} (link ${this.state})`)
      return false
    }
    this.transport.send(JSON.stringify(buildRelayCpFrame('rc/bot-conversation', m)))
    return true
  }

  /** Report one workspace uninstall / token revocation and WAIT for the CP to
   *  commit it (`rc/bot-revoked` → `/ok`). Returns false — keep it queued and retry
   *  — when the link isn't READY or no ack came back. This is the only rc/* report
   *  that is acknowledged: Slack acked the event before the relay's handler ran and
   *  never redelivers it, and no CP-side probe can discover a dead token, so a
   *  send that the socket accepted but the CP failed to persist would silently
   *  leave an uninstalled app shown as active forever. Re-applying is a no-op. */
  async reportBotRevoked(m: RcBotRevoked): Promise<boolean> {
    if (this.state !== 'READY' || !this.transport) {
      this.deps.log.warn(`relay: deferring rc/bot-revoked for ${m.botId} (link ${this.state})`)
      return false
    }
    try {
      const rep = await this.sendRequest(buildRelayCpFrame('rc/bot-revoked', m), {
        maxTries: 1,
        ackTimeoutMs: ACK_TIMEOUT_MS
      })
      // Any reply is terminal: `applied:false` means the CP's generation fence
      // refused a stale report, which is just as settled as applying it.
      return rep.type === 'rc/bot-revoked/ok'
    } catch (err) {
      // No COMMIT ack — keep it queued. A socket that accepted the bytes proves
      // nothing about the CP having persisted the revocation.
      this.deps.log.warn(`relay: rc/bot-revoked for ${m.botId} unacknowledged: ${(err as Error).message}`)
      return false
    }
  }

  /** Emit `rc/thread-assign` — REPORT leg of the affinity dance: the relay tells the CP
   *  which agent now owns a (channel, thread) sessionKey. The CP is the single writer;
   *  it persists + broadcasts the binding back via `rc/assign`. Returns `false` (without
   *  sending) if the link is down, so the caller can retry it on reconnect — a report
   *  lost here would otherwise never persist and follow-ups on other pods would drop. */
  emitThreadAssign(m: RcThreadAssign): boolean {
    if (this.state !== 'READY' || !this.transport) {
      this.deps.log.warn(`relay: deferring rc/thread-assign for ${m.botId} (link ${this.state})`)
      return false
    }
    this.transport.send(JSON.stringify(buildRelayCpFrame('rc/thread-assign', m)))
    return true
  }

  /** Persist one room member without touching the compatibility owner. */
  emitThreadParticipant(m: RcThreadParticipant): boolean {
    if (this.state !== 'READY' || !this.transport) {
      this.deps.log.warn(`relay: deferring rc/thread-participant for ${m.botId} (link ${this.state})`)
      return false
    }
    this.transport.send(JSON.stringify(buildRelayCpFrame('rc/thread-participant', m)))
    return true
  }

  /** `rc/thread-lookup` → `rc/thread-lookup/ok` — pull-on-miss BACKSTOP leg. When an
   *  un-mentioned follow-up arrives for a thread this pod holds no affinity for (missed
   *  the broadcast, or (re)started after it), pull the persisted owner rather than drop.
   *  Single-shot: a CP outage rejects (the caller drops the message, bounded loss). */
  async lookupThread(m: RcThreadLookup): Promise<RcThreadLookupOk> {
    if (this.state !== 'READY' || !this.transport) {
      throw new WireError('INTERNAL', `relay↔CP link not ready (${this.state})`, true)
    }
    const rep = await this.sendRequest(buildRelayCpFrame('rc/thread-lookup', m), {
      maxTries: 1,
      ackTimeoutMs: ACK_TIMEOUT_MS
    })
    if (rep.type !== 'rc/thread-lookup/ok') {
      throw new WireError('INTERNAL', `expected rc/thread-lookup/ok, got ${rep.type}`, false)
    }
    return rep.payload
  }

  private async attemptConnect(): Promise<void> {
    if (this.stopped || this.fatal) return
    this.state = 'CONNECTING'
    try {
      const t = await this.deps.connect()
      if (this.stopped || this.fatal) {
        t.close(1000, 'shutdown') // stop() (or a fatal close) raced the dial — drop it.
        return
      }
      this.transport = t
      t.onMessage((txt) => void this.onText(txt))
      t.onClose((c, r) => this.onClose(c, r))
      await this.handshake()
      this.backoff.reset() // connected — reset backoff
    } catch (err) {
      this.deps.log.warn(`relay: connect/handshake failed: ${(err as Error).message}`)
      this.transport?.close(1011, 'handshake failed')
      this.transport = undefined
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fatal) return
    if (this.reconnectTimer !== undefined) return // one in flight
    const delay = this.backoff.next()
    this.reconnectTimer = this.deps.clock.setTimeout(() => {
      this.reconnectTimer = undefined
      void this.attemptConnect()
    }, delay)
  }

  private async handshake(): Promise<void> {
    // ── auth (§8 dual-mode: token | apikey; the credential is secret — never logged) ──
    this.state = 'AUTHENTICATING'
    const authOk = await this.sendRequest(
      buildRelayCpFrame('rc/auth', { method: this.deps.auth.method, credential: this.deps.auth.credential })
    )
    const ok = authOk.payload as RcAuthOk

    // ── register (upsert by name → relayId; re-sent every reconnect) ──
    this.state = 'REGISTERING'
    const registered = await this.sendRequest(
      buildRelayCpFrame('rc/register', { name: this.deps.name, daemonUrl: this.deps.daemonUrl })
    )
    this.relayId = (registered.payload as RcRegistered).relayId
    this.deps.onRegistered?.(this.relayId)

    this.state = 'READY'
    this.heartbeatMs = ok.heartbeatSec > 0 ? ok.heartbeatSec * 1000 : this.deps.heartbeatDefaultMs
    this.armHeartbeat()
    this.deps.log.info(`relay: READY (relayId=${this.relayId})`)
    this.deps.onReady?.()
  }

  private sendRequest(frame: RelayCpFrame, opts?: RequestOpts): Promise<RelayCpFrame> {
    return this.correlator.request(frame, (e) => this.transport!.send(e), opts)
  }

  private async onText(text: string): Promise<void> {
    const decoded = decodeRelayCpFrame(text)
    if (!decoded.ok) {
      const code = this.decodeErrorCode(decoded.msg)
      this.sendError(decoded.id, code, decoded.msg, false)
      if (decoded.corr) {
        this.correlator.reject(decoded.corr, new WireError(code, `invalid correlated reply: ${decoded.msg}`, false))
      }
      return
    }
    const frame = decoded.frame
    // A correlated REP/error settles a pending relay-issued REQ.
    if (frame.corr && this.correlator.settle(frame)) return
    // Control frames (EVTs) are only legal once READY.
    if (this.state !== 'READY') {
      this.sendError(frame.id, 'PROTOCOL_STATE', `${frame.type} illegal in ${this.state}`, false)
      return
    }
    this.dispatch(frame)
  }

  private dispatch(frame: RelayCpFrame): void {
    switch (frame.type) {
      case 'rc/daemon-revoke': {
        const { daemonId } = frame.payload as RcDaemonRevoke
        this.deps.onRevoke?.(daemonId)
        return
      }
      case 'rc/bot-assign': {
        this.deps.onBotAssign?.(frame.payload as RcBotAssign)
        return
      }
      case 'rc/bot-unassign': {
        this.deps.onBotUnassign?.(frame.payload as RcBotUnassign)
        return
      }
      case 'rc/routes': {
        this.deps.onRoutes?.(frame.payload as RcRoutes)
        return
      }
      case 'rc/assign': {
        this.deps.onAssign?.(frame.payload as RcAssign)
        return
      }
      case 'rc/participant-assign': {
        this.deps.onParticipantAssign?.(frame.payload as RcParticipantAssign)
        return
      }
      case 'rc/hook-assign': {
        this.deps.onHookAssign?.(frame.payload as RcHookAssign)
        return
      }
      case 'rc/hook-remove': {
        this.deps.onHookRemove?.((frame.payload as RcHookRemove).hookId)
        return
      }
      case 'rc/collab-routes': {
        this.deps.onCollabRoutes?.(frame.payload as RcCollabRoutes)
        return
      }
      case 'rc/mcp-assign': {
        this.deps.onMcpAssign?.(frame.payload as RcMcpAssign)
        return
      }
      case 'rc/mcp-unassign': {
        this.deps.onMcpUnassign?.(frame.payload as RcMcpUnassign)
        return
      }
      case 'rc/memoryconnection-assign': {
        this.deps.onMemoryConnectionAssign?.(frame.payload as RcMemoryConnectionAssign)
        return
      }
      case 'rc/memoryconnection-unassign': {
        this.deps.onMemoryConnectionUnassign?.(frame.payload as RcMemoryConnectionUnassign)
        return
      }
      default:
        // REPs (rc/auth/ok, rc/registered, rc/verify/ok) settle via the correlator;
        // anything else is an unexpected EVT — ignore rather than close (forward-compat).
        this.deps.log.debug(`relay: ignoring unexpected ${frame.type}`)
    }
  }

  private decodeErrorCode(msg: string): ErrorCode {
    if (msg === 'FRAME_TOO_LARGE') return 'FRAME_TOO_LARGE'
    if (msg === 'UNKNOWN_FRAME') return 'UNKNOWN_FRAME'
    return 'BAD_PAYLOAD'
  }

  private sendError(corr: string, code: ErrorCode, message: string, retryable: boolean): void {
    if (!this.transport) return
    this.transport.send(JSON.stringify(buildRelayCpFrame('error', { code, message, retryable }, { corr })))
  }

  private onClose(code: number, _reason: string): void {
    this.stopHeartbeat()
    // Drop the dead transport: `ws.send` on a CLOSED socket is silently swallowed,
    // so anything still holding it would hang for a full retransmit budget.
    this.transport = undefined
    this.correlator.rejectAll(new WireError('INTERNAL', 'connection closed', true))
    if (code === AUTH_FAILED_CLOSE) {
      this.fatal = true
      this.state = 'CLOSED'
      this.deps.log.error('relay: AUTH_FAILED (4401) — not reconnecting; check RELAY_TOKEN / RELAY_API_KEY')
      return
    }
    if (this.stopped) {
      this.state = 'CLOSED'
      return
    }
    this.state = 'DEGRADED'
    this.scheduleReconnect()
  }

  private armHeartbeat(): void {
    this.heartbeatTimer = this.deps.clock.setTimeout(() => {
      if (this.state === 'READY') {
        this.transport?.send(JSON.stringify(buildRelayCpFrame('rc/heartbeat', {})))
        this.armHeartbeat()
      }
    }, this.heartbeatMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      this.deps.clock.clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }
}
