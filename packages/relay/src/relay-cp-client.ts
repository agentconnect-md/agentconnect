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
  GITLAB_COM_V1_FEATURE,
  GITLAB_INSTANCE_V1_FEATURE,
  GITLAB_RERUN_V1_FEATURE,
  PULL_REQUEST_FEEDBACK_FEATURE,
  WEBCHAT_SESSION_CONTINUATION_FEATURE,
  RELAY_CP_SCHEMAS,
  type RelayCpFrame,
  type RelayCpFrameType,
  type RcAuthOk,
  type RcDeploymentConfig,
  type RcRegistered,
  type RcVerify,
  type RcVerifyResult,
  type RcCodeHostMembershipAuthz,
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
  type RcHookRerun,
  type RcHookRerunResult,
  type RcRunReport,
  type RcGithubInstallation,
  type RcPullRequestFeedback,
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
import type { z } from 'zod'
import type { Logger } from './log.js'
import type { RelayAuthCredential } from './config.js'

const ACK_TIMEOUT_MS = 5000

/** How long an out-of-band GitHub authorization waits for a reconnecting link before
 *  failing closed. A CP restart drops the link for seconds; the delivery is already
 *  answered 202, so waiting costs nothing and is the difference between a review and
 *  a silently skipped one. */
const LINK_READY_WAIT_MS = 30_000

/** Run reports held while the link is down. Bounded — the OLDEST is dropped first
 *  (a stale delivery-stage row is the least useful one to replay). */
const MAX_PENDING_RUN_REPORTS = 200

/** CP close code for a rejected credential — fatal, never auto-retry (mirrors the daemon's 4401). */
const AUTH_FAILED_CLOSE = 4401

interface ReadyWaiter {
  resolve: (ready: boolean) => void
  timer?: TimerHandle
}

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
  /** Called on a CP `rc/hook-rerun` REQ — re-dispatch one gitlab hook turn the
   *  Console asked for (gitlab-com-integration.md §16.1). The returned verdict IS
   *  the correlated reply: only `admitted` claims a turn was queued. */
  onHookRerun?: (rerun: RcHookRerun) => RcHookRerunResult
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
  /** First authenticated deployment snapshot in this process. Later reconnects
   *  deliberately do not hot-reload it; an operator restart applies changes. */
  onDeploymentConfig?: (config: RcDeploymentConfig) => void
}

export class RelayCpClient {
  state: RelayCpState = 'CLOSED'
  relayId?: string

  private transport?: Transport
  private readonly correlator: ReqRep<RelayCpFrame>
  private readonly backoff: Backoff
  private stopped = false
  private fatal = false // AUTH_FAILED — never auto-retry
  private deploymentConfigDecided = false
  private reconnectTimer?: TimerHandle
  private heartbeatTimer?: TimerHandle
  private heartbeatMs = 0
  /** Bumped on every registration — identifies WHICH connection a request rode. */
  private linkGeneration = 0
  /** Callers parked in {@link waitReady} until the link registers again. */
  private readonly readyWaiters = new Set<ReadyWaiter>()
  /** FIFO of `rc/run-report` EVTs the link wasn't up for, replayed on READY. */
  private readonly pendingRunReports: RcRunReport[] = []
  private serverFeatures = new Set<string>()

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
    this.releaseReadyWaiters(false)
    this.transport?.close(1000, 'shutdown')
    this.state = 'CLOSED'
  }

  /** True once the relay↔CP link has completed registration and is heartbeating. */
  isReady(): boolean {
    return this.state === 'READY'
  }

  /**
   * Resolve as soon as the link is READY, or `false` when `timeoutMs` elapses
   * first (or this client is stopped / fatally closed). The GitHub
   * authorization path rides a reconnect on this instead of failing closed on a
   * seconds-long CP restart, which would silently skip the review the delivery
   * was going to trigger.
   */
  waitReady(timeoutMs: number): Promise<boolean> {
    if (this.state === 'READY' && this.transport) return Promise.resolve(true)
    if (this.stopped || this.fatal || timeoutMs <= 0) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const waiter: ReadyWaiter = { resolve }
      waiter.timer = this.deps.clock.setTimeout(() => {
        this.readyWaiters.delete(waiter)
        resolve(false)
      }, timeoutMs)
      this.readyWaiters.add(waiter)
    })
  }

  private releaseReadyWaiters(ready: boolean): void {
    for (const waiter of [...this.readyWaiters]) {
      this.readyWaiters.delete(waiter)
      if (waiter.timer !== undefined) this.deps.clock.clearTimeout(waiter.timer)
      waiter.resolve(ready)
    }
  }

  /**
   * Delegate a credential check to the CP (`rc/verify` → `rc/verify/ok`). The
   * relay holds no database, so the daemon-facing `rd/hello` handler (PR 2) and
   * the browser webchat handshake (PR 3) resolve their credentials this way.
   * Usable only while READY; throws a retryable {@link WireError} otherwise.
   *
   * `daemonId` is forwarded unverified; CP requires it to match the reviewed install identity.
   */
  async verify(kind: RcVerify['kind'], credential: string, daemonId?: string): Promise<RcVerifyResult> {
    if (this.state !== 'READY' || !this.transport) {
      throw new WireError('INTERNAL', `relay↔CP link not ready (${this.state})`, true)
    }
    const request: RcVerify =
      kind === 'webchat-token'
        ? { kind, credential, conversationBinding: 'v1' }
        : kind === 'daemon-token'
          ? { kind, credential, ...(daemonId ? { daemonId } : {}) }
          : { kind, credential }
    const rep = await this.sendRequest(buildRelayCpFrame('rc/verify', request))
    if (rep.type !== 'rc/verify/ok') {
      throw new WireError('INTERNAL', `expected rc/verify/ok, got ${rep.type}`, false)
    }
    return rep.payload
  }

  /**
   * One authorization RPC, single-shot PER LINK but held across ONE reconnect:
   * the caller is off GitHub's HTTP request already, and failing closed on a
   * link that is merely restarting turns a CP rollout into silently skipped
   * reviews. The second attempt is bought by a REPLACED CONNECTION, never by a
   * retryable flag: an ack timeout and the CP's own retryable `error` REPs both
   * arrive on a link that is still READY, and re-issuing there would duplicate
   * an expensive upstream permission lookup.
   */
  private async authorizationRequest(build: () => RelayCpFrame, label: string): Promise<RelayCpFrame> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!(await this.waitReady(LINK_READY_WAIT_MS)) || !this.transport) {
        throw new WireError('INTERNAL', `relay↔CP link not ready (${this.state})`, true)
      }
      const generation = this.linkGeneration
      try {
        return await this.sendRequest(build(), { maxTries: 1, ackTimeoutMs: ACK_TIMEOUT_MS })
      } catch (err) {
        if (attempt > 0 || !(err instanceof WireError) || !err.retryable) throw err
        // Only a connection this request never reached the CP over is retryable
        // here: wait for the replacement, and give up on the original error if
        // the link that failed is still the live one.
        if (!(await this.waitReady(LINK_READY_WAIT_MS)) || this.linkGeneration === generation) throw err
        this.deps.log.warn(`relay: ${label} lost its link (${err.message}) — retrying across the reconnect`)
      }
    }
    throw new WireError('INTERNAL', `relay↔CP link not ready (${this.state})`, true)
  }

  /**
   * Resolve an untrusted/stale GitHub comment association against the App's
   * current repository permission. One upstream permission lookup per link: the
   * request is never retransmitted on the same connection (GitHub deliveries are
   * already deduplicated by delivery id), only re-issued once after a reconnect.
   */
  /** §12.2 live effective-membership gate — the provider-neutral successor to
   * the GitHub comment authz REQ. Fail-closed at the caller on any error. */
  async authorizeCodeHostMembership(request: RcCodeHostMembershipAuthz): Promise<boolean> {
    const rep = await this.authorizationRequest(
      () => buildRelayCpFrame('rc/codehost-membership-authz', request),
      'rc/codehost-membership-authz'
    )
    if (rep.type !== 'rc/codehost-membership-authz/ok') {
      throw new WireError('INTERNAL', `expected rc/codehost-membership-authz/ok, got ${rep.type}`, false)
    }
    return rep.payload.allowed
  }

  async authorizeGithubComment(request: RcGithubCommentAuthz): Promise<boolean> {
    const rep = await this.authorizationRequest(
      () => buildRelayCpFrame('rc/github-comment-authz', request),
      'rc/github-comment-authz'
    )
    if (rep.type !== 'rc/github-comment-authz/ok') {
      throw new WireError('INTERNAL', `expected rc/github-comment-authz/ok, got ${rep.type}`, false)
    }
    return rep.payload.allowed
  }

  /** Resolve a signature-verified Check run or suite rerequest to current
   * informational projection targets. Same one-attempt-per-link rule: GitHub
   * redelivery keeps the same delivery key and the daemon/hook stores provide
   * the retry fence. */
  async authorizeGithubRerequest(request: RcGithubRerequest): Promise<RcGithubRerequestResult> {
    const rep = await this.authorizationRequest(
      () => buildRelayCpFrame('rc/github-rerequest', request),
      'rc/github-rerequest'
    )
    if (rep.type !== 'rc/github-rerequest/ok') {
      throw new WireError('INTERNAL', `expected rc/github-rerequest/ok, got ${rep.type}`, false)
    }
    return rep.payload
  }

  /**
   * Emit one delivery-stage bookkeeping EVT (`rc/run-report`, fire-and-forget).
   * A report the link wasn't up for is QUEUED and replayed on READY, in order:
   * the row it opens is the only trace some deliveries ever get (a delivery
   * refused pre-dispatch never reaches a daemon, so no late `hook/report`
   * converges it), and dropping it leaves the console showing nothing at all.
   * `firedAt` travels with the report, so a replayed row keeps its real time.
   */
  emitRunReport(report: RcRunReport): void {
    if (this.state !== 'READY' || !this.transport) {
      if (this.pendingRunReports.length >= MAX_PENDING_RUN_REPORTS) {
        const dropped = this.pendingRunReports.shift()!
        this.deps.log.warn(`relay: dropping rc/run-report ${dropped.hookId}:${dropped.deliveryKey} (queue full)`)
      }
      this.pendingRunReports.push(report)
      this.deps.log.warn(`relay: deferring rc/run-report ${report.hookId}:${report.deliveryKey} (link ${this.state})`)
      return
    }
    this.transport.send(JSON.stringify(buildRelayCpFrame('rc/run-report', report)))
  }

  /** Replay the reports queued while the link was down (oldest first), stopping
   *  at the first one the link still can't take. */
  private flushPendingRunReports(): void {
    while (this.pendingRunReports.length > 0) {
      if (this.state !== 'READY' || !this.transport) return
      this.transport.send(JSON.stringify(buildRelayCpFrame('rc/run-report', this.pendingRunReports.shift()!)))
    }
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

  /** Persist body-free PR feedback before the webhook response lets GitHub retire the delivery. */
  async reportPullRequestFeedback(signal: RcPullRequestFeedback): Promise<boolean> {
    if (this.state !== 'READY' || !this.transport) {
      throw new WireError('INTERNAL', `relay↔CP link not ready (${this.state})`, true)
    }
    if (!this.serverFeatures.has(PULL_REQUEST_FEEDBACK_FEATURE)) return false
    const rep = await this.sendRequest(buildRelayCpFrame('rc/pull-request-feedback', signal), {
      maxTries: 1,
      ackTimeoutMs: ACK_TIMEOUT_MS
    })
    if (rep.type !== 'rc/pull-request-feedback/ok') {
      throw new WireError('INTERNAL', `expected rc/pull-request-feedback/ok, got ${rep.type}`, false)
    }
    return rep.payload.accepted
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

  /** Emit one incremental direct-conversation report. Best-effort: a drop
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
    if (!this.deploymentConfigDecided) {
      this.deploymentConfigDecided = true
      if (ok.deploymentConfig) this.deps.onDeploymentConfig?.(ok.deploymentConfig)
    }

    // ── register (upsert by name → relayId; re-sent every reconnect) ──
    this.state = 'REGISTERING'
    const registered = await this.sendRequest(
      buildRelayCpFrame('rc/register', {
        name: this.deps.name,
        daemonUrl: this.deps.daemonUrl,
        // This relay preserves RdMsgWebchat.targetSessionId end to end; the CP
        // gates session-targeted mints on every live relay advertising it.
        // gitlab-com-v1: this relay verifies and routes GitLab project
        // webhooks, so the CP may send it gitlab-kind compiled rules (§17.3).
        // gitlab-rerun-v1: this relay decodes rc/hook-rerun and answers its
        // admission REP — strictly newer than gitlab-com-v1 (§17.3).
        // gitlab-instance-v1: this relay carries the compiled rule's host through onto the
        // trusted metadata it forwards, so a self-managed rule is dispatchable here (§24.4).
        features: [
          WEBCHAT_SESSION_CONTINUATION_FEATURE,
          GITLAB_COM_V1_FEATURE,
          GITLAB_RERUN_V1_FEATURE,
          GITLAB_INSTANCE_V1_FEATURE,
          PULL_REQUEST_FEEDBACK_FEATURE
        ]
      })
    )
    const registeredPayload = registered.payload as RcRegistered
    this.relayId = registeredPayload.relayId
    this.serverFeatures = new Set(registeredPayload.serverFeatures)
    this.deps.onRegistered?.(this.relayId)

    this.state = 'READY'
    this.linkGeneration += 1
    this.heartbeatMs = ok.heartbeatSec > 0 ? ok.heartbeatSec * 1000 : this.deps.heartbeatDefaultMs
    this.armHeartbeat()
    this.deps.log.info(`relay: READY (relayId=${this.relayId})`)
    this.flushPendingRunReports()
    this.releaseReadyWaiters(true)
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
      case 'rc/hook-rerun': {
        // The CP awaits this REP before it tells the console anything, so an
        // unwired relay must answer an error rather than a silent non-admission.
        if (!this.deps.onHookRerun) {
          this.sendError(frame.id, 'PROTOCOL_STATE', 'rc/hook-rerun is not served by this relay', false)
          return
        }
        this.reply(frame.id, 'rc/hook-rerun/ok', this.deps.onHookRerun(frame.payload as RcHookRerun))
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

  /** Correlated REP to a CP-issued REQ (the mirror of the CP's own `reply`). */
  private reply<T extends RelayCpFrameType>(
    corr: string,
    type: T,
    payload: z.input<(typeof RELAY_CP_SCHEMAS)[T]>
  ): void {
    if (!this.transport) return
    this.transport.send(JSON.stringify(buildRelayCpFrame(type, payload, { corr })))
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
    this.serverFeatures.clear()
    this.correlator.rejectAll(new WireError('INTERNAL', 'connection closed', true))
    if (code === AUTH_FAILED_CLOSE) {
      this.fatal = true
      this.state = 'CLOSED'
      this.releaseReadyWaiters(false) // nothing to wait for — this link never comes back
      this.deps.log.error('relay: AUTH_FAILED (4401) — not reconnecting; check RELAY_TOKEN / RELAY_API_KEY')
      return
    }
    if (this.stopped) {
      this.state = 'CLOSED'
      this.releaseReadyWaiters(false)
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
