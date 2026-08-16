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
  HeartbeatDuties,
  DutyGrant,
  DutyRenewed,
  DutyRevoke,
  DutyClaimOk,
  DutyFetchOk,
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
  WorkspaceGitDiffReq,
  WorkspaceGitLogReq,
  WorkspaceGitPullReq,
  WorkspaceGitStageReq,
  WorkspaceGitCommitReq,
  WorkspaceGitPushReq,
  WorkspaceGitMessageReq,
  TaskListReq,
  AgentWakeReq,
  WorkspaceGitMessageResult,
  GitCredRequest,
  GitCredGrant,
  ChannelAgentsReq,
  ChannelAgentsOk,
  ChildSessionStatus,
  ChildSessionStatusReq,
  ChildSessionStatusProbe,
  MemoryChannelsReq,
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
  OrganizationSuggestionReviewReq,
  BootstrapLifecycle
} from '@agentconnect.md/protocol'
import {
  buildEnvelope,
  decodeEnvelope,
  encode,
  MAX_FRAME_BYTES,
  SESSION_LIVE_TAIL_FEATURE,
  SESSION_METADATA_ACK_FEATURE,
  SESSION_PURGE_FEATURE,
  ORGANIZATION_KNOWLEDGE_FEATURE,
  DAEMON_BOOTSTRAP_PROTOCOL_VERSION
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
import type { TaskReader } from './task-reader.js'
import { TaskViolationError } from './task-reader.js'
import type { AgentWaker } from './agent-wake.js'
import { AgentWakeViolationError } from './agent-wake.js'
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

// Frames that carry no org because they are daemon-level: the CP applies the
// same list at its edge (ws/connection.ts INSTALL_WIDE_FRAME_TYPES). Duty groups
// span orgs on one member, so grants carry a per-entry orgId instead.
const INSTALL_WIDE_FRAME_TYPES = new Set([
  'relay/roster',
  'collaboration/routes',
  'daemon/drain',
  'daemon/restart',
  'daemon/upgrade',
  'config/push',
  'duty/grant',
  'duty/renewed',
  'duty/revoke',
  'duty/release',
  'duty/claim',
  'duty/claim/ok'
])

const ACK_TIMEOUT_MS = 5000
const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 30000
// No-split invariant `T_reassign > T_fence`. The CP frees a lease at `renewedAt + leaseMs` and tells the member
// that horizon on each renewal it performed (`duty/renewed`), so the member fences this fraction of it measured
// from RECEIPT — receipt is strictly after the CP's renew, and both ends of the subtraction are the daemon's own
// clock, so no skew enters. The remaining quarter is pure slop: the confirmation's one-way delivery, the daemon's
// scheduling delay, and the teardown itself. Breaking the invariant would take a confirmation delivered more than
// a quarter of the horizon late (30s at the shipped 120s) — a link that dead delivers nothing at all.
const DUTY_FENCE_HORIZON_FRACTION = 0.75
// Horizon assumed when `auth/ok` carries none (a CP older than the field); mirrors the CP's shipped default.
// Deliberately a copy: it is a guess about a peer that cannot answer, and guessing beats silently never fencing.
const DUTY_LEASE_FALLBACK_MS = 120_000
const REGISTERING_CONTROL_QUEUE_LIMIT = 1024
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length

export type CpState = 'CONNECTING' | 'AUTHENTICATING' | 'REGISTERING' | 'READY' | 'DRAINING' | 'CLOSED' | 'DEGRADED'

export type BootstrapUpgradeOutcome =
  { status: 'current' } | { status: 'failed'; reason: string } | { status: 'installed'; restart: () => void }

interface RegisterControlBarrier {
  transport: Transport
  registerRequestId: string
  /** Becomes true only after a valid register/ok correlated to this request. */
  snapshotApplying: boolean
  controls: Array<{ frame: AnyFrame; epoch?: number }>
}

export interface CpClientDeps {
  url: string
  /** The CP API key. Absent on an in-cluster daemon, which presents
   *  {@link CpClientDeps.clusterIdentityToken} instead. */
  token?: string
  /** This pod's projected ServiceAccount token, re-read per connect because the kubelet
   *  rotates it roughly hourly. Present ⇒ it is the credential and the API key is not sent. */
  clusterIdentityToken?: () => string | undefined
  /** Optional: when unset, the token's `sub` is the authoritative daemonId and
   *  the CP assigns it. The adopted id is surfaced via `onDaemonId`. */
  daemonId?: string
  agentVersion: string
  host: string
  /** Rollout generation (pod-template hash) — a pool member's; absent for a local daemon. */
  generation?: string
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
  /** Tenant lookup for agent-scoped frames on an install-wide connection. */
  orgForAgent?: (agentId: string) => string | undefined
  /** Tenant lookup for integration reports whose payload has no agent id. */
  orgForIntegration?: (integrationId: string) => string | undefined
  /** Unservable CP-rule agentIds, surfaced in heartbeat.degradedScopes. Defaults to []. */
  degradedScopes?: () => string[]
  /** Duty-lease digest + headroom for the heartbeat (frames/duty.ts). Only read on
   *  an install-wide (frame-mode) connection; absent ⇒ this daemon does not
   *  participate in the ledger and the CP-side exchange stays dormant. */
  duties?: () => HeartbeatDuties | undefined
  /** Groups whose admission is in flight — intended to be held, not yet in the digest. Their deadlines must
   *  survive a renewal's prune: dropping one is exactly what would leave an admitted group with no fence. */
  dutyPending?: () => string[]
  /** Duty self-fence: these groups' leases are about to go vacant at the CP, so stop serving them first. Called
   *  with the groups whose OWN deadline elapsed — never the whole held set — so a member sheds exactly what it
   *  can no longer prove it holds and keeps serving the rest. */
  onDutyFence?: (groupIds: string[]) => void
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
  /** Read-only projection of the in-memory background-task lease (§3.5 of webchat-side-panels.md). */
  taskReader: TaskReader
  /** The console's sandbox wake (`agent/wake`); absent ⇒ every wake answers `unsupported`. */
  agentWake?: AgentWaker
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
  /** Auth-time recovery directive handled before full registration. */
  onBootstrapUpgrade?: (lifecycle: BootstrapLifecycle) => Promise<BootstrapUpgradeOutcome>
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
  private organizationMode: 'connection' | 'frame' = 'connection'
  private attempt = 0
  private reconnectTimer?: TimerHandle
  private lastAuthedEpoch = 0 // for resume on reconnect (per-agent seq tail is out of scope)
  private heartbeatTimer?: TimerHandle
  /** Debounce for {@link CpClient.reportDutiesNow} — one extra beat per admission, not per group. */
  private dutyReportTimer?: TimerHandle
  private heartbeatMs = 0
  /** Lease horizon: the CP's `auth/ok` value, replaced by each renewal's own. */
  private dutyLeaseMs?: number
  /** True when this CP confirms renewals (`auth/ok` carried a horizon ⇒ it also sends `duty/renewed`), so the
   *  anchor is evidence the CP renewed rather than evidence we queued a frame. */
  private dutyRenewalsConfirmed = false
  /** One fence deadline PER HELD GROUP, keyed by groupId, each anchored on the receipt that restarted it:
   *  `duty/renewed` (all of them), a `duty/grant`, or a won `duty/claim/ok` (just that one). The CP expires each
   *  lease independently, so a single global deadline would let a fresh grant or claim postpone an older group
   *  past its own unchanged expiry — and would leave a group granted without a following confirmation with no
   *  deadline at all. Empty ⇒ no lease this member could lose. */
  private readonly dutyDeadlines = new Map<string, { anchoredAt: number; deadline: number }>()
  private dutyFenceTimer?: TimerHandle
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
  /** In-flight commit-message passes by REQ id, so a retransmit of the same REQ joins the pass it
   *  already started instead of running a second model turn (see the `workspace/gitmessage` case). */
  private gitMessageInflight = new Map<string, Promise<WorkspaceGitMessageResult>>()

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
    // A local shutdown tears down every agent anyway — a fence timer outliving it would
    // only fire into a daemon that has already stopped serving.
    this.clearDutyFence()
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
    // Read per connect, never cached: the kubelet rewrites the projected token roughly hourly.
    const identityToken = this.deps.clusterIdentityToken?.()
    const authPayload: Record<string, unknown> = {
      ...(identityToken ? { serviceAccountToken: identityToken } : { apiKey: this.deps.token }),
      agentVersion: this.deps.agentVersion,
      ...(this.deps.onBootstrapUpgrade ? { bootstrapProtocolVersion: DAEMON_BOOTSTRAP_PROTOCOL_VERSION } : {})
    }
    // Send daemonId only if configured; otherwise the CP derives it from the
    // token's `sub` and returns it in auth/ok (token-only onboarding). Never echoed on the
    // identity-token path: the CP re-derives the daemon from the token each connect, so an
    // id adopted from an earlier auth/ok could only contradict it — and a mismatch is fatal.
    if (this.deps.daemonId && !identityToken) {
      authPayload.daemonId = this.deps.daemonId
    }
    if (this.lastAuthedEpoch > 0) {
      authPayload.resume = { lastEpoch: this.lastAuthedEpoch }
    }
    const auth = buildEnvelope('auth', authPayload)
    const authOk = await this.correlator.request(auth, (encoded) => expectedTransport.send(encoded))
    const ok = authOk.payload as {
      daemonId: string
      sessionEpoch: number
      heartbeatSec: number
      dutyLeaseMs?: number
      webAppUrl?: string
      orgSlug?: string
      organizationMode?: 'connection' | 'frame'
      lifecycle?: BootstrapLifecycle
    }
    this.sessionEpoch = ok.sessionEpoch
    this.organizationMode = ok.organizationMode ?? 'connection'
    this.dutyLeaseMs = ok.dutyLeaseMs
    // A CP that announces its horizon is a CP that confirms renewals — both landed together.
    this.dutyRenewalsConfirmed = ok.dutyLeaseMs !== undefined
    // Once per connection, and only where a lease can exist: a member fencing on a guess should say so.
    if (!this.dutyRenewalsConfirmed && this.organizationMode === 'frame' && this.deps.duties) {
      this.deps.log.warn(
        `cp: no duty lease horizon in auth/ok — self-fencing on the built-in ${DUTY_LEASE_FALLBACK_MS}ms default, ` +
          'anchored on the heartbeats sent rather than on renewals confirmed'
      )
    }
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
    this.state = 'REGISTERING'
    if (ok.lifecycle && this.deps.onBootstrapUpgrade) {
      let outcome: BootstrapUpgradeOutcome
      try {
        outcome = await this.deps.onBootstrapUpgrade(ok.lifecycle)
      } catch (err) {
        outcome = { status: 'failed', reason: err instanceof Error ? err.message : String(err) }
      }
      if (outcome.status === 'failed') {
        await this.reportBootstrapResult(expectedTransport, ok.lifecycle, 'failed', outcome.reason)
      } else if (outcome.status === 'installed') {
        await this.reportBootstrapResult(expectedTransport, ok.lifecycle, 'installed').catch((err) => {
          this.deps.log.error(`cp: could not confirm bootstrap installation: ${(err as Error).message}`)
        })
        this.stopped = true
        outcome.restart()
        expectedTransport.close(1000, 'bootstrap upgrade installed')
        throw new Error(`bootstrap upgrade to ${ok.lifecycle.targetVersion} installed`)
      }
    }

    // ── register ──
    const registerCapabilities = this.deps.capabilities()
    this.lastSentCapabilities = JSON.stringify(registerCapabilities)
    const register = buildEnvelope('register', {
      host: this.deps.host,
      ...(this.deps.generation ? { generation: this.deps.generation } : {}),
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
    // A member with a running fence beats immediately instead of a cadence from now: only a CONFIRMED
    // renewal lifts the fence, and a reconnect that waits for the next scheduled beat can be fenced with
    // the link already healthy. The confirmation this elicits is what actually cancels it.
    if (this.state === 'READY' && this.dutyDeadlines.size > 0) this.sendHeartbeat()
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

  private async reportBootstrapResult(
    transport: Transport,
    lifecycle: BootstrapLifecycle,
    status: 'installed' | 'failed',
    reason?: string
  ): Promise<void> {
    const result = buildEnvelope('daemon/bootstrap/result', {
      operationId: lifecycle.operationId,
      status,
      ...(reason ? { reason: reason.slice(0, 500) } : {})
    })
    const reply = await this.correlator.request(result, (encoded) => transport.send(encoded))
    if (reply.type !== 'ack' || !(reply.payload as { ok?: boolean }).ok) {
      throw new Error('control plane rejected the bootstrap result')
    }
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
    this.transport?.send(encode(this.scopedFrame('usage/report', report)))
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
    this.transport?.send(encode(this.scopedFrame('event/session', event)))
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
    this.transport?.send(encode(this.scopedFrame('event/session-activity', activity)))
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
    this.transport?.send(
      encode(this.scopedFrame('integration/channels', snapshot, this.deps.orgForIntegration?.(snapshot.integrationId)))
    )
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
    this.transport?.send(encode(this.scopedFrame('cron/report', report)))
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
  async authorizeGithubReview(payload: GithubReviewAuthorize, orgId?: string): Promise<GithubReviewAuthorized> {
    this.requireReady('github/review-authorize')
    const rep = await this.request('github/review-authorize', payload, orgId)
    if (rep.type !== 'github/review-authorized') {
      throw new WireError('INTERNAL', `expected github/review-authorized, got ${rep.type}`, false)
    }
    return rep.payload as GithubReviewAuthorized
  }

  /** Immediate body-free outcome; HookReport repeats it for lost-reply recovery. */
  async reportGithubReviewResult(payload: GithubReviewResultReport, orgId?: string): Promise<GithubReviewResultOk> {
    this.requireReady('github/review-result')
    const rep = await this.request('github/review-result', payload, orgId)
    if (rep.type !== 'github/review-result/ok') {
      throw new WireError('INTERNAL', `expected github/review-result/ok, got ${rep.type}`, false)
    }
    return rep.payload as GithubReviewResultOk
  }

  async issueWebchatMcpGrant(payload: WebchatMcpGrantIssue, orgId?: string): Promise<WebchatMcpGrantIssued> {
    this.requireReady('webchat/mcp-grant/issue')
    const rep = await this.request('webchat/mcp-grant/issue', payload, orgId)
    if (rep.type !== 'webchat/mcp-grant/issued') {
      throw new WireError('INTERNAL', `expected webchat/mcp-grant/issued, got ${rep.type}`, false)
    }
    return rep.payload as WebchatMcpGrantIssued
  }

  async acceptWebchatMcpGrant(payload: WebchatMcpGrantAccept, orgId?: string): Promise<WebchatMcpGrantActivate> {
    this.requireReady('webchat/mcp-grant/accept')
    const rep = await this.request('webchat/mcp-grant/accept', payload, orgId)
    if (rep.type !== 'webchat/mcp-grant/activate') {
      throw new WireError('INTERNAL', `expected webchat/mcp-grant/activate, got ${rep.type}`, false)
    }
    return rep.payload as WebchatMcpGrantActivate
  }

  async revokeWebchatMcpGrant(payload: WebchatMcpGrantRevoke, orgId?: string): Promise<WebchatMcpGrantRevoked> {
    this.requireReady('webchat/mcp-grant/revoke')
    const rep = await this.request('webchat/mcp-grant/revoke', payload, orgId)
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

  private request(type: string, payload: unknown, explicitOrgId?: string): Promise<AnyFrame> {
    const frame = this.scopedFrame(type, payload, explicitOrgId)
    return this.correlator.request(frame, (e) => this.transport!.send(e))
  }

  /** Request a short-lived git credential only while connected, with one send and a 10s timeout. */
  async requestGitCred(payload: GitCredRequest): Promise<GitCredGrant> {
    if ((this.state !== 'READY' && this.state !== 'DRAINING') || !this.transport) {
      throw new WireError('INTERNAL', `control plane unreachable (client ${this.state})`, true)
    }
    const frame = this.scopedFrame('gitcred/request', payload)
    const rep = await this.correlator.request(frame, (e) => this.transport!.send(e), {
      maxTries: 1,
      ackTimeoutMs: 10_000
    })
    if (rep.type !== 'gitcred/grant') {
      throw new WireError('INTERNAL', `expected gitcred/grant, got ${rep.type}`, false)
    }
    return rep.payload as GitCredGrant
  }

  /**
   * `duty/release` (D→C REQ → `ack`) — surrender duty groups on drain instead of
   * waiting out the CP's reassignment window. Install-wide: duty groups span
   * orgs, so the frame carries no org (see {@link INSTALL_WIDE_FRAME_TYPES}).
   * Best-effort by contract — a failed release just falls back to lease expiry,
   * so callers log rather than fail the drain.
   */
  async releaseDuties(groupIds: string[]): Promise<void> {
    if (groupIds.length === 0) return
    if ((this.state !== 'READY' && this.state !== 'DRAINING') || !this.transport) {
      throw new WireError('INTERNAL', `control plane unreachable (client ${this.state})`, true)
    }
    const rep = await this.request('duty/release', { groupIds })
    if (rep.type !== 'ack') throw new WireError('INTERNAL', `expected ack, got ${rep.type}`, false)
    // Handed back, so their deadlines are not ours to run any more — and a released group must not
    // sit in the map holding the timer earlier than a group this member still serves.
    this.forgetLeaseDeadlines(groupIds)
  }

  /**
   * `duty/claim` (D→C REQ → `duty/claim/ok`) — the activation rendezvous: claim
   * the agent's duty because a trigger for it landed here. Install-wide, like
   * every other duty frame. A win carries the grant to install verbatim; a loss
   * names the incumbent so the caller can NAK with a re-route target.
   */
  async claimDuty(agentId: string): Promise<DutyClaimOk> {
    if ((this.state !== 'READY' && this.state !== 'DRAINING') || !this.transport) {
      throw new WireError('INTERNAL', `control plane unreachable (client ${this.state})`, true)
    }
    const rep = await this.request('duty/claim', { agentId })
    if (rep.type !== 'duty/claim/ok') {
      throw new WireError('INTERNAL', `expected duty/claim/ok, got ${rep.type}`, false)
    }
    const claim = rep.payload as DutyClaimOk
    // A won claim CREATES this member's lease (`claimAgentHome` writes `expiresAt = now + leaseMs`) and it starts
    // serving at once — often the member's FIRST lease, with no heartbeat confirmed for it yet, so without this
    // the rendezvous would serve with no countdown running. Only THIS group's deadline moves: the claim renewed
    // nothing else, and postponing an older group here is exactly the hole per-group deadlines close.
    if (claim.granted && claim.grant) this.noteLeasesGranted([claim.grant.groupId])
    return claim
  }

  /**
   * `duty/fetch` (D→C REQ → `duty/fetch/ok`) — pull the complete definition of
   * an agent this member won a duty for but does not have. A grant only opens
   * the serving gate; installation is this pull. The frame carries the granted
   * entry's `orgId` rather than joining the install-wide set: it is about ONE
   * agent in ONE org, and the CP still resolves the owning org from the agent
   * itself before authorizing on the duty holding.
   */
  async fetchDutyAgent(agentId: string, orgId: string): Promise<DutyFetchOk> {
    if ((this.state !== 'READY' && this.state !== 'DRAINING') || !this.transport) {
      throw new WireError('INTERNAL', `control plane unreachable (client ${this.state})`, true)
    }
    const rep = await this.request('duty/fetch', { agentId }, orgId)
    if (rep.type !== 'duty/fetch/ok') {
      throw new WireError('INTERNAL', `expected duty/fetch/ok, got ${rep.type}`, false)
    }
    return rep.payload as DutyFetchOk
  }

  /** How this connection is tenanted: `connection` = one org (an API-key daemon),
   *  `frame` = install-wide, every frame carries its own org. Duty leases exist
   *  only on the latter. */
  organizationScope(): 'connection' | 'frame' {
    return this.organizationMode
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
    const frame = this.scopedFrame('channel/agents', payload)
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
  async childSessionStatus(payload: ChildSessionStatusReq, orgId?: string): Promise<ChildSessionStatus> {
    if ((this.state !== 'READY' && this.state !== 'DRAINING') || !this.transport) {
      throw new WireError('INTERNAL', `control plane unreachable (client ${this.state})`, true)
    }
    const frame = this.scopedFrame('session/child-status', payload, orgId)
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

  async syncOrganizationSuggestions(
    payload: OrganizationSuggestionsSyncReq,
    orgId?: string
  ): Promise<OrganizationSuggestionsSyncOk> {
    this.requireReady('knowledge/suggestions/sync')
    if (!this.supportsServerFeature(ORGANIZATION_KNOWLEDGE_FEATURE)) return { decisions: [] }
    const rep = await this.request('knowledge/suggestions/sync', payload, orgId)
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
    if (this.organizationMode === 'frame' && !frame.orgId && !this.installWideControl(frame.type)) {
      this.sendError(frame.id, 'SCOPE_DENIED', 'organization is required on an install-wide connection', false)
      return
    }
    const expectedOrgId = this.organizationForControl(frame)
    if (frame.orgId && expectedOrgId && frame.orgId !== expectedOrgId) {
      this.sendError(frame.id, 'SCOPE_DENIED', 'organization does not match the targeted resource', false)
      return
    }
    this.dispatchControl(frame)
  }

  private organizationForControl(frame: AnyFrame): string | undefined {
    const payload = frame.payload && typeof frame.payload === 'object' ? (frame.payload as Record<string, unknown>) : {}
    if (typeof payload.orgId === 'string') return payload.orgId
    const spec =
      payload.spec && typeof payload.spec === 'object' ? (payload.spec as Record<string, unknown>) : undefined
    if (typeof spec?.orgId === 'string') return spec.orgId
    const agentId = [
      payload.agentId,
      payload.requesterAgentId,
      payload.sourceAgentId,
      payload.callerAgentId,
      payload.childAgentId,
      spec?.agentId
    ].find((value): value is string => typeof value === 'string')
    if (agentId) return this.deps.orgForAgent?.(agentId)
    if (typeof payload.integrationId === 'string') return this.deps.orgForIntegration?.(payload.integrationId)
    return undefined
  }

  private installWideControl(type: string): boolean {
    return INSTALL_WIDE_FRAME_TYPES.has(type)
  }

  private scopedFrame(type: string, payload: unknown, explicitOrgId?: string): AnyFrame {
    let orgId = explicitOrgId
    if (!orgId && payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>
      const agentId = [p.agentId, p.requesterAgentId, p.sourceAgentId, p.callerAgentId, p.childAgentId].find(
        (value): value is string => typeof value === 'string'
      )
      if (agentId) orgId = this.deps.orgForAgent?.(agentId)
    }
    if (this.organizationMode === 'frame' && !orgId && !INSTALL_WIDE_FRAME_TYPES.has(type)) {
      throw new WireError('SCOPE_DENIED', `cannot resolve organization for ${type}`, false)
    }
    return buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload, orgId ? { orgId } : {})
  }

  private decodeErrorCode(msg: string): 'UNKNOWN_FRAME' | 'FRAME_TOO_LARGE' | 'BAD_PAYLOAD' {
    if (msg === 'FRAME_TOO_LARGE') return 'FRAME_TOO_LARGE'
    if (msg === 'UNKNOWN_FRAME') return 'UNKNOWN_FRAME'
    return 'BAD_PAYLOAD'
  }

  private sendError(
    corr: string,
    code: string,
    message: string,
    retryable: boolean,
    details?: Record<string, unknown>
  ): void {
    if (!this.transport) return
    this.transport.send(
      encode(buildEnvelope('error', { code, message, retryable, ...(details ? { details } : {}) }, { corr }))
    )
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
    // The fence needs nothing here: it has been running off the last confirmed renewal since that
    // renewal arrived, and a closed socket is simply one more way for the next one not to.
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
      if (this.state === 'READY') this.sendHeartbeat()
      if (this.state === 'READY' || this.state === 'DRAINING') this.armHeartbeat()
    }, this.heartbeatMs)
  }

  /**
   * Report the duty digest NOW instead of waiting out the interval.
   *
   * The digest is the CP's proof that a grant is installed — a grant is applied here only after
   * its install succeeds, so "in the digest" is the first moment this member is provably serving,
   * and the CP holds every projection that ADDRESSES this member until it sees one. Letting an
   * admission sit until the next tick therefore costs up to a full heartbeat of unroutable time
   * for an agent that is already running, which is the gap a peer wake falls into.
   *
   * Coalesced onto one extra beat: an admission routinely settles several groups, and each one
   * calls this. Dormant off a frame-mode connection, where there is no digest at all.
   */
  reportDutiesNow(): void {
    if (this.organizationMode !== 'frame' || this.state !== 'READY' || this.dutyReportTimer !== undefined) return
    this.dutyReportTimer = this.deps.clock.setTimeout(() => {
      this.dutyReportTimer = undefined
      if (this.state === 'READY') this.sendHeartbeat()
    }, 0)
  }

  private sendHeartbeat(): void {
    // The duty lease exchange rides this beat (frames/duty.ts). Absent on a
    // single-org daemon, which keeps the whole CP-side path dormant.
    const duties = this.organizationMode === 'frame' ? this.deps.duties?.() : undefined
    const live = this.transport
    live?.send(
      encode(
        buildEnvelope('heartbeat', {
          load: this.deps.loadSnapshot(),
          health: 'ok',
          activeSessions: this.deps.activeSessions(),
          degradedScopes: this.deps.degradedScopes?.() ?? [],
          ...(duties ? { duties } : {})
        })
      )
    )
    // Sending is not renewing: on a half-open socket this `send` succeeds locally and the CP never runs
    // `renewHeld`, so against a confirming CP the anchor moves only in `onDutyRenewed`. Against one that
    // confirms nothing this is the best evidence available, and it is weaker on exactly that failure.
    if (duties && live && !this.dutyRenewalsConfirmed) this.noteLeasesRenewed()
  }

  /** `duty/renewed` EVT — the CP renewed this member's leases for `leaseMs` more, as of a moment strictly before
   *  this frame arrived. The only thing that restarts the fence countdown against a confirming CP. */
  private onDutyRenewed(leaseMs: number): void {
    this.dutyLeaseMs = leaseMs
    this.noteLeasesRenewed()
  }

  /** A renewal restarts the countdown of EVERY group this member holds — `renewHeld` renews by holder with no id
   *  filter, so one confirmation genuinely does refresh them all, and the per-group map collapses back to a single
   *  value after each one. It is also where the map is pruned: the daemon's digest is the authoritative held set. */
  private noteLeasesRenewed(): void {
    // "What we intend to hold" = the digest PLUS the admissions still in flight. A pending group is
    // absent from the digest by design (it is not servable yet), and pruning its deadline here is what
    // would leave it serving with no fence the moment its admission completes.
    const ours = new Set([
      ...(this.deps.duties?.()?.held ?? []).map((entry) => entry.groupId),
      ...(this.deps.dutyPending?.() ?? [])
    ])
    for (const groupId of this.dutyDeadlines.keys()) if (!ours.has(groupId)) this.dutyDeadlines.delete(groupId)
    const now = this.deps.clock.now()
    for (const groupId of ours) this.dutyDeadlines.set(groupId, this.deadlineFrom(now))
    this.armDutyFence()
  }

  /** A grant or a won claim CREATES (or re-terms) exactly one lease, so only that group's countdown restarts —
   *  postponing an older group's deadline because a new one arrived is precisely the split this prevents.
   *  Receipt-anchored: the CP wrote `expiresAt` strictly before the frame reached us. This is also what arms a
   *  first grant whose renewal confirmation never lands, and what re-arms a group granted back after a fence. */
  private noteLeasesGranted(groupIds: string[]): void {
    if (groupIds.length === 0) return
    const now = this.deps.clock.now()
    for (const groupId of groupIds) this.dutyDeadlines.set(groupId, this.deadlineFrom(now))
    this.armDutyFence()
  }

  /** A revoked group is no longer ours to fence — drop its deadline so it cannot fire, and so it cannot hold the
   *  timer at an earlier point than any group still held. */
  private forgetLeaseDeadlines(groupIds: string[]): void {
    let dropped = false
    for (const groupId of groupIds) dropped = this.dutyDeadlines.delete(groupId) || dropped
    if (dropped) this.armDutyFence()
  }

  private deadlineFrom(now: number): { anchoredAt: number; deadline: number } {
    const horizon = this.dutyLeaseMs ?? DUTY_LEASE_FALLBACK_MS
    return { anchoredAt: now, deadline: now + Math.floor(horizon * DUTY_FENCE_HORIZON_FRACTION) }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      this.deps.clock.clearTimeout(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  /** Arm on the EARLIEST deadline any held group has. Deliberately armed while the link is UP, not on disconnect:
   *  a half-open socket produces no close event and no renewal either, and only a running deadline fences it.
   *  A healthy member simply re-arms every renewal, long before the deadline it set the time before. */
  private armDutyFence(): void {
    this.clearDutyFence()
    if (!this.deps.onDutyFence || this.dutyDeadlines.size === 0) return // no lease the CP could reassign
    let earliest = Infinity
    for (const { deadline } of this.dutyDeadlines.values()) earliest = Math.min(earliest, deadline)
    const delay = Math.max(0, earliest - this.deps.clock.now())
    this.dutyFenceTimer = this.deps.clock.setTimeout(() => {
      this.dutyFenceTimer = undefined
      this.fireDutyFence()
    }, delay)
  }

  /** Fence the groups whose own deadline has passed and re-arm at the next earliest — a group whose lease the CP
   *  still honours keeps serving. Each fenced group's deadline is dropped, so nothing re-arms it but a fresh grant
   *  or renewal: a link that flaps for an hour fences a given group once, not once per drop. */
  private fireDutyFence(): void {
    const now = this.deps.clock.now()
    const expired: string[] = []
    let oldest = now
    for (const [groupId, entry] of this.dutyDeadlines) {
      if (entry.deadline > now) continue
      expired.push(groupId)
      oldest = Math.min(oldest, entry.anchoredAt)
      this.dutyDeadlines.delete(groupId)
    }
    if (expired.length > 0) {
      this.deps.log.warn(
        `cp: duty self-fence — ${expired.length} group(s) with no confirmed lease renewal for ${now - oldest}ms; ` +
          `releasing them before the CP can reassign them (${this.dutyDeadlines.size} still leased)`
      )
      this.deps.onDutyFence?.(expired)
    }
    this.armDutyFence()
  }

  private clearDutyFence(): void {
    if (this.dutyFenceTimer !== undefined) {
      this.deps.clock.clearTimeout(this.dutyFenceTimer)
      this.dutyFenceTimer = undefined
    }
  }

  /** C→D control dispatch. The CP changes config, never live routing. */
  private dispatchControl(frame: AnyFrame): void {
    switch (frame.type) {
      case 'config/push':
        this.deps.configApply.applyConfigPush((frame.payload as { keys: Record<string, unknown> }).keys)
        return // EVT — no reply
      case 'duty/grant': {
        const { grants } = frame.payload as DutyGrant
        // BEFORE admission, which is async: the CP's lease on these groups is already running, and a grant whose
        // renewal confirmation never arrives must still fence — the receipt of the grant is what arms it.
        this.noteLeasesGranted(grants.map((entry) => entry.groupId))
        this.deps.configApply.applyDutyGrant(grants)
        return // EVT — no reply
      }
      case 'duty/renewed':
        this.onDutyRenewed((frame.payload as DutyRenewed).leaseMs)
        return // EVT — no reply
      case 'duty/revoke': {
        const { revocations } = frame.payload as DutyRevoke
        this.deps.configApply.applyDutyRevoke(revocations)
        // Not ours any more: a revoked group must not keep a deadline that could fence it a second time, nor
        // hold the timer earlier than any group still held.
        this.forgetLeaseDeadlines(revocations.map((revocation) => revocation.groupId))
        return // EVT — no reply
      }
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
        this.deps.configApply.applyMcpServerRemove(frame.payload as Parameters<ConfigApply['applyMcpServerRemove']>[0])
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
        const req = frame.payload as SessionHistoryReq
        if (!req.agentId)
          this.deps.log.warn('cp: legacy session/history request omitted agentId; owner binding is unavailable')
        Promise.resolve()
          .then(() => this.deps.sessionRead.history(req))
          .then((page) => this.reply(frame, 'session/history/page', page))
          .catch((err) =>
            this.sendError(frame.id, 'INTERNAL', `session/history failed: ${(err as Error).message}`, false)
          )
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
        const req = frame.payload as SessionToolBodyReq
        if (!req.agentId)
          this.deps.log.warn('cp: legacy session/tool-body request omitted agentId; owner binding is unavailable')
        Promise.resolve()
          .then(() => this.deps.sessionRead.toolBody(req))
          .then((chunk) => this.reply(frame, 'session/tool-body/chunk', chunk))
          .catch((err) =>
            this.sendError(frame.id, 'INTERNAL', `session/tool-body failed: ${(err as Error).message}`, false)
          )
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
      case 'workspace/gitdiff': {
        // Unified diff for one path — binary / unchanged / non-repo all come back as a result.
        this.deps.workspaceGit
          .diff(frame.payload as WorkspaceGitDiffReq)
          .then((result) => this.reply(frame, 'workspace/gitdiff/result', result))
          .catch((err) => this.workspaceError(frame.id, 'workspace/gitdiff', err))
        return
      }
      case 'workspace/gitlog': {
        // Newest commits of the checked-out branch; an empty repo is a result, not an error.
        this.deps.workspaceGit
          .log(frame.payload as WorkspaceGitLogReq)
          .then((result) => this.reply(frame, 'workspace/gitlog/result', result))
          .catch((err) => this.workspaceError(frame.id, 'workspace/gitlog', err))
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
      case 'workspace/gitstage': {
        // Console staging — the REP is the FRESH status, so the panel never re-polls its own action.
        this.deps.workspaceGit
          .stage(frame.payload as WorkspaceGitStageReq)
          .then((status) => this.reply(frame, 'workspace/gitstage/result', status))
          .catch((err) => this.workspaceError(frame.id, 'workspace/gitstage', err))
        return
      }
      case 'workspace/gitunstage': {
        this.deps.workspaceGit
          .unstage(frame.payload as WorkspaceGitStageReq)
          .then((status) => this.reply(frame, 'workspace/gitunstage/result', status))
          .catch((err) => this.workspaceError(frame.id, 'workspace/gitunstage', err))
        return
      }
      case 'workspace/gitcommit': {
        // Nothing staged / no registered identity / a git refusal are all results, not errors.
        this.deps.workspaceGit
          .commit(frame.payload as WorkspaceGitCommitReq)
          .then((result) => this.reply(frame, 'workspace/gitcommit/result', result))
          .catch((err) => this.workspaceError(frame.id, 'workspace/gitcommit', err))
        return
      }
      case 'workspace/gitpush': {
        // A diverged branch, no upstream, a detached HEAD and a remote rejection are all results.
        this.deps.workspaceGit
          .push(frame.payload as WorkspaceGitPushReq)
          .then((result) => this.reply(frame, 'workspace/gitpush/result', result))
          .catch((err) => this.workspaceError(frame.id, 'workspace/gitpush', err))
        return
      }
      case 'workspace/gitmessage': {
        // The AI commit-message draft: a bounded model turn on THIS daemon's runtime. Nothing staged,
        // a runtime that declines and a timeout are all results, not errors.
        //
        // Retransmit-joined, and this is the only frame that needs it: the correlator re-sends the
        // IDENTICAL bytes (same id) when a REP is slow, and a model pass is always slower than one
        // ack window. Without this, one press could run — and bill — several passes.
        const inflight = this.gitMessageInflight.get(frame.id)
        const pass =
          inflight ??
          this.deps.workspaceGit
            .message(frame.payload as WorkspaceGitMessageReq)
            .finally(() => this.gitMessageInflight.delete(frame.id))
        if (!inflight) this.gitMessageInflight.set(frame.id, pass)
        pass
          .then((result) => this.reply(frame, 'workspace/gitmessage/result', result))
          .catch((err) => this.workspaceError(frame.id, 'workspace/gitmessage', err))
        return
      }
      case 'task/list': {
        // Background tasks of ONE ACP session, projected live from the lease. A session with no
        // lease and a session with no tasks are both results (`tracked` tells them apart).
        this.deps.taskReader
          .list(frame.payload as TaskListReq)
          .then((result) => this.reply(frame, 'task/list/result', result))
          .catch((err) => this.taskError(frame.id, 'task/list', err))
        return
      }
      case 'agent/wake': {
        // A sandbox resume with no turn; a daemon with no waker has nothing to wake.
        const wake = frame.payload as AgentWakeReq
        const answer =
          this.deps.agentWake?.wake(wake) ?? Promise.resolve({ agentId: wake.agentId, state: 'unsupported' as const })
        answer
          .then((result) => this.reply(frame, 'agent/wake/ok', result))
          .catch((err) => this.wakeError(frame.id, err))
        return
      }
      case 'memory/channels': {
        this.deps.memoryReader
          .channels(frame.payload as MemoryChannelsReq)
          .then((page) => this.reply(frame, 'memory/channels/page', page))
          .catch((err) => this.memoryError(frame.id, 'memory/channels', err))
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

  /** Map a workspace failure onto the wire: stale writes → CONFLICT; containment/
   *  bad-request violations → BAD_PAYLOAD (their messages are hand-written and
   *  path-free); anything else → INTERNAL with a GENERIC message — raw fs errors
   *  (ELOOP, EACCES, …) embed absolute host paths that must not leak to the CP/UI.
   *  Both typed cases carry their `reason` in `details` so the CP can answer a bad
   *  request with a status the console can tell apart from an offline daemon. */
  private workspaceError(corr: string, op: string, err: unknown): void {
    if (err instanceof WorkspaceConflictError) {
      this.sendError(corr, 'CONFLICT', `${op} failed: ${err.message}`, false, { reason: err.reason })
      return
    }
    if (err instanceof WorkspaceViolationError) {
      this.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false, { reason: err.reason })
      return
    }
    this.deps.log.warn(`cp: ${op} failed: ${(err as Error)?.message}`)
    this.sendError(corr, 'INTERNAL', `${op} failed`, false)
  }

  /** Unknown agent → BAD_PAYLOAD with the machine reason (the CP maps it like a workspace read's); else INTERNAL. */
  private wakeError(corr: string, err: unknown): void {
    if (err instanceof AgentWakeViolationError) {
      this.sendError(corr, 'BAD_PAYLOAD', `agent/wake failed: ${err.message}`, false, { reason: err.reason })
      return
    }
    this.deps.log.warn(`cp: agent/wake failed: ${(err as Error)?.message}`)
    this.sendError(corr, 'INTERNAL', 'agent/wake failed', false)
  }

  /** Unknown agent → BAD_PAYLOAD with the machine reason; anything else → INTERNAL with a generic
   *  message. There is no CONFLICT arm because `task/list` reads in-memory state and mutates
   *  nothing, so no lifecycle state can make it a legal-but-refused request. */
  private taskError(corr: string, op: string, err: unknown): void {
    if (err instanceof TaskViolationError) {
      this.sendError(corr, 'BAD_PAYLOAD', `${op} failed: ${err.message}`, false, { reason: err.reason })
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
    this.transport?.send(
      encode(
        buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload, {
          corr: req.id,
          ...(req.orgId ? { orgId: req.orgId } : {})
        })
      )
    )
  }

  /** Emit an uncorrelated EVT (e.g. `drain/progress`). */
  private emit(type: string, payload: unknown): void {
    this.transport?.send(encode(buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload)))
  }
}
