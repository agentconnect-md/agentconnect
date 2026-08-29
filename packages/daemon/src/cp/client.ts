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
  CodeHostNoteResult,
  CodeHostNoteResultOk,
  CodeHostReviewAuthorize,
  CodeHostReviewAuthorized,
  CodeHostReviewLeaseRenew,
  CodeHostReviewLeaseRenewed,
  CodeHostReviewOpAccepted,
  CodeHostReviewOpRequest,
  CodeHostReviewResultOk,
  CodeHostReviewResultReport,
  GitCredRequest,
  GitCredGrant,
  ChannelAgentsReq,
  ChannelAgentsOk,
  ChildSessionStatus,
  ChildSessionStatusReq,
  MemoryConnectionFact,
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
  BootstrapLifecycle,
  FrameOrgPeer,
  OrganizationMode
} from '@agentconnect.md/protocol'
import {
  buildEnvelope,
  decodeCpEnvelope,
  encode,
  MAX_FRAME_BYTES,
  SESSION_LIVE_TAIL_FEATURE,
  SESSION_METADATA_ACK_FEATURE,
  SESSION_PURGE_FEATURE,
  ORGANIZATION_KNOWLEDGE_FEATURE,
  DAEMON_BOOTSTRAP_PROTOCOL_VERSION,
  checkInboundFrameOrg,
  checkReplyFrameOrg,
  isInstallWideFrameType
} from '@agentconnect.md/protocol'
import { ReqRep, WireError, type Clock, type TimerHandle, type Transport } from '@agentconnect.md/connection'
import type { AgentControlDeps } from './control/agent.js'
import type { ControlWire } from './control/context.js'
import type { CodeHostControlDeps } from './control/codehost.js'
import type { DreamControlDeps } from './control/dream.js'
import type { MemoryControlDeps } from './control/memory.js'
import { CONTROL_HANDLERS, type ControlDeps } from './control/registry.js'
import type { SessionControlDeps } from './control/session.js'
import type { SkillsControlDeps } from './control/skills.js'
import type { TaskControlDeps } from './control/task.js'
import type { AutoMergeControlDeps } from './control/automerge.js'
import type { SandboxKeepAliveDeps } from './control/sandbox-keepalive.js'
import { GitMessagePasses, type WorkspaceReadDeps } from './control/workspace.js'
import type { ConfigApply } from './config-apply.js'
import type { Logger } from '../log.js'

/** The daemon↔CP wire's subprotocol + mount path — re-exported from the shared
 *  protocol package (single source of truth) so the daemon's existing import
 *  sites (`./cp/client.js`) keep working unchanged. */
export { CP_SUBPROTOCOL, CP_WS_PATH } from '@agentconnect.md/protocol'

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

export interface CpClientDeps
  extends
    AgentControlDeps,
    DreamControlDeps,
    MemoryControlDeps,
    SessionControlDeps,
    SkillsControlDeps,
    TaskControlDeps,
    AutoMergeControlDeps,
    SandboxKeepAliveDeps,
    CodeHostControlDeps,
    WorkspaceReadDeps {
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
  /** false ⇒ this daemon never reports session usage to the CP, because something
   *  upstream of it is the single writer for these sessions. Local recording is
   *  unaffected. Absent ⇒ reporting is on. */
  usageReporting?: boolean
  /** Tenant lookup for agent-scoped frames on an install-wide connection. */
  orgForAgent?: (agentId: string) => string | undefined
  /** Tenant lookup for integration reports whose payload has no agent id. */
  orgForIntegration?: (integrationId: string) => string | undefined
  /** Tenant lookup for cron control frames, which name only the cron. */
  orgForCron?: (cronId: string) => string | undefined
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
  /** Called when the CP rejects this daemon's credential for good (4401) AND that credential is the
   *  projected identity token — the one case a restart can fix, since the token is re-read from the
   *  pod's volume on every boot. The daemon exits here so its supervisor redials with backoff. */
  onAuthFatal?: () => void
  /** Auth-time recovery directive handled before full registration. */
  onBootstrapUpgrade?: (lifecycle: BootstrapLifecycle) => Promise<BootstrapUpgradeOutcome>
  /** Called once the daemon reaches READY on each (re)connect, after the initial
   *  runtime profiles are emitted. The daemon uses this to kick off background
   *  runtime probing and push the refreshed snapshot via `emitDaemonRuntimes`. */
  onReady?: () => void | Promise<void>
}

export class CpClient {
  state: CpState = 'CLOSED'
  sessionEpoch = 0
  routingEpoch = 0

  private transport?: Transport
  private readonly correlator: ReqRep<AnyFrame>
  private stopped = false
  private fatal = false // 4401 — this connection never redials (the process may still exit and retry)
  private serverFeatures = new Set<string>()
  private organizationMode: OrganizationMode = 'connection'
  /** The member set the CP announced at `auth/ok` (daemon-groups.md §3); null ⇒ in none. Never
   *  asserted from here — membership is the CP's to record and this connection's to be told. */
  private memberSetRef: { setId: string; name: string } | null = null
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
  /** The socket-facing half handed to every control handler — this client owns the transport. */
  private readonly wire: ControlWire
  /** The deps slice the control registry dispatches against (`src/cp/control/*`). */
  private readonly controlDeps: ControlDeps

  constructor(private readonly deps: CpClientDeps) {
    this.correlator = new ReqRep<AnyFrame>(deps.clock, ACK_TIMEOUT_MS)
    this.wire = {
      reply: (req, type, payload) => this.reply(req, type, payload),
      sendError: (corr, code, message, retryable, details) => this.sendError(corr, code, message, retryable, details),
      emit: (type, payload) => this.emit(type, payload),
      log: deps.log
    }
    this.controlDeps = {
      configApply: deps.configApply,
      sessionRead: deps.sessionRead,
      childSessionStatusProbe: deps.childSessionStatusProbe && ((probe) => deps.childSessionStatusProbe!(probe)),
      pullRequestFeedback: deps.pullRequestFeedback && ((req) => deps.pullRequestFeedback!(req)),
      workspaceRead: deps.workspaceRead,
      workspaceGit: deps.workspaceGit,
      taskReader: deps.taskReader,
      autoMerge: deps.autoMerge,
      sandboxKeepAlive: deps.sandboxKeepAlive,
      agentWake: deps.agentWake,
      memoryReader: deps.memoryReader,
      dreamReader: deps.dreamReader,
      localSkillsReader: deps.localSkillsReader,
      runtimeCommandsReader: deps.runtimeCommandsReader,
      gitMessagePasses: new GitMessagePasses(),
      codeHostNoteProjection: deps.codeHostNoteProjection,
      noteLeasesGranted: (groupIds) => this.noteLeasesGranted(groupIds),
      forgetLeaseDeadlines: (groupIds) => this.forgetLeaseDeadlines(groupIds),
      onDutyRenewed: (leaseMs) => this.onDutyRenewed(leaseMs),
      // §2.1: DRAINING still admits control frames, and a bare drain is a rebalance — back to READY when it settles.
      beginDrain: () => {
        this.state = 'DRAINING'
      },
      endDrain: () => {
        if (this.state === 'DRAINING') this.state = 'READY'
      }
    }
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

  /** True once this client will never dial again — stop() ran, a fatal auth close latched, or a
   *  bootstrap upgrade retired the connection — so a retry loop waiting on it should give up now. */
  terminallyClosed(): boolean {
    return this.stopped || this.fatal
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
      organizationMode?: OrganizationMode
      memberSet?: { setId: string; name: string }
      lifecycle?: BootstrapLifecycle
    }
    this.sessionEpoch = ok.sessionEpoch
    this.organizationMode = ok.organizationMode ?? 'connection'
    this.memberSetRef = ok.memberSet ?? null
    this.dutyLeaseMs = ok.dutyLeaseMs
    // A CP that announces its horizon is a CP that confirms renewals — both landed together.
    this.dutyRenewalsConfirmed = ok.dutyLeaseMs !== undefined
    // Once per connection, and only where a lease can exist: a member fencing on a guess should say so.
    if (!this.dutyRenewalsConfirmed && this.memberSetRef && this.deps.duties) {
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
    // The replay is async now; a failed channel/cron store read must be logged here rather
    // than becoming a floating rejection that abandons the rest of this reconnect's replay.
    void Promise.resolve(this.deps.onReady?.()).catch((err) =>
      this.deps.log.error(`cp: ready replay failed: ${(err as Error).message}`)
    )
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
   * unknown-frame no-op — the feature then simply waits for the next register.
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
   * fire-and-forget). No-op when this daemon is not the usage writer, and no-op
   * unless READY/DRAINING — usage is dashboard telemetry,
   * so a dropped report just means that turn's delta is absent from the CP's
   * historical aggregates until the next report (which re-sends the cumulative
   * snapshot, latest-wins). Never blocks the turn.
   */
  emitUsageReport(report: UsageReport): void {
    // The gate lives HERE, at the one place a report leaves the daemon, so a future
    // caller cannot reintroduce a second writer by forgetting to check.
    if (this.deps.usageReporting === false) return
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

  /** Durable start barrier for an accepted hook turn. Formal review is not exposed until this
   * correlated request succeeds. The gitlab arm of the one-of is organization-scoped (§17.2). */
  async startHook(payload: HookStart, orgId?: string): Promise<HookStartOk> {
    this.requireReady('hook/start')
    const rep = await this.request('hook/start', payload, orgId)
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

  /** The observed outcome of ONE desired run projection generation (gitlab-com-integration.md §16). */
  async reportCodeHostNoteResult(payload: CodeHostNoteResult, orgId?: string): Promise<CodeHostNoteResultOk> {
    this.requireReady('codehost/note-result')
    const rep = await this.request('codehost/note-result', payload, orgId)
    if (rep.type !== 'codehost/note-result/ok') {
      throw new WireError('INTERNAL', `expected codehost/note-result/ok, got ${rep.type}`, false)
    }
    return rep.payload as CodeHostNoteResultOk
  }

  /**
   * The provider-neutral formal-review surface (gitlab-com-integration.md §15).
   * `codehost/review-authz` acquires the durable publication lease and its fence;
   * the ledger, renewal, and terminal result ride the three frames below. Review
   * bodies never travel on any of them.
   */
  async authorizeCodeHostReview(payload: CodeHostReviewAuthorize, orgId?: string): Promise<CodeHostReviewAuthorized> {
    this.requireReady('codehost/review-authz')
    const rep = await this.request('codehost/review-authz', payload, orgId)
    if (rep.type !== 'codehost/review-authz/result') {
      throw new WireError('INTERNAL', `expected codehost/review-authz/result, got ${rep.type}`, false)
    }
    return rep.payload as CodeHostReviewAuthorized
  }

  /** One step of the §15.1 single-use operation ledger. */
  async operateCodeHostReview(payload: CodeHostReviewOpRequest, orgId?: string): Promise<CodeHostReviewOpAccepted> {
    this.requireReady('codehost/review-op')
    const rep = await this.request('codehost/review-op', payload, orgId)
    if (rep.type !== 'codehost/review-op/ok') {
      throw new WireError('INTERNAL', `expected codehost/review-op/ok, got ${rep.type}`, false)
    }
    return rep.payload as CodeHostReviewOpAccepted
  }

  /** Owner-only publication-lease extension; expiry alone never transfers authority. */
  async renewCodeHostReviewLease(
    payload: CodeHostReviewLeaseRenew,
    orgId?: string
  ): Promise<CodeHostReviewLeaseRenewed> {
    this.requireReady('codehost/review-lease-renew')
    const rep = await this.request('codehost/review-lease-renew', payload, orgId)
    if (rep.type !== 'codehost/review-lease-renew/ok') {
      throw new WireError('INTERNAL', `expected codehost/review-lease-renew/ok, got ${rep.type}`, false)
    }
    return rep.payload as CodeHostReviewLeaseRenewed
  }

  /** The body-free terminal classification; it is also what releases or locks the lease. */
  async reportCodeHostReviewResult(
    payload: CodeHostReviewResultReport,
    orgId?: string
  ): Promise<CodeHostReviewResultOk> {
    this.requireReady('codehost/review-result')
    const rep = await this.request('codehost/review-result', payload, orgId)
    if (rep.type !== 'codehost/review-result/ok') {
      throw new WireError('INTERNAL', `expected codehost/review-result/ok, got ${rep.type}`, false)
    }
    return rep.payload as CodeHostReviewResultOk
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
   * orgs, so the frame carries no org (protocol `INSTALL_WIDE_FRAME_TYPES`).
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

  /** The member set this connection belongs to, as `auth/ok` announced it; null ⇒ in none
   *  (daemon-groups.md §3). This is the duty-enforcement predicate: membership, not tenancy. */
  memberSet(): { setId: string; name: string } | null {
    return this.memberSetRef
  }

  /**
   * Does this connection take part in the duty ledger? MEMBERSHIP decides, and it must be the same
   * predicate the daemon gates service on (`dutyEnforced`), or the two disagree in the worst
   * possible direction: it refuses to serve what it holds no lease for while never asking for one.
   *
   * This used to read `organizationMode === 'frame'`, which was the same answer only while the
   * install-wide pool was the one set that existed — org-scoped daemons authenticate in
   * `connection` mode, so once an org could own a group its members went duty-gated and silent,
   * and the CP never granted them anything.
   */
  private reportsDuties(): boolean {
    return this.memberSetRef !== null
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
    // The CP authors every frame on this socket, so read it tolerantly: a field it added must strip, not fail.
    const decoded = decodeCpEnvelope(text)
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
    // A correlated REP/error settles a pending daemon-issued REQ — after the org fence: a reply that
    // does not carry the org of the REQ it answers fails that REQ locally and is never applied.
    if (frame.corr) {
      const request = this.correlator.requested(frame.corr)
      if (request) {
        const verdict = checkReplyFrameOrg(request, frame, this.orgPeer())
        if (!verdict.ok) {
          this.deps.log.warn(`cp: dropped ${frame.type} reply to ${request.type}: ${verdict.message}`)
          this.correlator.reject(frame.corr, new WireError('SCOPE_DENIED', verdict.message, false))
          return
        }
      }
      if (this.correlator.settle(frame)) return
    }
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
    // Org fence (M4): the shared frame-scope gate, then the org named against the resource this
    // daemon knows the frame targets. A frame that fails is refused with an error and never applied.
    const verdict = checkInboundFrameOrg(frame, this.orgPeer())
    if (!verdict.ok) {
      this.deps.log.warn(`cp: refused ${frame.type}: ${verdict.message}`)
      this.sendError(frame.id, 'SCOPE_DENIED', verdict.message, false)
      return
    }
    const expectedOrgId = this.organizationForControl(frame)
    if (frame.orgId && expectedOrgId && frame.orgId !== expectedOrgId) {
      this.deps.log.warn(`cp: refused ${frame.type}: organization does not match the targeted resource`)
      this.sendError(frame.id, 'SCOPE_DENIED', 'organization does not match the targeted resource', false)
      return
    }
    this.dispatchControl(frame)
  }

  /** How this end reads the wire: frame mode knows no connection org; connection mode learns none either (the CP owns it). */
  private orgPeer(): FrameOrgPeer {
    return { mode: this.organizationMode, orgId: null }
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
    if (typeof payload.cronId === 'string') return this.deps.orgForCron?.(payload.cronId)
    return undefined
  }

  /** Every D→C send resolves its org here: install-wide frames carry none, org-scoped ones must resolve one in frame mode. */
  private scopedFrame(type: string, payload: unknown, explicitOrgId?: string): AnyFrame {
    if (isInstallWideFrameType(type)) return buildEnvelope(type as Parameters<typeof buildEnvelope>[0], payload)
    let orgId = explicitOrgId
    if (!orgId && payload && typeof payload === 'object') {
      const p = payload as Record<string, unknown>
      const agentId = [p.agentId, p.requesterAgentId, p.sourceAgentId, p.callerAgentId, p.childAgentId].find(
        (value): value is string => typeof value === 'string'
      )
      if (agentId) orgId = this.deps.orgForAgent?.(agentId)
    }
    if (this.organizationMode === 'frame' && !orgId) {
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
      // An API key is minted by a human and a rejected one stays rejected, so redialing it forever
      // is noise — the daemon stays up and says what to fix. A projected identity is different: it
      // is re-read from the pod's volume at every boot, the process is restart-supervised, and boot
      // BLOCKS on the first registration — so a live container that took a 4401 can never become
      // servable. Exit instead and let the supervisor's restart backoff redial.
      if (this.deps.clusterIdentityToken) {
        this.deps.log.error('cp: AUTH_FAILED (4401) — exiting; the restart re-reads the projected identity and redials')
        this.deps.onAuthFatal?.()
        return
      }
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
   * calls this. Dormant off a non-member connection, where there is no digest at all.
   */
  reportDutiesNow(): void {
    if (!this.reportsDuties() || this.state !== 'READY' || this.dutyReportTimer !== undefined) return
    this.dutyReportTimer = this.deps.clock.setTimeout(() => {
      this.dutyReportTimer = undefined
      if (this.state === 'READY') this.sendHeartbeat()
    }, 0)
  }

  private sendHeartbeat(): void {
    // The duty lease exchange rides this beat (frames/duty.ts). Absent on a daemon in no member
    // set, which keeps the whole CP-side path dormant.
    const duties = this.reportsDuties() ? this.deps.duties?.() : undefined
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

  /** C→D control dispatch. The CP changes config, never live routing. A frame kind with no
   *  registry entry is ignored — webchat content moved off this control WS (milestone A4) and
   *  rides the relay's rd/* wire now, so a stray legacy webchat/* frame lands here. */
  private async dispatchControl(frame: AnyFrame): Promise<void> {
    const handler = CONTROL_HANDLERS.get(frame.type)
    if (!handler) {
      this.deps.log.debug(`cp: ignoring ${frame.type}`)
      return
    }
    await handler(frame, this.controlDeps, this.wire)
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
