/**
 * `CpClient` — the daemon-side CP WebSocket client FSM (protocol §2.1). Dials
 * out, runs the auth → register handshake, then (Tasks 5–7) emits heartbeats,
 * dispatches C→D control frames, and reconnects with backoff. Local-first:
 * `start()` is non-blocking and a CP failure never affects the daemon.
 */
import type {
  AnyFrame,
  RegisterReq,
  Heartbeat,
  FactsRuntimeProfile,
  FactsMcpServer,
  UsageReport,
  EventSession,
  SessionActivity,
  SessionPurged,
  IntegrationChannels,
  CronReport,
  HookReport,
  HookStart,
  HookStartOk,
  GithubReviewAuthorize,
  GithubReviewAuthorized,
  GithubReviewResultReport,
  GithubReviewResultOk,
  AgentLaunch,
  AgentStop,
  AgentUpsert,
  Drain,
  DrainProgress,
  DaemonRestart,
  DaemonUpgrade,
  SessionListReq,
  SessionHistoryReq,
  SessionToolBodyReq,
  WorkspaceListReq,
  WorkspaceReadReq,
  WorkspaceWriteReq,
  WorkspaceDeleteReq,
  WorkspaceGitStatusReq,
  WorkspaceGitPullReq,
  GitCredRequest,
  GitCredGrant,
  ChannelAgentsReq,
  ChannelAgentsOk,
  ChildSessionStatus,
  ChildSessionStatusReq,
  ChildSessionStatusProbe,
  MemoryListReq,
  MemoryReadReq,
  MemoryWriteReq,
  MemoryHistoryReq,
  MemorySurfaceReq,
  MemoryRecordSearchReq,
  MemoryRecordListReq,
  MemoryRecordGetReq,
  MemoryRecordCreateReq,
  MemoryRecordUpdateReq,
  MemoryRecordDeleteReq,
  MemoryRecordHistoryReq,
  MemoryConnectionFact,
  DreamStartReq,
  DreamCancelReq,
  DreamListReq,
  DreamGetReq,
  DreamAdoptReq,
  DreamDiscardReq,
  DreamFilesReq,
  DreamFileReadReq,
  DreamSkillReviewReq,
  DreamSkillReadReq,
  LocalSkillsReq,
  SessionVisibilityPush,
  WebchatMcpGrantIssue,
  WebchatMcpGrantIssued,
  WebchatMcpGrantAccept,
  WebchatMcpGrantActivate,
  WebchatMcpGrantRevoke,
  WebchatMcpGrantRevoked,
  KnowledgeSearchReq,
  KnowledgeSearchOk,
  KnowledgeListReq,
  KnowledgeListOk,
  OrgSkillsReq,
  OrgSkillsOk,
  OrganizationSuggestionsSyncReq,
  OrganizationSuggestionsSyncOk,
  ManagedSkillReadReq,
  ManagedSkillChunk,
  OrganizationSuggestionReadReq,
  OrganizationSuggestionReviewReq
} from '@agentconnect.md/protocol'
import {
  buildEnvelope,
  decodeEnvelope,
  encode,
  MAX_FRAME_BYTES,
  SESSION_LIVE_TAIL_FEATURE,
  SESSION_METADATA_ACK_FEATURE,
  SESSION_PURGE_FEATURE,
  ORGANIZATION_KNOWLEDGE_FEATURE
} from '@agentconnect.md/protocol'
import type { SessionReader } from './session-reader.js'
import { WorkspaceConflictError, WorkspaceViolationError, type WorkspaceReader } from './workspace-reader.js'
import {
  MemoryViolationError,
  MemoryPathError,
  MemoryTooLargeError,
  MemoryConflictError,
  type MemoryReader
} from './memory-reader.js'
import type { WorkspaceGit } from './workspace-git.js'
import type { DreamReader } from './dream-reader.js'
import type { LocalSkillsReader } from './local-skills-reader.js'
import { DreamViolationError, DreamStateError } from '../agents/dream-runner.js'
import { ReqRep, WireError, type Clock, type TimerHandle, type Transport } from '@agentconnect.md/connection'
import type { ConfigApply } from './config-apply.js'
import type { Logger } from '../log.js'

/** The daemon↔CP wire's subprotocol + mount path — re-exported from the shared
 *  protocol package (single source of truth) so the daemon's existing import
 *  sites (`./cp/client.js`) keep working unchanged. */
export { CP_SUBPROTOCOL, CP_WS_PATH } from '@agentconnect.md/protocol'

const ACK_TIMEOUT_MS = 5000
const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 30000
const REGISTERING_CONTROL_QUEUE_LIMIT = 1024
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length

export type CpState = 'CONNECTING' | 'AUTHENTICATING' | 'REGISTERING' | 'READY' | 'DRAINING' | 'CLOSED' | 'DEGRADED'

interface RegisterControlBarrier {
  transport: Transport
  registerRequestId: string
  /** Becomes true only after a valid register/ok correlated to this request. */
  snapshotApplying: boolean
  controls: Array<{ frame: AnyFrame; epoch?: number }>
}

export interface CpClientDeps {
  url: string
  token: string
  /** Optional: when unset, the token's `sub` is the authoritative daemonId and
   *  the CP assigns it. The adopted id is surfaced via `onDaemonId`. */
  daemonId?: string
  agentVersion: string
  host: string
  heartbeatDefaultMs: number
  maxAgents: number
  capabilities: () => RegisterReq['capabilities']
  /** Observed runtime profiles, emitted as one `facts/daemon-runtimes` snapshot after each register. */
  runtimeProfiles: () => FactsRuntimeProfile[]
  /** Daemon-configured MCP servers (name + transport), riding the same
   *  `facts/daemon-runtimes` frame (daemon-level, REPLACE semantics). Derived
   *  from config — not probed. Defaults to []. */
  mcpServerFacts?: () => FactsMcpServer[]
  localState: () => RegisterReq['localState']
  loadSnapshot: () => Heartbeat['load']
  activeSessions: () => number
  /** Unservable CP-rule agentIds, surfaced in heartbeat.degradedScopes. Defaults to []. */
  degradedScopes?: () => string[]
  configApply: ConfigApply
  /** Read-only session list/history seam over the local store (§1/§12). */
  sessionRead: SessionReader
  /** Answer a CP-forwarded child-session status probe for a child THIS daemon owns
   *  (session-concept §5.4). The daemon re-checks the lineage itself — the CP proves only that the
   *  asking daemon owns the claimed parent session, never that the child belongs to it. */
  childSessionStatusProbe?: (probe: ChildSessionStatusProbe) => ChildSessionStatus
  /** Live workspace file seam over the agents' workspace dirs (§1/§12). */
  workspaceRead: WorkspaceReader
  /** Git status/pull seam over the agents' git-repo workspace dirs (§1/§12). */
  workspaceGit: WorkspaceGit
  /** Read/write seam over the agents' memory dirs (`<agent-root>/memory/`, §1/§12). */
  memoryReader: MemoryReader
  /** Dream-job lifecycle + staged-output review seam (docs/designs/memory-dreaming.md §10). */
  dreamReader: DreamReader
  /** Read-only inventory of the skills an agent's workspace can load (skills/local). */
  localSkillsReader: LocalSkillsReader
  // webchat content no longer rides this control WS (milestone A4) — the daemon serves
  // webchat over the relay's rd/* wire (RelayClient / Daemon.handleRelayMsg) instead.
  clock: Clock
  /** Dial factory — production passes `() => ClientTransport.dial(url)`; tests inject a fake. */
  connect: () => Promise<Transport>
  log: Logger
  /** Backoff jitter in [0,1); defaults to Math.random. Injected as `() => 0` in tests. */
  jitter?: () => number
  /** Called with the authoritative daemonId from `auth/ok` (so the daemon can
   *  persist a CP-assigned id when none was configured). */
  onDaemonId?: (daemonId: string) => void
  /** Called with the Web App console origin from `auth/ok` (the CP's own console URL, or
   *  undefined when it has none). Used as the fallback base for session deep links. */
  onWebAppUrl?: (webAppUrl: string | undefined) => void
  /** Called with the daemon's org slug from `auth/ok` (or undefined when the CP couldn't
   *  resolve it). The console is org-scoped, so this becomes the `<orgSlug>` segment of a
   *  session deep link (`<webAppUrl>/<orgSlug>/sessions/<id>`). */
  onOrgSlug?: (orgSlug: string | undefined) => void
  /** Called once the daemon reaches READY on each (re)connect, after the initial
   *  runtime profiles are emitted. The daemon uses this to kick off background
   *  runtime probing and push the refreshed snapshot via `emitDaemonRuntimes`. */
  onReady?: () => void
}

export class CpClient {
  state: CpState = 'CLOSED'
  sessionEpoch = 0
  routingEpoch = 0

  private transport?: Transport
  private readonly correlator: ReqRep<AnyFrame>
  private stopped = false
  private fatal = false // 4401 — never auto-retry
  private serverFeatures = new Set<string>()
  private attempt = 0
  private reconnectTimer?: TimerHandle
  private lastAuthedEpoch = 0 // for resume on reconnect (per-agent seq tail is out of scope)
  private heartbeatTimer?: TimerHandle
  private heartbeatMs = 0
  private connectRun?: Promise<void>
  /** `stop()` must join snapshot convergence after a transport has connected,
   *  but it cannot wait forever for a connector whose dial is not cancellable.
   *  Keep the transport-bound handshake separate from the outer dial attempt. */
  private handshakeRun?: Promise<void>
  /** The CP may send controls immediately after register/ok, while the daemon is
   *  still converging that snapshot. Hold only those post-register controls and
   *  drain them FIFO before exposing READY; pre-register controls stay illegal. */
  private registerControlBarrier?: RegisterControlBarrier
  /** A reconnect timer can fire while the failed connection attempt is still
   *  unwinding. Preserve that admission instead of dropping it on the
   *  `connectRun` single-flight guard. */
  private connectPending = false
  // Per-connection monotonic ordinal for `facts/daemon-runtimes` snapshots
  // (reset at each register; the CP nulls its stored value then too).
  private runtimesSeq = 0
  // What this connection's CP currently believes our capabilities are (the
  // register value, refreshed by `capabilities/update`). Serialized for the
  // change check in updateCapabilities(); reset on each register.
  private lastSentCapabilities?: string

  constructor(private readonly deps: CpClientDeps) {
    this.correlator = new ReqRep<AnyFrame>(deps.clock, ACK_TIMEOUT_MS)
  }

  /** Non-blocking: kicks off the connect loop and returns. */
  start(): void {
    this.stopped = false
    this.fatal = false
    this.beginConnect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.connectPending = false
    if (this.reconnectTimer !== undefined) {
      this.deps.clock.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.stopHeartbeat()
    this.correlator.rejectAll(new Error('stopping'))
    this.registerControlBarrier = undefined
    this.transport?.close(1000, 'shutdown')
    while (this.handshakeRun) {
      const run = this.handshakeRun
      await run.catch(() => undefined)
      if (this.handshakeRun === run) this.handshakeRun = undefined
    }
    this.state = 'CLOSED'
  }

  private beginConnect(): void {
    if (this.stopped || this.fatal) return
    if (this.connectRun) {
      this.connectPending = true
      return
    }
    this.connectPending = false
    const run = this.attemptConnect()
    this.connectRun = run
    const clear = () => {
      if (this.connectRun !== run) return
      this.connectRun = undefined
      if (this.connectPending) {
        this.connectPending = false
        this.beginConnect()
      }
    }
    void run.then(clear, clear)
  }

  private async attemptConnect(): Promise<void> {
    if (this.stopped || this.fatal) return
    this.state = 'CONNECTING'
    let t: Transport | undefined
    try {
      const connected = await this.deps.connect()
      t = connected
      if (this.stopped || this.fatal) {
        // stop() (or a fatal close) raced the dial — drop the fresh socket unused.
        connected.close(1000, 'shutdown')
        return
      }
      this.transport = connected
      connected.onMessage((txt) => void this.onText(txt, connected))
      connected.onClose((c, r) => this.onClose(connected, c, r))
      const handshake = this.handshake(connected)
      this.handshakeRun = handshake
      try {
        await handshake
      } finally {
        if (this.handshakeRun === handshake) this.handshakeRun = undefined
      }
      this.attempt = 0 // connected — reset backoff
    } catch (err) {
      if (this.stopped) return
      this.deps.log.warn(`cp: connect/handshake failed: ${(err as Error).message}`)
      if (t && this.transport === t) {
        if (this.registerControlBarrier?.transport === t) this.registerControlBarrier = undefined
        t.close(1011, 'handshake failed')
        this.transport = undefined
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fatal) return
    if (this.reconnectTimer !== undefined) return // one in flight
    const jitter = this.deps.jitter ?? Math.random
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempt)
    // Exponential backoff with additive jitter in [0, base), clamped so no delay
    // ever exceeds the cap (jitter()=0 → exactly base).
    const delay = Math.min(BACKOFF_CAP_MS, base + Math.floor(jitter() * base))
    this.attempt += 1
    this.reconnectTimer = this.deps.clock.setTimeout(() => {
      this.reconnectTimer = undefined
      this.beginConnect()
    }, delay)
  }

  private async handshake(expectedTransport: Transport): Promise<void> {
    // ── auth ── (resume on reconnect carries only the last epoch the daemon held)
    this.state = 'AUTHENTICATING'
    const authPayload: Record<string, unknown> = {
      apiKey: this.deps.token,
      agentVersion: this.deps.agentVersion
    }
    // Send daemonId only if configured; otherwise the CP derives it from the
    // token's `sub` and returns it in auth/ok (token-only onboarding).
    if (this.deps.daemonId) {
      authPayload.daemonId = this.deps.daemonId
    }
    if (this.lastAuthedEpoch > 0) {
      authPayload.resume = { lastEpoch: this.lastAuthedEpoch }
    }
    const authOk = await this.request('auth', authPayload)
    const ok = authOk.payload as {
      daemonId: string
      sessionEpoch: number
      heartbeatSec: number
      webAppUrl?: string
      orgSlug?: string
    }
    this.sessionEpoch = ok.sessionEpoch
    this.lastAuthedEpoch = ok.sessionEpoch
    // Adopt the authoritative daemonId the CP assigned (no-op if we already had one).
    if (ok.daemonId && ok.daemonId !== this.deps.daemonId) {
      this.deps.daemonId = ok.daemonId
      this.deps.onDaemonId?.(ok.daemonId)
    }
    // Adopt the CP's Web App console origin (for session deep links). Local config wins,
    // so the daemon applies this only as a fallback (see sessionLink).
    this.deps.onWebAppUrl?.(ok.webAppUrl)
    // Adopt the org slug the daemon belongs to — the `<orgSlug>` path segment of a deep link.
    this.deps.onOrgSlug?.(ok.orgSlug)

    // ── register ──
    this.state = 'REGISTERING'
    const registerCapabilities = this.deps.capabilities()
    this.lastSentCapabilities = JSON.stringify(registerCapabilities)
    const register = buildEnvelope('register', {
      host: this.deps.host,
      capabilities: registerCapabilities,
      maxAgents: this.deps.maxAgents,
      localState: this.deps.localState()
    })
    const barrier: RegisterControlBarrier = {
      transport: expectedTransport,
      registerRequestId: register.id,
      snapshotApplying: false,
      controls: []
    }
    this.registerControlBarrier = barrier
    try {
      const regOk = await this.correlator.request(register, (encoded) => expectedTransport.send(encoded))
      if (regOk.type !== 'register/ok') throw new Error(`expected register/ok, got ${regOk.type}`)
      const snap = regOk.payload as Parameters<ConfigApply['applyReconcileSnapshot']>[0]
      this.serverFeatures = new Set((regOk.payload as { serverFeatures?: string[] }).serverFeatures ?? [])
      this.routingEpoch = snap.routingEpoch
      await this.deps.configApply.applyReconcileSnapshot(snap)
      if (this.stopped || this.transport !== expectedTransport || this.registerControlBarrier !== barrier) {
        throw new Error('control-plane handshake was superseded during snapshot convergence')
      }

      this.drainRegisterControls(barrier)
      if (this.stopped || this.transport !== expectedTransport || this.registerControlBarrier !== barrier) {
        throw new Error('control-plane handshake was superseded while draining post-register controls')
      }
      this.registerControlBarrier = undefined
    } finally {
      if (this.registerControlBarrier === barrier) this.registerControlBarrier = undefined
    }

    // A queued daemon/drain can move the client directly into DRAINING. All
    // other post-register controls leave it REGISTERING until this atomic edge.
    if (this.state === 'REGISTERING') this.state = 'READY'
    if (this.state !== 'READY' && this.state !== 'DRAINING') {
      throw new Error(`control-plane handshake left client in ${this.state}`)
    }
    // Reconcile runs (awaited) while REGISTERING and may change the daemon's
    // computed capability set (for example by installing the builtin preset
    // agent or admitting skills). updateCapabilities() deliberately cannot send
    // before READY, so recheck once after the state transition to avoid
    // dropping that mutation.
    this.updateCapabilities()
    this.heartbeatMs = ok.heartbeatSec > 0 ? ok.heartbeatSec * 1000 : this.deps.heartbeatDefaultMs
    this.armHeartbeat()
    this.deps.log.info(`cp: READY (epoch=${this.sessionEpoch}, routingEpoch=${this.routingEpoch})`)

    // Report the observed runtime snapshot (D→C `facts/daemon-runtimes`,
    // fire-and-forget) so the console can offer per-daemon runtime + model
    // choices right away (models may still be the cached/empty pre-probe set).
    // Replace semantics on the CP, so re-emitting on every (re)connect is fine
    // — and it prunes runtimes uninstalled while the daemon was offline.
    // The CP resets its stored snapshot seq on register, so the per-connection
    // counter restarts here.
    this.runtimesSeq = 0
    this.emitDaemonRuntimes(this.deps.runtimeProfiles(), this.deps.mcpServerFacts?.() ?? [])

    // Let the daemon kick off background runtime probing; the probed models
    // arrive later as another `facts/daemon-runtimes` snapshot that replaces
    // the one just sent.
    this.deps.onReady?.()
  }

  /**
   * Re-announce `RegisterReq.capabilities` when the daemon's computed set has
   * changed since this connection's register (D→C `capabilities/update` EVT,
   * fire-and-forget, full-replace on the CP). Register runs before the agent
   * roster is applied and before the runtime probe sweep, so features derived
   * from either appear only via this refresh on a fresh connection. Cheap when
   * nothing changed (serialized compare ⇒
   * no-op), so callers fire it after every agent reconcile / probe sweep. An
   * older CP answers `error{UNKNOWN_FRAME}`, which lands in dispatchControl's
   * default no-op — the feature then simply waits for the next register.
   * No-op unless READY/DRAINING.
   */
  updateCapabilities(): void {
    if (this.state !== 'READY' && this.state !== 'DRAINING') return
    const capabilities = this.deps.capabilities()
    const serialized = JSON.stringify(capabilities)
    if (serialized === this.lastSentCapabilities) return
    this.lastSentCapabilities = serialized
    this.transport?.send(encode(buildEnvelope('capabilities/update', { capabilities })))
  }

  /**
   * Push the full runtime snapshot (D→C `facts/daemon-runtimes` EVT,
   * fire-and-forget) — sent on each register and again when a probe sweep
   * completes. REPLACE semantics on the CP: it reconciles the daemon's stored
   * runtime list to exactly this snapshot, pruning runtimes that are no longer
   * installed. No-op unless READY/DRAINING.
   */
  emitDaemonRuntimes(runtimes: FactsRuntimeProfile[], mcpServers: FactsMcpServer[] = []): void {
    if (this.state !== 'READY' && this.state !== 'DRAINING') return
    // Monotonic per-connection ordinal: the CP dispatches inbound frames without
    // awaiting, so two snapshots' transactions can interleave — it drops any
    // snapshot whose seq is <= the last one it committed for this connection.
    this.transport?.send(
      encode(buildEnvelope('facts/daemon-runtimes', { runtimes, mcpServers, seq: ++this.runtimesSeq }))
    )
  }

  /** Push the full metadata-only external-memory probe snapshot. Large snapshots
   * are split across ordered frames so every frame stays within the wire cap.
   * Grant, config, endpoint, secret keys, and memory bodies never enter it. */
  emitMemoryConnectionFacts(connections: MemoryConnectionFact[]): void {
    if (this.state !== 'READY' && this.state !== 'DRAINING') return

    const send = (chunk: MemoryConnectionFact[]) => {
      this.transport?.send(encode(buildEnvelope('facts/memory-connections', { connections: chunk })))
    }
    if (connections.length === 0) {
      send([])
      return
    }

    // UUID and RFC3339 envelope fields have fixed encoded widths. Measuring an
    // empty frame once gives the exact per-frame overhead; each fact then adds
    // its JSON bytes plus one comma when it is not the first item.
    const emptyFrameBytes = utf8Bytes(encode(buildEnvelope('facts/memory-connections', { connections: [] })))
    let chunk: MemoryConnectionFact[] = []
    let chunkBytes = emptyFrameBytes
    for (const fact of connections) {
      const factBytes = utf8Bytes(JSON.stringify(fact))
      const nextBytes = chunkBytes + (chunk.length > 0 ? 1 : 0) + factBytes
      if (nextBytes > MAX_FRAME_BYTES && chunk.length > 0) {
        send(chunk)
        chunk = []
        chunkBytes = emptyFrameBytes
      }
      if (emptyFrameBytes + factBytes > MAX_FRAME_BYTES) {
        // The protocol schema bounds make this unreachable for a valid fact,
        // but do not let a malformed runtime value close the CP socket.
        this.deps.log.warn(`cp: memory connection fact too large (${fact.connectionId})`)
        continue
      }
      chunkBytes += (chunk.length > 0 ? 1 : 0) + factBytes
      chunk.push(fact)
    }
    if (chunk.length > 0) send(chunk)
  }

  /**
   * Report a session's cumulative token usage (D→C `usage/report` EVT,
   * fire-and-forget). No-op unless READY/DRAINING — usage is dashboard telemetry,
   * so a dropped report just means that turn's delta is absent from the CP's
   * historical aggregates until the next report (which re-sends the cumulative
   * snapshot, latest-wins). Never blocks the turn.
   */
  emitUsageReport(report: UsageReport): void {
    if (this.state !== 'READY' && this.state !== 'DRAINING') return
    this.transport?.send(encode(buildEnvelope('usage/report', report)))
  }

  /**
   * Report a session's converged milestone + sessionKey echo (D→C `event/session`
   * EVT, fire-and-forget, latest-wins per `sessionId`). This is what lets the CP
   * store session metadata so a deep-link detail page (…/sessions/:id) resolves
   * even when the daemon is offline. Metadata only — never the message stream
   * (that stays daemon-local, §1/§12). No-op unless READY/DRAINING; a dropped
   * `start` is re-covered by the next milestone (the CP upsert is latest-wins).
   */
  emitEventSession(event: EventSession): void {
    if (this.state !== 'READY' && this.state !== 'DRAINING') return
    this.transport?.send(encode(buildEnvelope('event/session', event)))
  }

  /**
   * Persist one durable latest-wins session metadata snapshot (D→C
   * `event/session-sync` REQ → `ack`). The daemon releases its local outbox row
   * only after this resolves, so a disconnect or CP transaction failure is
   * retried without blocking the turn that produced the snapshot.
   */
  async syncEventSession(event: EventSession): Promise<'acknowledged' | 'unsupported'> {
    this.requireReady('event/session-sync')
    if (!this.supportsServerFeature(SESSION_METADATA_ACK_FEATURE)) return 'unsupported'
    const rep = await this.request('event/session-sync', event)
    if (rep.type !== 'ack' || rep.payload.ok !== true) {
      throw new WireError('INTERNAL', `expected event/session-sync ack, got ${rep.type}`, false)
    }
    return 'acknowledged'
  }

  /**
   * Report retention-GC deletions (D→C `event/session-purged` REQ → `ack`, #485)
   * so the CP marks the surviving metadata rows content-purged.
   *
   * Correlated rather than fire-and-forget, unlike every other session report: the
   * local rows are already deleted, so a dropped frame could never be re-derived
   * — the daemon holds a durable receipt and releases it only on this ACK.
   * Returns `'unsupported'` when the CP does not advertise
   * {@link SESSION_PURGE_FEATURE}: an older CP rejects the unknown frame type
   * outright, so the receipts are kept for a post-upgrade reconnect instead.
   */
  async emitSessionPurged(purged: SessionPurged): Promise<'acknowledged' | 'unsupported'> {
    this.requireReady('event/session-purged')
    if (!this.supportsServerFeature(SESSION_PURGE_FEATURE)) return 'unsupported'
    const rep = await this.request('event/session-purged', purged)
    if (rep.type !== 'ack' || rep.payload.ok !== true) {
      throw new WireError('INTERNAL', `expected event/session-purged ack, got ${rep.type}`, false)
    }
    return 'acknowledged'
  }

  /** Signal a durable transcript mutation without putting message content on the control WS. */
  emitSessionActivity(activity: SessionActivity): void {
    if (this.state !== 'READY' && this.state !== 'DRAINING') return
    if (!this.supportsServerFeature(SESSION_LIVE_TAIL_FEATURE)) return
    this.transport?.send(encode(buildEnvelope('event/session-activity', activity)))
  }

  /**
   * Report an integration's channels (D→C `integration/channels` EVT,
   * fire-and-forget, latest-wins). Slack sends an authoritative membership
   * snapshot; non-enumerable platforms send observed rows with
   * `authoritative:false`. No-op unless READY/DRAINING — the daemon re-emits its
   * cached reports on each (re)connect (see onReady in daemon.ts).
   */
  emitIntegrationChannels(snapshot: IntegrationChannels): void {
    if (this.state !== 'READY' && this.state !== 'DRAINING') return
    this.transport?.send(encode(buildEnvelope('integration/channels', snapshot)))
  }

  /**
   * Report a CP-owned cron fire (D→C `cron/report` EVT, fire-and-forget) so the
   * console's `lastRunAt` converges. The local D11 stamp stays authoritative and
   * the CP upsert is latest-wins, so re-asserting stored stamps on each
   * (re)connect (see onReady in daemon.ts) makes a dropped report only a delay,
   * never a loss. No-op unless READY/DRAINING.
   */
  emitCronReport(report: CronReport): void {
    if (this.state !== 'READY' && this.state !== 'DRAINING') return
    this.transport?.send(encode(buildEnvelope('cron/report', report)))
  }

  /**
   * Durably converge a hook turn outcome (D→C `hook/report` REQ). The daemon
   * retains its metadata-only outbox row until the CP replies after persistence
   * and projection convergence, so a long CP outage delays GC instead of losing
   * a terminal result.
   */
  async emitHookReport(report: HookReport): Promise<void> {
    this.requireReady('hook/report')
    const rep = await this.request('hook/report', report)
    if (rep.type !== 'ack' || rep.payload.ok !== true) {
      throw new WireError('INTERNAL', `expected hook/report ack, got ${rep.type}`, false)
    }
  }

  /** Durable start barrier for an accepted GitHub hook turn. Formal review is
   * not exposed until this correlated request succeeds. */
  async startHook(payload: HookStart): Promise<HookStartOk> {
    this.requireReady('hook/start')
    const rep = await this.request('hook/start', payload)
    if (rep.type !== 'hook/start/ok') {
      throw new WireError('INTERNAL', `expected hook/start/ok, got ${rep.type}`, false)
    }
    return rep.payload as HookStartOk
  }

  /** One-attempt, action-time formal-review purpose token. */
  async authorizeGithubReview(payload: GithubReviewAuthorize): Promise<GithubReviewAuthorized> {
    this.requireReady('github/review-authorize')
    const rep = await this.request('github/review-authorize', payload)
    if (rep.type !== 'github/review-authorized') {
      throw new WireError('INTERNAL', `expected github/review-authorized, got ${rep.type}`, false)
    }
    return rep.payload as GithubReviewAuthorized
  }

  /** Immediate body-free outcome; HookReport repeats it for lost-reply recovery. */
  async reportGithubReviewResult(payload: GithubReviewResultReport): Promise<GithubReviewResultOk> {
    this.requireReady('github/review-result')
    const rep = await this.request('github/review-result', payload)
    if (rep.type !== 'github/review-result/ok') {
      throw new WireError('INTERNAL', `expected github/review-result/ok, got ${rep.type}`, false)
    }
    return rep.payload as GithubReviewResultOk
  }

  async issueWebchatMcpGrant(payload: WebchatMcpGrantIssue): Promise<WebchatMcpGrantIssued> {
    this.requireReady('webchat/mcp-grant/issue')
    const rep = await this.request('webchat/mcp-grant/issue', payload)
    if (rep.type !== 'webchat/mcp-grant/issued') {
      throw new WireError('INTERNAL', `expected webchat/mcp-grant/issued, got ${rep.type}`, false)
    }
    return rep.payload as WebchatMcpGrantIssued
  }

  async acceptWebchatMcpGrant(payload: WebchatMcpGrantAccept): Promise<WebchatMcpGrantActivate> {
    this.requireReady('webchat/mcp-grant/accept')
    const rep = await this.request('webchat/mcp-grant/accept', payload)
    if (rep.type !== 'webchat/mcp-grant/activate') {
      throw new WireError('INTERNAL', `expected webchat/mcp-grant/activate, got ${rep.type}`, false)
    }
    return rep.payload as WebchatMcpGrantActivate
  }

  async revokeWebchatMcpGrant(payload: WebchatMcpGrantRevoke): Promise<WebchatMcpGrantRevoked> {
    this.requireReady('webchat/mcp-grant/revoke')
    const rep = await this.request('webchat/mcp-grant/revoke', payload)
    if (rep.type !== 'webchat/mcp-grant/revoked') {
      throw new WireError('INTERNAL', `expected webchat/mcp-grant/revoked, got ${rep.type}`, false)
    }
    return rep.payload as WebchatMcpGrantRevoked
  }

  private requireReady(op: string): void {
    if ((this.state !== 'READY' && this.state !== 'DRAINING') || !this.transport) {
      throw new WireError('INTERNAL', `control plane unreachable for ${op} (client ${this.state})`, true)
    }
  }

  private request(type: string, payload: unknown): Promise<AnyFrame> {
    const frame = buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload)
    return this.correlator.request(frame, (e) => this.transport!.send(e))
  }

  /**
   * `gitcred/request` (D→C REQ) → grant payload. The FIRST post-handshake
   * daemon-issued REQ, so unlike the handshake `request()` it is state-GATED:
   * outside READY/DRAINING it fails immediately (the credential cache degrades
   * to its unexpired copy or errors) — never queued, never a bare
   * `transport!.send` on a dead socket. Single send + 10s budget: the default
   * 5s×5 retransmit would blow every git-side timeout, and CP-side mint
   * single-flight makes a later fresh request cheap anyway.
   */
  async requestGitCred(payload: GitCredRequest): Promise<GitCredGrant> {
    if ((this.state !== 'READY' && this.state !== 'DRAINING') || !this.transport) {
      throw new WireError('INTERNAL', `control plane unreachable (client ${this.state})`, true)
    }
    const frame = buildEnvelope('gitcred/request', payload)
    const rep = await this.correlator.request(frame, (e) => this.transport!.send(e), {
      maxTries: 1,
      ackTimeoutMs: 10_000
    })
    if (rep.type !== 'gitcred/grant') {
      throw new WireError('INTERNAL', `expected gitcred/grant, got ${rep.type}`, false)
    }
    return rep.payload as GitCredGrant
  }

  /** Additive CP feature negotiation for rolling daemon/CP upgrades. */
  supportsServerFeature(feature: string): boolean {
    return this.serverFeatures.has(feature)
  }

  /**
   * `channel/agents` (D→C REQ) → the caller's callable peers. The peer-discovery
   * half of agent collaboration: the daemon asks the CP (the only authority for
   * the full cross-daemon roster) which peers this agent may reach. State-GATED like
   * `requestGitCred` (outside READY/DRAINING it fails fast, never queues on a dead
   * socket). `requesterAgentId` is set by the caller from the trusted MCP session
   * context — the CP uses it for the bidirectional call-policy filter.
   *
   * `payload.channel` is optional (absent ⇒ the ORG-WIDE directory) and only a CP
   * advertising `agent-directory-org-scope-v1` understands that form, so the CALLER
   * negotiates it via {@link supportsServerFeature} — it owns the trusted current-channel
   * coordinate to substitute for an older CP (see the daemon's `channelAgents` dep).
   */
  async channelAgents(payload: ChannelAgentsReq): Promise<ChannelAgentsOk> {
    if ((this.state !== 'READY' && this.state !== 'DRAINING') || !this.transport) {
      throw new WireError('INTERNAL', `control plane unreachable (client ${this.state})`, true)
    }
    const frame = buildEnvelope('channel/agents', payload)
    const rep = await this.correlator.request(frame, (e) => this.transport!.send(e))
    if (rep.type !== 'channel/agents/ok') {
      throw new WireError('INTERNAL', `expected channel/agents/ok, got ${rep.type}`, false)
    }
    return rep.payload as ChannelAgentsOk
  }

  /**
   * `session/child-status` (D→C REQ) → the status of a child session that lives on ANOTHER daemon
   * (session-concept §5.4). Same shape and state gate as {@link channelAgents}: the daemon cannot
   * address another daemon directly, so it asks the CP — the placement authority — which forwards
   * the lineage pair to the owning daemon and returns its answer. Metadata only; the CP stores
   * nothing. `parentSessionId` is the asking session's own id, taken from the trusted session
   * store, and the CP verifies this daemon actually reported it.
   */
  async childSessionStatus(payload: ChildSessionStatusReq): Promise<ChildSessionStatus> {
    if ((this.state !== 'READY' && this.state !== 'DRAINING') || !this.transport) {
      throw new WireError('INTERNAL', `control plane unreachable (client ${this.state})`, true)
    }
    const frame = buildEnvelope('session/child-status', payload)
    const rep = await this.correlator.request(frame, (e) => this.transport!.send(e))
    if (rep.type !== 'session/child-status/ok') {
      throw new WireError('INTERNAL', `expected session/child-status/ok, got ${rep.type}`, false)
    }
    return rep.payload as ChildSessionStatus
  }

  async knowledgeSearch(payload: KnowledgeSearchReq): Promise<KnowledgeSearchOk> {
    this.requireReady('knowledge/search')
    if (!this.supportsServerFeature(ORGANIZATION_KNOWLEDGE_FEATURE)) {
      throw new WireError('INTERNAL', 'control plane does not support organization knowledge', false)
    }
    const rep = await this.request('knowledge/search', payload)
    if (rep.type !== 'knowledge/search/ok') {
      throw new WireError('INTERNAL', `expected knowledge/search/ok, got ${rep.type}`, false)
    }
    return rep.payload as KnowledgeSearchOk
  }

  async knowledgeList(payload: KnowledgeListReq): Promise<KnowledgeListOk> {
    this.requireReady('knowledge/list')
    if (!this.supportsServerFeature(ORGANIZATION_KNOWLEDGE_FEATURE)) {
      throw new WireError('INTERNAL', 'control plane does not support organization knowledge', false)
    }
    const rep = await this.request('knowledge/list', payload)
    if (rep.type !== 'knowledge/list/ok') {
      throw new WireError('INTERNAL', `expected knowledge/list/ok, got ${rep.type}`, false)
    }
    return rep.payload as KnowledgeListOk
  }

  async orgSkills(payload: OrgSkillsReq): Promise<OrgSkillsOk> {
    this.requireReady('skills/org')
    if (!this.supportsServerFeature(ORGANIZATION_KNOWLEDGE_FEATURE)) {
      throw new WireError('INTERNAL', 'control plane does not support organization skills', false)
    }
    const rep = await this.request('skills/org', payload)
    if (rep.type !== 'skills/org/ok') {
      throw new WireError('INTERNAL', `expected skills/org/ok, got ${rep.type}`, false)
    }
    return rep.payload as OrgSkillsOk
  }

  async syncOrganizationSuggestions(payload: OrganizationSuggestionsSyncReq): Promise<OrganizationSuggestionsSyncOk> {
    this.requireReady('knowledge/suggestions/sync')
    if (!this.supportsServerFeature(ORGANIZATION_KNOWLEDGE_FEATURE)) return { decisions: [] }
    const rep = await this.request('knowledge/suggestions/sync', payload)
    if (rep.type !== 'knowledge/suggestions/sync/ok') {
      throw new WireError('INTERNAL', `expected knowledge/suggestions/sync/ok, got ${rep.type}`, false)
    }
    return rep.payload as OrganizationSuggestionsSyncOk
  }

  async readManagedSkill(payload: ManagedSkillReadReq): Promise<ManagedSkillChunk> {
    this.requireReady('managed-skill/read')
    if (!this.supportsServerFeature(ORGANIZATION_KNOWLEDGE_FEATURE)) {
      throw new WireError('INTERNAL', 'control plane does not support managed skills', false)
    }
    const rep = await this.request('managed-skill/read', payload)
    if (rep.type !== 'managed-skill/chunk') {
      throw new WireError('INTERNAL', `expected managed-skill/chunk, got ${rep.type}`, false)
    }
    return rep.payload as ManagedSkillChunk
  }

  private async onText(text: string, source: Transport): Promise<void> {
    // A superseded socket must not settle the current connection's correlator or
    // enter its post-register FIFO.
    if (source !== this.transport) return
    const decoded = decodeEnvelope(text)
    if (!decoded.ok) {
      const code = this.decodeErrorCode(decoded.msg)
      this.sendError(decoded.id, code, decoded.msg, false)
      // The envelope may be a correlated REP whose payload alone is malformed.
      // Preserve that correlation and fail the local request immediately; otherwise
      // the original REQ stays pending for the full 5x timeout budget and reports the
      // misleading "no ack" seen in the rc.282 register/ok incident.
      if (decoded.corr) {
        this.correlator.reject(decoded.corr, new WireError(code, `invalid correlated reply: ${decoded.msg}`, false))
      }
      return
    }
    const frame = decoded.frame
    const barrier = this.registerControlBarrier
    if (
      barrier !== undefined &&
      frame.type === 'register/ok' &&
      frame.corr === barrier.registerRequestId &&
      barrier.transport === source
    ) {
      // Open the FIFO before settling the register request. A transport may
      // deliver register/ok and the first control in the same JS turn, before
      // the handshake continuation gets a chance to run.
      barrier.snapshotApplying = true
    }
    // A correlated REP/error settles a pending daemon-issued REQ.
    if (frame.corr && this.correlator.settle(frame)) return
    if (barrier?.transport === source && barrier.snapshotApplying) {
      if (barrier.controls.length >= REGISTERING_CONTROL_QUEUE_LIMIT) {
        this.sendError(frame.id, 'PROTOCOL_STATE', 'post-register control queue full', true)
        source.close(1011, 'post-register control queue full')
        return
      }
      barrier.controls.push({ frame, epoch: decoded.ext?.epoch })
      return
    }
    // §2.1 legal-state gate: control frames are only legal in READY/DRAINING.
    if (this.state !== 'READY' && this.state !== 'DRAINING') {
      this.sendError(frame.id, 'PROTOCOL_STATE', `${frame.type} illegal in ${this.state}`, false)
      return
    }
    this.dispatchFencedControl(frame, decoded.ext?.epoch)
  }

  /** Drain through a stable barrier so controls arriving during the drain join
   *  its tail instead of overtaking it on the newly READY connection. */
  private drainRegisterControls(barrier: RegisterControlBarrier): void {
    while (barrier.controls.length > 0) {
      const queued = barrier.controls.shift()!
      this.dispatchFencedControl(queued.frame, queued.epoch)
      if (this.registerControlBarrier !== barrier) return
    }
  }

  private dispatchFencedControl(frame: AnyFrame, epoch?: number): void {
    // Fencing (protocol §4.2): reject any control frame issued under a stale epoch.
    if (epoch !== undefined && epoch < this.sessionEpoch) {
      this.sendError(frame.id, 'STALE_EPOCH', 'epoch < current', true)
      return
    }
    this.dispatchControl(frame)
  }

  private decodeErrorCode(msg: string): 'UNKNOWN_FRAME' | 'FRAME_TOO_LARGE' | 'BAD_PAYLOAD' {
    if (msg === 'FRAME_TOO_LARGE') return 'FRAME_TOO_LARGE'
    if (msg === 'UNKNOWN_FRAME') return 'UNKNOWN_FRAME'
    return 'BAD_PAYLOAD'
  }

  private sendError(corr: string, code: string, message: string, retryable: boolean): void {
    if (!this.transport) return
    this.transport.send(encode(buildEnvelope('error', { code, message, retryable }, { corr })))
  }

  private onClose(source: Transport, code: number, _reason: string): void {
    if (source !== this.transport) return
    this.stopHeartbeat()
    // Drop the dead transport: `ws.send` on a CLOSED socket is silently
    // swallowed, so anything still holding it would hang for a full retransmit
    // budget instead of failing fast.
    this.transport = undefined
    if (this.registerControlBarrier?.transport === source) this.registerControlBarrier = undefined
    this.correlator.rejectAll(new WireError('INTERNAL', 'connection closed', true))
    if (code === 4401) {
      this.fatal = true
      this.state = 'CLOSED'
      this.deps.log.error('cp: AUTH_FAILED (4401) — not reconnecting; re-mint the daemon token')
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
      // Skip the send mid-drain (we report `degraded` differently), but keep the
      // loop alive so heartbeats resume once we transition DRAINING → READY.
      if (this.state === 'READY') {
        this.transport?.send(
          encode(
            buildEnvelope('heartbeat', {
              load: this.deps.loadSnapshot(),
              health: 'ok',
              activeSessions: this.deps.activeSessions(),
              degradedScopes: this.deps.degradedScopes?.() ?? []
            })
          )
        )
      }
      if (this.state === 'READY' || this.state === 'DRAINING') this.armHeartbeat()
    }, this.heartbeatMs)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      this.deps.clock.clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  /** C→D control dispatch. The CP changes config, never live routing. */
  private dispatchControl(frame: AnyFrame): void {
    switch (frame.type) {
      case 'config/push':
        this.deps.configApply.applyConfigPush((frame.payload as { keys: Record<string, unknown> }).keys)
        return // EVT — no reply
      case 'cron/upsert':
        try {
          this.deps.configApply.upsertCron(frame.payload as Parameters<ConfigApply['upsertCron']>[0])
          this.reply(frame, 'ack', { ok: true })
        } catch (err) {
          this.sendError(frame.id, 'BAD_PAYLOAD', `cron upsert failed: ${(err as Error).message}`, false)
        }
        return
      case 'cron/remove':
        this.deps.configApply.removeCron((frame.payload as { cronId: string }).cronId)
        this.reply(frame, 'ack', { ok: true })
        return
      case 'cron/run':
        this.reply(frame, 'ack', this.deps.configApply.runCron((frame.payload as { cronId: string }).cronId))
        return
      case 'session/visibility': {
        // session-visibility.md §5.1. ALWAYS reply: a stale revision is answered
        // `superseded`, never an error frame — an error would reject the CP's
        // promise and drive its retransmit budget to exhaustion.
        const p = frame.payload as SessionVisibilityPush
        const status = this.deps.configApply.applySessionVisibility(p)
        this.reply(frame, 'session/visibility/ok', {
          sessionId: p.sessionId,
          visibilityRev: p.visibilityRev,
          status
        })
        return
      }
      case 'session/visibility/snapshot': {
        // Register-time convergence: the full gate set, applied entry by entry
        // under the same revision rule. One ack for the whole chunk.
        const { entries } = frame.payload as { entries: SessionVisibilityPush[] }
        for (const entry of entries) this.deps.configApply.applySessionVisibility(entry)
        this.reply(frame, 'ack', { ok: true })
        return
      }
      case 'route/assign': {
        const a = frame.payload as Parameters<ConfigApply['applyRouteAssign']>[0]
        this.deps.configApply.applyRouteAssign(a)
        this.reply(frame, 'route/assign/ack', { ok: true, sessionKey: a.sessionKey })
        return
      }
      case 'route/update':
        this.deps.configApply.applyRouteUpdate(frame.payload as Parameters<ConfigApply['applyRouteUpdate']>[0])
        return // EVT — no reply
      case 'relay/roster':
        // Hot roster update (shared-bot-relay.md §5) — converge the relay dial-out set.
        // The reconnect register/ok.relays snapshot is the backstop.
        this.deps.configApply.applyRelayRoster(
          (frame.payload as { relays: Parameters<ConfigApply['applyRelayRoster']>[0] }).relays
        )
        return // EVT — no reply
      case 'collaboration/routes':
        // Hot collaboration routing snapshot (agent-collaboration §2.3/§6.5) —
        // FULL-REPLACE the daemon's terminal-verify table for remote agent callers.
        // The reconnect register/ok.collabRoutes baseline is the backstop.
        this.deps.configApply.applyCollabRoutes(frame.payload as Parameters<ConfigApply['applyCollabRoutes']>[0])
        return // EVT — no reply
      case 'agent/upsert': {
        this.deps.configApply
          .applyAgentUpsert(frame.payload as AgentUpsert)
          .then((ack) => this.reply(frame, 'ack', ack))
          .catch((err) => {
            this.deps.log.warn(`cp: agent/upsert failed: ${(err as Error)?.message}`)
            this.reply(frame, 'ack', { ok: false, reason: 'agent/upsert failed' })
          })
        return
      }
      case 'agent/remove': {
        try {
          const run = this.deps.configApply.applyAgentRemove((frame.payload as { agentId: string }).agentId)
          void Promise.resolve(run).catch((err) =>
            this.deps.log.error(`cp: agent/remove failed closed: ${(err as Error).message}`)
          )
        } catch (err) {
          this.deps.log.error(`cp: agent/remove failed closed: ${(err as Error).message}`)
        }
        return // EVT — no reply
      }
      case 'agent/detach':
        this.deps.configApply
          .applyAgentDetach(frame.payload as Parameters<ConfigApply['applyAgentDetach']>[0])
          .then((ack) => this.reply(frame, 'ack', ack))
          .catch((err) => this.sendError(frame.id, 'INTERNAL', `agent/detach failed: ${(err as Error).message}`, false))
        return
      case 'agent/activate':
        // Token-bearing authoritative bundle — NEVER log the frame body.
        this.deps.configApply
          .applyAgentActivate(frame.payload as Parameters<ConfigApply['applyAgentActivate']>[0])
          .then((ack) => this.reply(frame, 'ack', ack))
          .catch((err) =>
            this.sendError(frame.id, 'INTERNAL', `agent/activate failed: ${(err as Error).message}`, false)
          )
        return
      case 'agent/permission-requests':
        try {
          this.reply(
            frame,
            'agent/permission-requests/page',
            this.deps.configApply.listAgentPermissionRequests(
              frame.payload as Parameters<ConfigApply['listAgentPermissionRequests']>[0]
            )
          )
        } catch (err) {
          this.sendError(frame.id, 'INTERNAL', `permission request list failed: ${(err as Error).message}`, false)
        }
        return
      case 'agent/permission-decision':
        try {
          this.reply(
            frame,
            'ack',
            this.deps.configApply.decideAgentPermission(
              frame.payload as Parameters<ConfigApply['decideAgentPermission']>[0]
            )
          )
        } catch (err) {
          this.sendError(frame.id, 'INTERNAL', `permission decision failed: ${(err as Error).message}`, false)
        }
        return
      case 'integration/upsert':
        // Token-bearing payload — NEVER log the frame body.
        this.deps.configApply.applyIntegrationUpsert(
          frame.payload as Parameters<ConfigApply['applyIntegrationUpsert']>[0]
        )
        return // EVT — no reply (reconnect roster is the backstop)
      case 'integration/remove':
        this.deps.configApply.applyIntegrationRemove((frame.payload as { integrationId: string }).integrationId)
        return // EVT — no reply
      case 'integration/forget':
        // REQ → ack: an undelivered suppression means the conversation comes back, so
        // the CP must be able to tell the operator instead of reporting success.
        try {
          this.deps.configApply.applyIntegrationForget(
            frame.payload as Parameters<ConfigApply['applyIntegrationForget']>[0]
          )
          this.reply(frame, 'ack', { ok: true })
        } catch (err) {
          this.reply(frame, 'ack', { ok: false, reason: (err as Error).message })
        }
        return
      case 'integration/leave': {
        // REQ → reply: this one changes the OUTSIDE world, so the operator is told
        // what the platform said rather than what we hoped. A refusal is a normal
        // reply (`ok:false`), not a protocol error — a missing scope or a
        // `last_member` channel is the operator's problem to see, not a daemon fault.
        const leave = frame.payload as Parameters<ConfigApply['applyIntegrationLeave']>[0]
        this.deps.configApply
          .applyIntegrationLeave(leave)
          .then((result) => this.reply(frame, 'integration/leave/ok', result))
          .catch((err) => this.reply(frame, 'integration/leave/ok', { ok: false, error: (err as Error).message }))
        return
      }
      case 'mcpserver/upsert':
        // Grant-key-bearing payload — NEVER log the frame body.
        this.deps.configApply.applyMcpServerUpsert(frame.payload as Parameters<ConfigApply['applyMcpServerUpsert']>[0])
        return // EVT — no reply (reconnect roster is the backstop)
      case 'mcpserver/remove':
        this.deps.configApply.applyMcpServerRemove((frame.payload as { name: string }).name)
        return // EVT — no reply
      case 'memoryconnection/upsert':
        // Grant/secret-bearing daemon-private payload — NEVER log the frame body.
        this.deps.configApply
          .applyMemoryConnectionUpsert(frame.payload as Parameters<ConfigApply['applyMemoryConnectionUpsert']>[0])
          .then((ack) => this.reply(frame, 'ack', ack))
          .catch(() => this.reply(frame, 'ack', { ok: false, reason: 'memory connection probe failed' }))
        return // REQ → probe ACK; reconnect snapshot remains the backstop
      case 'memoryconnection/remove':
        this.deps.configApply.applyMemoryConnectionRemove((frame.payload as { connectionId: string }).connectionId)
        return // EVT
      case 'agent/launch': {
        const launch = frame.payload as AgentLaunch
        this.deps.configApply
          .applyAgentLaunch(launch)
          .then((launched) => this.reply(frame, 'agent/launched', launched))
          .catch((err) => this.sendError(frame.id, 'INTERNAL', `agent/launch failed: ${(err as Error).message}`, false))
        return
      }
      case 'agent/stop': {
        const stop = frame.payload as AgentStop
        this.deps.configApply
          .applyAgentStop(stop)
          .then((ack) => this.reply(frame, 'ack', ack))
          .catch((err) => this.sendError(frame.id, 'INTERNAL', `agent/stop failed: ${(err as Error).message}`, false))
        return
      }
      case 'daemon/drain': {
        const drain = frame.payload as Drain
        // §2.1: enter DRAINING so the legal-state gate still admits control frames
        // while we drain. Return to READY once drain/done is sent (a bare drain is a
        // rebalance — the daemon stays connected).
        this.state = 'DRAINING'
        this.deps.configApply
          .applyDaemonDrain(drain, (p: DrainProgress) => this.emit('drain/progress', p))
          .then((done) => {
            this.reply(frame, 'drain/done', done)
            if (this.state === 'DRAINING') this.state = 'READY'
          })
          .catch((err) => {
            this.sendError(frame.id, 'INTERNAL', `drain failed: ${(err as Error).message}`, false)
            if (this.state === 'DRAINING') this.state = 'READY'
          })
        return
      }
      case 'daemon/restart':
        this.reply(
          frame,
          'daemon/control/ack',
          this.deps.configApply.applyDaemonRestart(frame.payload as DaemonRestart)
        )
        return
      case 'daemon/upgrade':
        this.reply(
          frame,
          'daemon/control/ack',
          this.deps.configApply.applyDaemonUpgrade(frame.payload as DaemonUpgrade)
        )
        return
      case 'session/list': {
        // Read-only — legal in READY/DRAINING (no epoch mutation). Body-locality §12.
        try {
          this.reply(frame, 'session/list/page', this.deps.sessionRead.list(frame.payload as SessionListReq))
        } catch (err) {
          this.sendError(frame.id, 'INTERNAL', `session/list failed: ${(err as Error).message}`, false)
        }
        return
      }
      case 'session/history': {
        try {
          const req = frame.payload as SessionHistoryReq
          if (!req.agentId)
            this.deps.log.warn('cp: legacy session/history request omitted agentId; owner binding is unavailable')
          this.reply(frame, 'session/history/page', this.deps.sessionRead.history(req))
        } catch (err) {
          this.sendError(frame.id, 'INTERNAL', `session/history failed: ${(err as Error).message}`, false)
        }
        return
      }
      case 'session/child-status/probe': {
        try {
          const probe = frame.payload as ChildSessionStatusProbe
          // No handler wired (older/embedded daemon) ⇒ answer `found:false`, which the asking side
          // renders as "not your child" rather than a hard failure.
          const answer = this.deps.childSessionStatusProbe?.(probe) ?? { found: false }
          this.reply(frame, 'session/child-status/probe/ok', answer)
        } catch (err) {
          this.sendError(frame.id, 'INTERNAL', `session/child-status/probe failed: ${(err as Error).message}`, false)
        }
        return
      }
      case 'session/tool-body': {
        try {
          const req = frame.payload as SessionToolBodyReq
          if (!req.agentId)
            this.deps.log.warn('cp: legacy session/tool-body request omitted agentId; owner binding is unavailable')
          this.reply(frame, 'session/tool-body/chunk', this.deps.sessionRead.toolBody(req))
        } catch (err) {
          this.sendError(frame.id, 'INTERNAL', `session/tool-body failed: ${(err as Error).message}`, false)
        }
        return
      }
      case 'workspace/list': {
        // Read-only live pull — bytes stay daemon-local; never log payload/reply bodies.
        this.deps.workspaceRead
          .list(frame.payload as WorkspaceListReq)
          .then((page) => this.reply(frame, 'workspace/list/page', page))
          .catch((err) => this.workspaceError(frame.id, 'workspace/list', err))
        return
      }
      case 'workspace/read': {
        this.deps.workspaceRead
          .read(frame.payload as WorkspaceReadReq)
          .then((content) => this.reply(frame, 'workspace/read/content', content))
          .catch((err) => this.workspaceError(frame.id, 'workspace/read', err))
        return
      }
      case 'workspace/write': {
        // Console manager edit: bounded scratch text create/replace; never log content.
        this.deps.workspaceRead
          .write(frame.payload as WorkspaceWriteReq)
          .then((ok) => this.reply(frame, 'workspace/write/ok', ok))
          .catch((err) => this.workspaceError(frame.id, 'workspace/write', err))
        return
      }
      case 'workspace/delete': {
        // Console manager delete: scratch-only and mtime-fenced like replacement.
        this.deps.workspaceRead
          .delete(frame.payload as WorkspaceDeleteReq)
          .then((ok) => this.reply(frame, 'workspace/delete/ok', ok))
          .catch((err) => this.workspaceError(frame.id, 'workspace/delete', err))
        return
      }
      case 'workspace/gitstatus': {
        // git status of a git-repo workspace — a dirty tree / non-repo is DATA, not an error.
        const req = frame.payload as WorkspaceGitStatusReq
        this.deps.workspaceGit
          .status(req.agentId, req.sessionId)
          .then((status) => this.reply(frame, 'workspace/gitstatus/result', status))
          .catch((err) => this.workspaceError(frame.id, 'workspace/gitstatus', err))
        return
      }
      case 'workspace/gitpull': {
        // On-demand ff-only pull — a failed pull comes back as a result (ok:false), not an error.
        this.deps.workspaceGit
          .pull((frame.payload as WorkspaceGitPullReq).agentId)
          .then((result) => this.reply(frame, 'workspace/gitpull/result', result))
          .catch((err) => this.workspaceError(frame.id, 'workspace/gitpull', err))
        return
      }
      case 'memory/list': {
        this.deps.memoryReader
          .list(frame.payload as MemoryListReq)
          .then((page) => this.reply(frame, 'memory/list/page', page))
          .catch((err) => this.memoryError(frame.id, 'memory/list', err))
        return
      }
      case 'memory/read': {
        // Read-only live pull of an agent memory file — bytes stay daemon-local.
        this.deps.memoryReader
          .read(frame.payload as MemoryReadReq)
          .then((content) => this.reply(frame, 'memory/read/content', content))
          .catch((err) => this.memoryError(frame.id, 'memory/read', err))
        return
      }
      case 'memory/write': {
        // Console edit: replace the whole memory file, reply with the new size/mtime.
        this.deps.memoryReader
          .write(frame.payload as MemoryWriteReq)
          .then((ok) => this.reply(frame, 'memory/write/ok', ok))
          .catch((err) => this.memoryError(frame.id, 'memory/write', err))
        return
      }
      case 'memory/history': {
        // Managed provenance is paged separately so `.history` stays hidden from
        // ordinary file listing/reads and only bounded rows cross the wire.
        this.deps.memoryReader
          .history(frame.payload as MemoryHistoryReq)
          .then((page) => this.reply(frame, 'memory/history/page', page))
          .catch((err) => this.memoryError(frame.id, 'memory/history', err))
        return
      }
      case 'memory/surface': {
        this.deps.memoryReader
          .surface(frame.payload as MemorySurfaceReq)
          .then((info) => this.reply(frame, 'memory/surface/info', info))
          .catch((err) => this.memoryError(frame.id, 'memory/surface', err))
        return
      }
      case 'memory/record/search': {
        this.deps.memoryReader
          .search(frame.payload as MemoryRecordSearchReq)
          .then((page) => this.reply(frame, 'memory/record/search/page', page))
          .catch((err) => this.memoryError(frame.id, 'memory/record/search', err))
        return
      }
      case 'memory/record/list': {
        this.deps.memoryReader
          .recordList(frame.payload as MemoryRecordListReq)
          .then((page) => this.reply(frame, 'memory/record/list/page', page))
          .catch((err) => this.memoryError(frame.id, 'memory/record/list', err))
        return
      }
      case 'memory/record/get': {
        this.deps.memoryReader
          .recordGet(frame.payload as MemoryRecordGetReq)
          .then((result) => this.reply(frame, 'memory/record/get/result', result))
          .catch((err) => this.memoryError(frame.id, 'memory/record/get', err))
        return
      }
      case 'memory/record/create': {
        this.deps.memoryReader
          .recordCreate(frame.payload as MemoryRecordCreateReq)
          .then((result) => this.reply(frame, 'memory/record/create/result', result))
          .catch((err) => this.memoryError(frame.id, 'memory/record/create', err))
        return
      }
      case 'memory/record/update': {
        this.deps.memoryReader
          .recordUpdate(frame.payload as MemoryRecordUpdateReq)
          .then((result) => this.reply(frame, 'memory/record/update/result', result))
          .catch((err) => this.memoryError(frame.id, 'memory/record/update', err))
        return
      }
      case 'memory/record/delete': {
        this.deps.memoryReader
          .recordDelete(frame.payload as MemoryRecordDeleteReq)
          .then((result) => this.reply(frame, 'memory/record/delete/result', result))
          .catch((err) => this.memoryError(frame.id, 'memory/record/delete', err))
        return
      }
      case 'memory/record/history': {
        this.deps.memoryReader
          .recordHistory(frame.payload as MemoryRecordHistoryReq)
          .then((page) => this.reply(frame, 'memory/record/history/page', page))
          .catch((err) => this.memoryError(frame.id, 'memory/record/history', err))
        return
      }
      // ── memory dreaming — job metadata + staged-body review (bodies stay daemon-local) ──
      case 'memory/dream/start': {
        this.deps.dreamReader
          .start(frame.payload as DreamStartReq)
          .then((state) => this.reply(frame, 'memory/dream/start/ok', state))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/start', err))
        return
      }
      case 'memory/dream/cancel': {
        this.deps.dreamReader
          .cancel(frame.payload as DreamCancelReq)
          .then((state) => this.reply(frame, 'memory/dream/cancel/ok', state))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/cancel', err))
        return
      }
      case 'memory/dream/list': {
        this.deps.dreamReader
          .list(frame.payload as DreamListReq)
          .then((page) => this.reply(frame, 'memory/dream/list/page', page))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/list', err))
        return
      }
      case 'memory/dream/get': {
        this.deps.dreamReader
          .get(frame.payload as DreamGetReq)
          .then((state) => this.reply(frame, 'memory/dream/get/result', state))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/get', err))
        return
      }
      case 'memory/dream/adopt': {
        this.deps.dreamReader
          .adopt(frame.payload as DreamAdoptReq)
          .then((state) => this.reply(frame, 'memory/dream/adopt/ok', state))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/adopt', err))
        return
      }
      case 'memory/dream/discard': {
        this.deps.dreamReader
          .discard(frame.payload as DreamDiscardReq)
          .then((state) => this.reply(frame, 'memory/dream/discard/ok', state))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/discard', err))
        return
      }
      case 'memory/dream/files': {
        this.deps.dreamReader
          .files(frame.payload as DreamFilesReq)
          .then((page) => this.reply(frame, 'memory/dream/files/page', page))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/files', err))
        return
      }
      case 'memory/dream/file/read': {
        this.deps.dreamReader
          .fileRead(frame.payload as DreamFileReadReq)
          .then((content) => this.reply(frame, 'memory/dream/file/read/content', content))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/file/read', err))
        return
      }
      case 'memory/dream/skill/read': {
        const req = frame.payload as DreamSkillReadReq
        this.deps.dreamReader
          .skillRead(req)
          .then((content) => this.reply(frame, 'memory/dream/skill/read/ok', content))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/skill/read', err))
        return
      }
      case 'memory/dream/skill/accept': {
        this.deps.dreamReader
          .skillAccept(frame.payload as DreamSkillReviewReq)
          .then((state) => this.reply(frame, 'memory/dream/skill/accept/ok', state))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/skill/accept', err))
        return
      }
      case 'memory/dream/skill/dismiss': {
        this.deps.dreamReader
          .skillDismiss(frame.payload as DreamSkillReviewReq)
          .then((state) => this.reply(frame, 'memory/dream/skill/dismiss/ok', state))
          .catch((err) => this.dreamError(frame.id, 'memory/dream/skill/dismiss', err))
        return
      }
      case 'skills/local': {
        this.deps.localSkillsReader
          .list(frame.payload as LocalSkillsReq)
          .then((list) => this.reply(frame, 'skills/local/list', list))
          .catch((err) => {
            this.deps.log.warn(`cp: skills/local failed: ${(err as Error)?.message}`)
            this.sendError(frame.id, 'INTERNAL', 'skills/local failed', false)
          })
        return
      }
      case 'knowledge/suggestion/read': {
        this.deps.dreamReader
          .organizationSuggestionRead(frame.payload as OrganizationSuggestionReadReq)
          .then((content) => this.reply(frame, 'knowledge/suggestion/content', content))
          .catch((err) => this.dreamError(frame.id, 'knowledge/suggestion/read', err))
        return
      }
      case 'knowledge/suggestion/review': {
        this.deps.dreamReader
          .organizationSuggestionReview(frame.payload as OrganizationSuggestionReviewReq)
          .then((ack) => this.reply(frame, 'ack', ack))
          .catch((err) => this.dreamError(frame.id, 'knowledge/suggestion/review', err))
        return
      }
      // webchat content moved off this control WS (milestone A4) — it rides the relay's
      // rd/* wire now. Any stray legacy webchat/* frame falls through to the no-op default.
      default:
        this.deps.log.debug(`cp: ignoring ${frame.type}`)
        return
    }
  }

  /** Map a workspace file failure onto the wire: stale writes → CONFLICT;
   *  containment/bad-request
   *  violations → BAD_PAYLOAD (their messages are hand-written and path-free);
   *  anything else → INTERNAL with a GENERIC message — raw fs errors (ELOOP,
   *  EACCES, …) embed absolute host paths that must not leak to the CP/UI. */
  private workspaceError(corr: string, op: string, err: unknown): void {
    if (err instanceof WorkspaceConflictError) {
      this.sendError(corr, 'CONFLICT', `${op} failed: ${err.message}`, false)
      return
    }
    if (err instanceof WorkspaceViolationError) {
      this.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false)
      return
    }
    this.deps.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
    this.sendError(corr, 'INTERNAL', `${op} failed`, false)
  }

  /** Unknown agent/dream/path → BAD_PAYLOAD; a legal request against the wrong
   *  lifecycle state → CONFLICT; anything else → INTERNAL with a generic message
   *  (raw fs errors embed absolute host paths that must not leak to the CP/UI). */
  private dreamError(corr: string, op: string, err: unknown): void {
    if (err instanceof DreamViolationError) {
      this.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false)
      return
    }
    if (err instanceof DreamStateError) {
      this.sendError(corr, 'CONFLICT', `${op} failed: ${err.message}`, false)
      return
    }
    this.deps.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
    this.sendError(corr, 'INTERNAL', `${op} failed`, false)
  }

  private memoryError(corr: string, op: string, err: unknown): void {
    if (err instanceof MemoryConflictError) {
      this.sendError(corr, 'CONFLICT', `${op} failed: ${err.message}`, false)
      return
    }
    if (err instanceof MemoryViolationError || err instanceof MemoryPathError || err instanceof MemoryTooLargeError) {
      this.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false)
      return
    }
    this.deps.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
    this.sendError(corr, 'INTERNAL', `${op} failed`, false)
  }

  private reply(req: AnyFrame, type: string, payload: unknown): void {
    this.transport?.send(encode(buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload, { corr: req.id })))
  }

  /** Emit an uncorrelated EVT (e.g. `drain/progress`). */
  private emit(type: string, payload: unknown): void {
    this.transport?.send(encode(buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload)))
  }
}
