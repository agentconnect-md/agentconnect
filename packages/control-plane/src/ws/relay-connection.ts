/**
 * `RelayConnection` — the per-socket FSM for a relay dialing the CP over the
 * `rc/*` wire (shared-bot-relay.md §7.1). The relay-side mirror of
 * {@link DaemonConnection}, but a SEPARATE frame union (never the daemon↔CP
 * protocol) and no fencing (relays carry no epoch).
 *
 * States: AUTHENTICATING (only `rc/auth`) → REGISTERING (only `rc/register`) →
 * READY (`rc/heartbeat`, `rc/verify`). On auth the CP verifies the §8 dual-mode
 * credential; on register it upserts the `relay` row by name (reclaiming the same
 * relayId across restarts), registers in the {@link RelayRegistry} (superseding a
 * stale same-relayId connection), and fans the refreshed roster to the daemons.
 * `rc/verify` delegates a daemon's `rd/hello` credential check to the CP (§9).
 *
 * It IS the {@link RelayChannel} the registry holds (to push `rc/daemon-revoke`).
 * Secret material (the `rc/auth` / `rc/verify` credential) is NEVER logged.
 */
import type {
  RcAuth,
  RcDeploymentConfig,
  RcCodeHostMembershipAuthz,
  RcGithubCommentAuthz,
  RcGithubRerequest,
  RcGithubRerequestResult,
  RcGithubInstallation,
  RcRegister,
  RcRunReport,
  RcBotChannels,
  RcBotConversation,
  RcBotRevoked,
  RcNoticePosted,
  RcSetChannelAgent,
  RcThreadAssign,
  RcThreadParticipant,
  RcThreadLookup,
  RcThreadLookupOk,
  RcVerify,
  RcVerifyResult,
  RelayCpFrame,
  RelayCpFrameType,
  ErrorCode
} from '@agentconnect.md/protocol'
import { buildRelayCpFrame, decodeRelayCpFrame, RELAY_CP_SCHEMAS } from '@agentconnect.md/protocol'
import type { z } from 'zod'
import type { Transport } from './transport.js'
import type { RelayAuthService } from '../registry/relayAuthService.js'
import type { RelayRepo } from '../persistence/ports.js'
import type { Clock } from '../domain/clock.js'
import { RelayNotWritten } from './relay-registry.js'
import type { RelayChannel, RelayRegistry } from './relay-registry.js'

type RelayState = 'AUTHENTICATING' | 'REGISTERING' | 'READY' | 'CLOSED'

/** Deadline for a correlated C→R REQ. Bounded well under a console request. */
const RELAY_REQUEST_TIMEOUT_MS = 5_000

export interface RelayConnDeps {
  auth: RelayAuthService
  relays: RelayRepo
  clock: Clock
  /** Static deployment snapshot loaded before the CP assembled. Secret-bearing;
   *  sent only after relay authentication and never logged. */
  deploymentConfig?: RcDeploymentConfig
  /** Fired after a successful register — recompute + fan `relay/roster` to daemons,
   *  and replay the compiled hook rules to THIS relay (its table is a memory copy). */
  onRegistered: (ch: RelayChannel) => void
  /** Apply a relay `rc/run-report` (delivery-stage HookRun bookkeeping). */
  onRunReport: (report: RcRunReport) => Promise<void>
  /** Apply a relay `rc/set-channel-agent` (the in-Slack config modal picked a
   *  channel's default agent). Fire-and-forget; a store error must not close the link. */
  onSetChannelAgent: (m: RcSetChannelAgent) => Promise<void>
  /** Apply a complete Slack channel-membership snapshot reported by HTTP ingest. */
  onBotChannels: (m: RcBotChannels) => Promise<void>
  /** Apply an incremental direct-conversation report (resource-visibility §14.3):
   *  fan a visibility-defaulted row across the bot's installs. Fire-and-forget. */
  onBotConversation: (m: RcBotConversation) => Promise<void>
  /** Record a DELIVERED §14.3 DM gating notice and re-stamp the pool's latch.
   *  Fire-and-forget. */
  onNoticePosted: (m: RcNoticePosted) => Promise<void>
  /** Apply a workspace uninstall / token revocation (`rc/bot-revoked`): mark the
   *  Bot + its installs revoked and release the bot. ACKNOWLEDGED — resolve only
   *  after the decision is COMMITTED (`applied: false` = the generation fence
   *  refused a stale report, which is equally terminal). A throw answers a
   *  retryable error so the relay reports again rather than losing the only
   *  signal a dead credential ever produces. */
  onBotRevoked: (m: RcBotRevoked) => Promise<{ applied: boolean }>
  /** Fired after this relay left the connected registry (socket closed) — the
   *  connected roster changed, so §14.3 notice authorities must re-converge on the
   *  survivors. Best-effort; never throws. */
  onRelayGone?: () => void
  /** Persist a relay `rc/thread-assign` (durable thread affinity REPORT leg) and
   *  broadcast the binding pool-wide (rc/assign). Fire-and-forget; a store error must
   *  not close the link. */
  onThreadAssign: (m: RcThreadAssign) => Promise<void>
  /** Persist one joined room member without replacing affinity. */
  onThreadParticipant: (m: RcThreadParticipant) => Promise<void>
  /** Answer a relay `rc/thread-lookup` (pull-on-miss BACKSTOP) from the persisted
   *  binding. May throw on a transient store error → the handler answers a retryable
   *  error REP without closing the shared relay link. */
  threadLookup: (m: RcThreadLookup) => Promise<RcThreadLookupOk>
  /** Apply a relay `rc/github-installation` doorbell poke (webhook-triggers
   *  decision 11). Fire-and-forget; store/GitHub errors must not close the link. */
  onGithubInstallation: (m: RcGithubInstallation) => Promise<void>
  /** The in-memory relay index — this connection registers itself for `rc/daemon-revoke` push. */
  relayReg: RelayRegistry
  /** Resolve a browser webchat token → identity + the agent's CURRENT placement
   *  (userId, user, agentId, daemonId, orgId, conversationId), or `{ ok:false }` (§10). May throw on a
   *  transient store error → the handler answers a retryable error. */
  verifyWebchatToken: (token: string) => Promise<RcVerifyResult>
  /** Re-check a GitHub comment sender against the current repository permission.
   *  A thrown store/GitHub error becomes a retryable correlated error without
   *  closing the shared relay link. */
  authorizeGithubComment: (req: RcGithubCommentAuthz) => Promise<boolean>
  /** Resolve an App-owned informational Check Run rerequest to one current hook
   *  delivery. Operational failures become a retryable correlated error. */
  authorizeGithubRerequest: (req: RcGithubRerequest) => Promise<RcGithubRerequestResult>
  /** Provider-neutral live membership re-check (gitlab-com-integration.md §12.2).
   *  A thrown store/provider error becomes a retryable correlated error. */
  authorizeCodeHostMembership: (req: RcCodeHostMembershipAuthz) => Promise<boolean>
}

export class RelayConnection implements RelayChannel {
  state: RelayState = 'AUTHENTICATING'
  relayId = ''
  features: readonly string[] = []
  /** In-flight CP-issued REQs on this socket, by frame id (see {@link request}). */
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: unknown) => void }>()

  constructor(
    private readonly transport: Transport,
    private readonly deps: RelayConnDeps
  ) {}

  /** Begin: wire transport callbacks (the gate opens at AUTHENTICATING). */
  start(): void {
    this.transport.onMessage((t) => {
      void this.onText(t).catch(() => {
        if (this.state !== 'CLOSED') this.close(1011, 'SERVER_INTERNAL')
      })
    })
    this.transport.onClose(() => this.onClose())
  }

  private async onText(text: string): Promise<void> {
    const decoded = decodeRelayCpFrame(text)
    if (!decoded.ok) {
      this.sendError(decoded.id, this.decodeErrorCode(decoded.msg), decoded.msg)
      return
    }
    const frame = decoded.frame
    // A correlated REP/error settles a CP-issued REQ — never dispatched as inbound.
    if (this.settle(frame)) return
    if (!this.isLegalInState(frame.type)) {
      this.sendError(frame.id, 'PROTOCOL_STATE', `${frame.type} illegal in ${this.state}`)
      return
    }
    // Defense in depth: a handler that throws (e.g. a persistence error) closes the
    // socket cleanly, never bubbling to an unhandled rejection that takes down the CP.
    try {
      switch (frame.type) {
        case 'rc/auth':
          await this.handleAuth(frame, frame.payload)
          return
        case 'rc/register':
          await this.handleRegister(frame, frame.payload)
          return
        case 'rc/heartbeat':
          await this.handleHeartbeat()
          return
        case 'rc/verify':
          await this.handleVerify(frame, frame.payload)
          return
        case 'rc/github-comment-authz':
          await this.handleGithubCommentAuthz(frame, frame.payload)
          return
        case 'rc/codehost-membership-authz':
          await this.handleCodeHostMembershipAuthz(frame, frame.payload)
          return
        case 'rc/github-rerequest':
          await this.handleGithubRerequest(frame, frame.payload)
          return
        case 'rc/run-report':
          await this.handleRunReport(frame, frame.payload)
          return
        case 'rc/set-channel-agent':
          await this.deps.onSetChannelAgent(frame.payload)
          return
        case 'rc/bot-channels':
          await this.deps.onBotChannels(frame.payload)
          return
        case 'rc/bot-conversation':
          await this.deps.onBotConversation(frame.payload)
          return
        case 'rc/notice-posted':
          await this.deps.onNoticePosted(frame.payload)
          return
        case 'rc/bot-revoked':
          await this.handleBotRevoked(frame, frame.payload)
          return
        case 'rc/thread-assign':
          await this.handleThreadAssign(frame.payload)
          return
        case 'rc/thread-participant':
          await this.handleThreadParticipant(frame.payload)
          return
        case 'rc/thread-lookup':
          await this.handleThreadLookup(frame, frame.payload)
          return
        case 'rc/github-installation':
          await this.handleGithubInstallation(frame.payload)
          return
        default:
          this.sendError(frame.id, 'PROTOCOL_STATE', `unsupported: ${frame.type}`)
      }
    } catch {
      if (this.state !== 'CLOSED') this.close(1011, 'SERVER_INTERNAL')
    }
  }

  private isLegalInState(type: string): boolean {
    switch (this.state) {
      case 'AUTHENTICATING':
        return type === 'rc/auth'
      case 'REGISTERING':
        return type === 'rc/register'
      case 'READY':
        return (
          type === 'rc/heartbeat' ||
          type === 'rc/verify' ||
          type === 'rc/github-comment-authz' ||
          type === 'rc/codehost-membership-authz' ||
          type === 'rc/github-rerequest' ||
          type === 'rc/run-report' ||
          type === 'rc/set-channel-agent' ||
          type === 'rc/bot-channels' ||
          type === 'rc/bot-conversation' ||
          type === 'rc/bot-revoked' ||
          type === 'rc/notice-posted' ||
          type === 'rc/thread-assign' ||
          type === 'rc/thread-participant' ||
          type === 'rc/thread-lookup' ||
          type === 'rc/github-installation'
        )
      default:
        return false
    }
  }

  private async handleAuth(frame: RelayCpFrame, auth: RcAuth): Promise<void> {
    const verdict = await this.deps.auth.authenticate(auth)
    if (!verdict.ok) {
      // Generic reason, then close 4401 (fatal to the relay — mirrors the daemon).
      this.sendError(frame.id, 'AUTH_FAILED', verdict.reason)
      this.close(4401, 'auth failed')
      return
    }
    this.state = 'REGISTERING'
    this.reply(frame, 'rc/auth/ok', {
      heartbeatSec: this.deps.auth.heartbeatSec,
      serverTime: new Date(this.deps.clock.now()).toISOString(),
      ...(this.deps.deploymentConfig ? { deploymentConfig: this.deps.deploymentConfig } : {})
    })
  }

  private async handleRegister(frame: RelayCpFrame, req: RcRegister): Promise<void> {
    const row = await this.deps.relays.upsertByName(
      req.name,
      req.daemonUrl,
      new Date(this.deps.clock.now()),
      req.features
    )
    // The socket may have closed during the upsert. onClose ran with relayId still ''
    // (so it skipped the registry remove) — proceeding to relayReg.add would register a
    // dead connection. Bail: the durable row is harmless (the sweeper ages it out).
    if (this.state === 'CLOSED') return
    this.relayId = row.id
    this.features = req.features
    // Supersede a stale connection for the same relayId (a restarted pod reclaims its
    // id by name), then register THIS socket so the CP can push rc/daemon-revoke to it.
    const prev = this.deps.relayReg.get(row.id)
    if (prev && prev !== this) prev.close(1012, 'superseded by a newer relay connection')
    this.deps.relayReg.add(this)
    this.state = 'READY'
    this.reply(frame, 'rc/registered', { relayId: row.id })
    // A relay just appeared (or reclaimed its id) — refresh the daemons' roster
    // and replay this relay's pool config (hook rules).
    this.deps.onRegistered(this)
  }

  private async handleRunReport(_frame: RelayCpFrame, report: RcRunReport): Promise<void> {
    try {
      await this.deps.onRunReport(report)
    } catch {
      // Fire-and-forget bookkeeping must not tear down the shared relay link.
    }
  }

  private async handleGithubInstallation(poke: RcGithubInstallation): Promise<void> {
    // Fire-and-forget EVT, same discipline as handleRunReport: a GitHub/store
    // blip must never tear down the shared relay↔CP link; a dropped poke
    // self-heals via the pull-based sync paths.
    try {
      await this.deps.onGithubInstallation(poke)
    } catch {
      // swallowed — cache-invalidation only, never worth the socket
    }
  }

  private async handleThreadAssign(m: RcThreadAssign): Promise<void> {
    // Fire-and-forget EVT, same discipline as handleRunReport: a store blip must
    // never tear down the shared relay↔CP link; a dropped binding self-heals via
    // the relay's own live affinity + a later rc/thread-lookup.
    try {
      await this.deps.onThreadAssign(m)
    } catch {
      // swallowed — affinity bookkeeping only, never worth the socket
    }
  }

  private async handleThreadParticipant(m: RcThreadParticipant): Promise<void> {
    try {
      await this.deps.onThreadParticipant(m)
    } catch {
      // participant bookkeeping is idempotent and self-heals on the next join
    }
  }

  /** `rc/bot-revoked` is the one rc/* REPORT that is acknowledged: Slack never
   *  redelivers the lifecycle event and no CP-side probe can find a dead token, so
   *  a handler failure must NOT look like success to the relay. Answer a retryable
   *  error (not a link close) and let it re-report. */
  private async handleBotRevoked(frame: RelayCpFrame, req: RcBotRevoked): Promise<void> {
    let result: { applied: boolean }
    try {
      result = await this.deps.onBotRevoked(req)
    } catch {
      this.sendError(frame.id, 'INTERNAL', 'bot revocation failed', true)
      return
    }
    this.reply(frame, 'rc/bot-revoked/ok', { botId: req.botId, applied: result.applied })
  }

  private async handleThreadLookup(frame: RelayCpFrame, req: RcThreadLookup): Promise<void> {
    // A transient store blip must NOT close the relay↔CP link: answer a retryable
    // error REP so the relay retries just this one lookup (mirrors handleVerify).
    let result: RcThreadLookupOk
    try {
      result = await this.deps.threadLookup(req)
    } catch {
      this.sendError(frame.id, 'INTERNAL', 'thread lookup failed', true)
      return
    }
    this.reply(frame, 'rc/thread-lookup/ok', result)
  }

  private async handleVerify(frame: RelayCpFrame, req: RcVerify): Promise<void> {
    // A transient store blip must NOT close the relay↔CP link (that would drop every
    // daemon/browser this relay serves): answer a retryable error REP so the relay
    // rejects just this one dial-in and its peer retries.
    let result: RcVerifyResult
    try {
      result =
        req.kind === 'daemon-key'
          ? await this.verifyDaemonCredential('daemon-key', req.credential)
          : req.kind === 'daemon-token'
            ? await this.verifyDaemonCredential('daemon-token', req.credential, req.daemonId)
            : req.conversationBinding === 'v1'
              ? await this.deps.verifyWebchatToken(req.credential)
              : { ok: false, reason: 'unsupported webchat binding' }
    } catch {
      this.sendError(frame.id, 'INTERNAL', 'verify failed', true)
      return
    }
    this.reply(frame, 'rc/verify/ok', result)
  }

  /** Both daemon credentials resolve to the same identity and answer the same coarse
   *  refusal — the relay learns which daemon dialed, never why one did not. */
  private async verifyDaemonCredential(
    kind: 'daemon-key' | 'daemon-token',
    credential: string,
    claimedDaemonId?: string
  ): Promise<RcVerifyResult> {
    const id =
      kind === 'daemon-key'
        ? await this.deps.auth.verifyDaemonKey(credential)
        : await this.deps.auth.verifyDaemonToken(credential, claimedDaemonId)
    return id ? { ok: true, daemonId: id.daemonId, orgId: id.orgId } : { ok: false, reason: 'invalid credential' }
  }

  private async handleGithubCommentAuthz(frame: RelayCpFrame, req: RcGithubCommentAuthz): Promise<void> {
    // Keep definitive denials distinct from transient failures. The relay fails
    // closed in both cases, but may surface/reconcile a retryable error later.
    let allowed: boolean
    try {
      allowed = await this.deps.authorizeGithubComment(req)
    } catch {
      this.sendError(frame.id, 'INTERNAL', 'GitHub comment authorization failed', true)
      return
    }
    this.reply(frame, 'rc/github-comment-authz/ok', { allowed })
  }

  private async handleCodeHostMembershipAuthz(frame: RelayCpFrame, req: RcCodeHostMembershipAuthz): Promise<void> {
    // Same discipline as the GitHub arm: definitive denials stay distinct from
    // transient failures; the relay fails closed on both.
    let allowed: boolean
    try {
      allowed = await this.deps.authorizeCodeHostMembership(req)
    } catch {
      this.sendError(frame.id, 'INTERNAL', 'code host membership authorization failed', true)
      return
    }
    this.reply(frame, 'rc/codehost-membership-authz/ok', { allowed })
  }

  private async handleGithubRerequest(frame: RelayCpFrame, req: RcGithubRerequest): Promise<void> {
    let result: RcGithubRerequestResult
    try {
      result = await this.deps.authorizeGithubRerequest(req)
    } catch {
      this.sendError(frame.id, 'INTERNAL', 'GitHub rerequest authorization failed', true)
      return
    }
    this.reply(frame, 'rc/github-rerequest/ok', result)
  }

  private async handleHeartbeat(): Promise<void> {
    if (!this.relayId) return
    let stillPresent: boolean
    try {
      stillPresent = await this.deps.relays.touchLastSeen(this.relayId, new Date(this.deps.clock.now()))
    } catch {
      // A transient store blip must NOT tear down the shared relay↔CP link — the outer
      // dispatch closes 1011 on a throw, which would drop every daemon/browser this relay
      // serves. Skip this one liveness bump; the next heartbeat retries (mirrors handleVerify).
      return
    }
    if (!stillPresent) {
      // The sweeper deleted this relay's row during a stall (the socket outlived the
      // stale window). A heartbeat can't resurrect a row — only rc/register can — so
      // force a reconnect: the relay treats 1012 as transient and re-runs the
      // rc/auth → rc/register handshake, minting a fresh row. Without this the relay
      // stays connected+READY yet permanently absent from the roster.
      this.close(1012, 'relay row swept — reconnect to re-register')
    }
  }

  private reply<T extends RelayCpFrameType>(
    req: RelayCpFrame,
    type: T,
    payload: z.input<(typeof RELAY_CP_SCHEMAS)[T]>
  ): void {
    this.transport.send(JSON.stringify(buildRelayCpFrame(type, payload, { corr: req.id })))
  }

  /** {@link RelayChannel} — fire-and-forget C→R EVT (no corr), e.g. `rc/daemon-revoke`. */
  send<T extends RelayCpFrameType>(type: T, payload: z.input<(typeof RELAY_CP_SCHEMAS)[T]>): void {
    this.transport.send(JSON.stringify(buildRelayCpFrame(type, payload)))
  }

  /**
   * {@link RelayChannel} — correlated C→R REQ, resolving with the relay's REP
   * payload. Deliberately SINGLE-SHOT: unlike the daemon correlator this never
   * retransmits, because every frame that rides it (today `rc/hook-rerun`) is an
   * effect a duplicate would perform twice. A silent relay therefore rejects on
   * the deadline rather than being re-asked.
   */
  request<T extends RelayCpFrameType>(
    type: T,
    payload: z.input<(typeof RELAY_CP_SCHEMAS)[T]>,
    timeoutMs = RELAY_REQUEST_TIMEOUT_MS
  ): Promise<unknown> {
    // A socket past READY swallows sends silently, so it would only ever time
    // out — refuse now, while the caller can still tell nothing was written.
    if (this.state !== 'READY') {
      return Promise.reject(new RelayNotWritten(`relay ${this.relayId || '(unregistered)'} is ${this.state}`))
    }
    const frame = buildRelayCpFrame(type, payload)
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.deps.clock.setTimeout(() => {
        this.pending.delete(frame.id)
        reject(new Error(`no relay reply for ${type} within ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(frame.id, {
        resolve: (value) => {
          this.deps.clock.clearTimeout(timer)
          resolve(value)
        },
        reject: (err) => {
          this.deps.clock.clearTimeout(timer)
          reject(err)
        }
      })
      try {
        this.transport.send(JSON.stringify(frame))
      } catch (e) {
        this.pending.get(frame.id)?.reject(new RelayNotWritten(`relay send failed: ${(e as Error).message}`))
        this.pending.delete(frame.id)
      }
    })
  }

  /** Settle a CP-issued REQ from an inbound correlated frame; true when it matched. */
  private settle(frame: RelayCpFrame): boolean {
    if (!frame.corr) return false
    const entry = this.pending.get(frame.corr)
    if (!entry) return false
    this.pending.delete(frame.corr)
    if (frame.type === 'error') entry.reject(new Error(`relay refused ${frame.corr}`))
    else entry.resolve(frame.payload)
    return true
  }

  private sendError(corr: string, code: ErrorCode, message: string, retryable = false): void {
    this.transport.send(JSON.stringify(buildRelayCpFrame('error', { code, message, retryable }, { corr })))
  }

  private decodeErrorCode(msg: string): ErrorCode {
    if (msg === 'FRAME_TOO_LARGE') return 'FRAME_TOO_LARGE'
    if (msg === 'UNKNOWN_FRAME') return 'UNKNOWN_FRAME'
    return 'BAD_PAYLOAD'
  }

  close(code: number, reason: string): void {
    this.state = 'CLOSED'
    this.transport.close(code, reason)
  }

  private onClose(): void {
    this.state = 'CLOSED'
    for (const entry of this.pending.values()) entry.reject(new Error('relay connection closed'))
    this.pending.clear()
    // Drop from the registry only if still ours (a late close from a superseded old
    // socket must not evict the live one). The durable `relay` row ages out of the
    // roster via the sweeper (bounded failover window, §13).
    if (this.relayId) {
      this.deps.relayReg.remove(this.relayId, this)
      this.deps.onRelayGone?.()
    }
  }
}
