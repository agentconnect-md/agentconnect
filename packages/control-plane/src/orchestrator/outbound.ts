/**
 * `ControlSender` (design §4.7, the single fencing site) — the ONLY place that
 * stamps the `ControlExt` fencing block on outbound C→D control frames.
 * Centralizing it keeps the invariants (epoch from the live connection and the
 * current `launchId` fence) in one auditable spot.
 *
 * It is transport-aware only through the {@link ConnChannel} firewall held by the
 * `ConnectionRegistry` — it never imports `ws`. There is no CP→daemon prompt
 * delivery: the daemon prompts from its own ingress, never the CP.
 */
import { createHash } from 'node:crypto'
import { daemonSupportsAgent } from '../domain/daemon-features.js'
import type {
  Ack,
  AgentLaunch,
  AgentLaunched,
  AgentUpsert,
  AgentRemove,
  AgentDetach,
  AgentActivate,
  CronUpsert,
  CronRemove,
  CronRunNow,
  IntegrationUpsert,
  IntegrationRemove,
  IntegrationForget,
  IntegrationLeave,
  IntegrationLeaveOk,
  McpServerSpec,
  MemoryConnectionSpec,
  Drain,
  DrainDone,
  DaemonRestart,
  DaemonUpgrade,
  DaemonControlAck,
  RouteAssign,
  RouteAssignAck,
  SessionListReq,
  SessionListPage,
  SessionHistoryReq,
  SessionHistoryPage,
  SessionToolBodyReq,
  SessionToolBodyChunk,
  WorkspaceListReq,
  WorkspaceListPage,
  WorkspaceReadReq,
  WorkspaceReadContent,
  WorkspaceWriteReq,
  WorkspaceWriteOk,
  WorkspaceDeleteReq,
  WorkspaceDeleteOk,
  WorkspaceGitStatusReq,
  WorkspaceGitStatus,
  WorkspaceGitDiffReq,
  WorkspaceGitDiffResult,
  WorkspaceGitLogReq,
  WorkspaceGitLog,
  WorkspaceGitPullReq,
  WorkspaceGitPullResult,
  WorkspaceGitStageReq,
  WorkspaceGitCommitReq,
  WorkspaceGitCommitResult,
  WorkspaceGitPushReq,
  WorkspaceGitPushResult,
  WorkspaceGitMessageReq,
  WorkspaceGitMessageResult,
  TaskListReq,
  AgentWakeReq,
  AgentWakeOk,
  TaskList,
  MemoryChannelsReq,
  MemoryChannelsPage,
  MemoryListReq,
  MemoryListPage,
  MemoryReadReq,
  MemoryReadContent,
  MemoryWriteReq,
  MemoryWriteOk,
  MemoryHistoryReq,
  MemoryHistoryPage,
  MemorySurfaceReq,
  MemorySurfaceInfo,
  MemoryRecordSearchReq,
  MemoryRecordSearchPage,
  MemoryRecordListReq,
  MemoryRecordListPage,
  MemoryRecordGetReq,
  MemoryRecordGetResult,
  MemoryRecordCreateReq,
  MemoryRecordCreateResult,
  MemoryRecordUpdateReq,
  MemoryRecordUpdateResult,
  MemoryRecordDeleteReq,
  MemoryRecordDeleteResult,
  MemoryRecordHistoryReq,
  MemoryRecordHistoryPage,
  DreamStartReq,
  DreamCancelReq,
  DreamListReq,
  DreamListPage,
  DreamGetReq,
  DreamAdoptReq,
  DreamDiscardReq,
  DreamFilesReq,
  DreamFilesPage,
  DreamFileReadReq,
  DreamFileReadContent,
  DreamSkillReviewReq,
  DreamSkillReadReq,
  LocalSkillsReq,
  LocalSkillsList,
  RuntimeCommandsReq,
  RuntimeCommandsList,
  DreamSkillContent,
  OrganizationSuggestionReadReq,
  OrganizationSuggestionChunk,
  OrganizationSuggestionContent,
  OrganizationSuggestionReviewReq,
  DreamState,
  RelayRosterEntry,
  CollabRoutesSnapshot,
  AgentPermissionRequestList,
  AgentPermissionRequestPage,
  AgentPermissionDecision,
  SessionVisibilityPush,
  SessionVisibilityOk,
  CodeHostNoteDesired
} from '@agentconnect.md/protocol'
import {
  MAX_ORGANIZATION_SUGGESTION_BODY_BYTES,
  ORGANIZATION_SUGGESTION_CHUNK_BYTES,
  OrganizationSuggestionContentBody,
  WORKSPACE_GIT_MESSAGE_BUDGET_MS,
  organizationSuggestionCanonical
} from '@agentconnect.md/protocol'
import type { LaunchRepo } from '../persistence/ports.js'
import { ConnectionClosed, type ConnectionRegistry, type DaemonConnState } from '../ws/registry.js'
import { AgentId, DaemonId, LaunchId } from '../domain/ids.js'
import { ProtocolError } from '../domain/errors.js'

// Workspace reconciliation may clone a repository and warm a cold ACP host.
// Keep the ordinary control timeout short while giving this destructive,
// idempotent operation enough time to return its acknowledgement.
const COLD_ACTIVATE_ACK_TIMEOUT_MS = 60_000
const COLD_ACTIVATE_MAX_TRIES = 5
const COLD_ACTIVATE_MAX_CONNECTIONS = 5

/** Raised when no live/READY connection exists for a daemon. */
export class NoConnection extends Error {
  constructor(readonly daemonId: string) {
    super(`no live connection for daemon ${daemonId}`)
    this.name = 'NoConnection'
  }
}

function decodeCanonicalBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ProtocolError('BAD_PAYLOAD', 'daemon returned non-canonical suggestion content')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) {
    throw new ProtocolError('BAD_PAYLOAD', 'daemon returned non-canonical suggestion content')
  }
  return decoded
}

/** The classified outcome of a lifecycle command send (see {@link ControlSender.daemonRestart}). */
export type LifecycleSendResult =
  | { kind: 'acked'; epoch: number; ack: DaemonControlAck }
  | { kind: 'rejected'; epoch: number; code: string; message: string }
  | { kind: 'ambiguous'; epoch: number; message: string }
  | { kind: 'unsent' }

export class ControlSender {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly launches: LaunchRepo
  ) {}

  /** The live connection state for a daemon, or throw {@link NoConnection}. */
  private must(daemonId: string): DaemonConnState {
    const c = this.registry.get(daemonId)
    if (!c) throw new NoConnection(daemonId)
    return c
  }

  /**
   * Fan the relay roster to EVERY connected daemon (`relay/roster` EVT,
   * shared-bot-relay.md §5). Fire-and-forget, best-effort: a dead socket's error
   * is swallowed (its close will drop it from the registry). Epoch-stamped per
   * connection like every other C→D frame. The roster is daemon-wide, not
   * agent-scoped, so no launchId fence.
   */
  broadcastRelayRoster(relays: RelayRosterEntry[]): void {
    for (const s of this.registry.reachableDaemons()) {
      try {
        s.conn.send('relay/roster', { relays }, { epoch: s.sessionEpoch })
      } catch {
        // dead socket — its close handler removes the registry entry
      }
    }
  }

  /**
   * Push whitelisted non-secret config keys to a connected daemon (`config/push`
   * EVT). Fire-and-forget: the daemon merges them into its running config
   * (`mergeConfigPush` whitelist) without persisting; a durable setting must also
   * ride the `register/ok` snapshot, which is the reconnect backstop for a push
   * the daemon never saw. Throws {@link NoConnection} when the daemon is offline.
   */
  configPush(daemonId: string, keys: Record<string, unknown>): void {
    const c = this.must(daemonId)
    c.conn.send('config/push', { keys }, { epoch: c.sessionEpoch })
  }

  /** Assign a session to a daemon (epoch-fenced REQ → ack). */
  async routeAssign(daemonId: string, a: RouteAssign): Promise<RouteAssignAck> {
    const c = this.must(daemonId)
    return c.conn.request<RouteAssignAck>('route/assign', a, { epoch: c.sessionEpoch })
  }

  /**
   * Bring up an agent (epoch-fenced REQ → `agent/launched`). Records the new
   * `launchId` fence baseline in C6 and the live index.
   */
  async agentLaunch(daemonId: string, l: AgentLaunch): Promise<AgentLaunched> {
    const c = this.must(daemonId)
    const r = await c.conn.request<AgentLaunched>('agent/launch', l, { epoch: c.sessionEpoch })
    await this.launches.record({
      launchId: LaunchId(r.launchId),
      agentId: AgentId(l.agentId),
      daemonId: DaemonId(daemonId),
      runtime: r.runtime,
      ...(r.acpSessionId ? { acpSessionId: r.acpSessionId } : {}),
      epoch: BigInt(c.sessionEpoch)
    })
    c.launches.set(l.agentId, {
      launchId: r.launchId,
      runtime: r.runtime,
      ...(r.acpSessionId ? { acpSessionId: r.acpSessionId } : {})
    })
    return r
  }

  /** Drain a scope on a daemon (epoch-fenced REQ → `drain/done`). */
  async drain(daemonId: string, scope: Drain['scope'], deadline: string): Promise<DrainDone> {
    const c = this.must(daemonId)
    c.state = 'DRAINING'
    return c.conn.request<DrainDone>('daemon/drain', { scope, deadline }, { epoch: c.sessionEpoch })
  }

  /** Command a daemon to drain + exit so its supervisor relaunches it
   *  (cli-daemon-split.md §7); `daemonUpgrade` installs the target first (§7.1). */
  async daemonRestart(daemonId: string, req: DaemonRestart): Promise<LifecycleSendResult> {
    return this.sendLifecycle(daemonId, 'daemon/restart', req)
  }
  async daemonUpgrade(daemonId: string, req: DaemonUpgrade): Promise<LifecycleSendResult> {
    return this.sendLifecycle(daemonId, 'daemon/upgrade', req)
  }

  /**
   * Send a lifecycle REQ and classify the outcome for the caller's audit. This NEVER
   * conflates a definite negative with an ambiguous transport loss (cli-daemon-split.md §7):
   *  - `unsent`     — pre-dispatch {@link NoConnection}; the frame was never queued.
   *  - `rejected`   — a correlated daemon `error` frame (a `ProtocolError` with a domain code
   *                   like `PROTOCOL_STATE`/`STALE_EPOCH`): the daemon refused; it did NOT run.
   *  - `ambiguous`  — a timeout / no-ack (`ProtocolError` code `INTERNAL`) or any other
   *                   error: no correlated reply, so delivery is UNKNOWN (the daemon may
   *                   already be draining) — the caller must keep the op resolvable.
   *  - `acked`      — a reply arrived (`accepted` true or false).
   * The LIVE connection's `epoch` (the epoch the frame actually rode) is carried on every
   * outcome except `unsent`, so the caller fences settlement on a strictly-later re-auth.
   */
  private async sendLifecycle(
    daemonId: string,
    type: 'daemon/restart' | 'daemon/upgrade',
    req: DaemonRestart | DaemonUpgrade
  ): Promise<LifecycleSendResult> {
    let c: DaemonConnState
    try {
      c = this.must(daemonId)
    } catch (err) {
      if (err instanceof NoConnection) return { kind: 'unsent' }
      throw err
    }
    const epoch = c.sessionEpoch
    try {
      // maxTries:1 — these controls are NON-IDEMPOTENT (the daemon has no request-id reply
      // cache). A retransmit after the first copy started draining would get
      // `accepted:false` ("already in progress") and be mis-read as a decline. So we never
      // retransmit: a lost ACK becomes a single timeout → the `ambiguous` outcome, which the
      // caller keeps resolvable. A generous ack window covers a momentarily-slow reply.
      const ack = await c.conn.request<DaemonControlAck>(type, req, { epoch }, { maxTries: 1, ackTimeoutMs: 15_000 })
      return { kind: 'acked', epoch, ack }
    } catch (err) {
      if (err instanceof ProtocolError && err.code !== 'INTERNAL') {
        return { kind: 'rejected', epoch, code: err.code, message: err.message }
      }
      return { kind: 'ambiguous', epoch, message: err instanceof Error ? err.message : String(err) }
    }
  }

  // The agent-lifecycle frames below take an explicit orgId: on an install-wide
  // (frame-mode) member the connection carries no org, and a payload like
  // `{agentId, moveId}` for an agent the member has never installed cannot be
  // resolved from the connection's org maps either — the send would throw
  // SCOPE_DENIED before the frame ever left the process.

  /** Push an edited agent spec and wait until the daemon's live reconcile applies it. */
  async agentUpsert(daemonId: string, u: AgentUpsert, orgId?: string): Promise<void> {
    const c = this.must(daemonId)
    const ack = await c.conn.request<Ack>(
      'agent/upsert',
      u,
      { epoch: c.sessionEpoch, agentId: u.agentId },
      undefined,
      orgId
    )
    if (!ack.ok) throw new Error(`agent upsert rejected${ack.reason ? `: ${ack.reason}` : ''}`)
  }

  /** Tell a running daemon an agent was deleted (live CRUD, epoch-fenced EVT). */
  async agentRemove(daemonId: string, r: AgentRemove, orgId?: string): Promise<void> {
    const c = this.must(daemonId)
    c.conn.send('agent/remove', r, { epoch: c.sessionEpoch, agentId: r.agentId }, orgId)
  }

  /**
   * Hand one desired run-projection generation to its owning daemon (§16 EVT).
   *
   * Fire-and-forget by design: the daemon is the only provider writer, and its authoritative answer
   * is the `codehost/note-result` frame, not a transport ack. The §17.3 feature gate is the caller's
   * — an offline or non-advertising daemon must leave the row pending, never raise.
   */
  codeHostNoteDesired(daemonId: string, desired: CodeHostNoteDesired, orgId?: string): void {
    const c = this.must(daemonId)
    c.conn.send('codehost/note-desired', desired, { epoch: c.sessionEpoch, agentId: desired.agentId }, orgId)
  }

  /** Fence and archive an agent before a daemon move or workspace edit (REQ → ack). */
  async agentDetach(daemonId: string, d: AgentDetach, orgId?: string): Promise<Ack> {
    const c = this.must(daemonId)
    return c.conn.request<Ack>('agent/detach', d, { epoch: c.sessionEpoch, agentId: d.agentId }, undefined, orgId)
  }

  /** Activate a fully bootstrapped/restored agent after a daemon move (REQ → ack). */
  async agentActivate(daemonId: string, a: AgentActivate, orgId?: string): Promise<Ack> {
    let c = await this.activationConnection(daemonId)
    for (let connectionTry = 1; ; connectionTry += 1) {
      // §17.3/§24.4 at the SEND, against the connection actually selected — and again
      // after every reconnect retry, because a re-registered daemon may have come back
      // with different advertised features. The activate bundle carries the complete
      // spec, so a gitlab-shaped workspace or a self-managed host would be frame-fatal
      // or silently mis-hosted on a target that has not advertised the feature.
      if (!daemonSupportsAgent(a.spec, c.capabilities?.features)) {
        throw new Error(`daemon ${daemonId} lacks a feature required by agent ${a.agentId}'s spec`)
      }
      try {
        return await c.conn.request<Ack>(
          'agent/activate',
          a,
          { epoch: c.sessionEpoch, agentId: a.agentId },
          { ackTimeoutMs: COLD_ACTIVATE_ACK_TIMEOUT_MS, maxTries: COLD_ACTIVATE_MAX_TRIES },
          orgId
        )
      } catch (err) {
        if (!(err instanceof ConnectionClosed) || connectionTry >= COLD_ACTIVATE_MAX_CONNECTIONS) throw err
        c = await this.registry.waitForReadyAfter(
          daemonId,
          c.sessionEpoch,
          AbortSignal.timeout(COLD_ACTIVATE_ACK_TIMEOUT_MS)
        )
      }
    }
  }

  private async activationConnection(daemonId: string): Promise<DaemonConnState> {
    const current = this.registry.get(daemonId)
    if (current?.state === 'READY' || current?.state === 'DRAINING') return current
    return this.registry.waitForReadyAfter(
      daemonId,
      Math.max(0, (current?.sessionEpoch ?? 1) - 1),
      AbortSignal.timeout(COLD_ACTIVATE_ACK_TIMEOUT_MS)
    )
  }

  /** Pull the bounded approval queue directly from the owning daemon. */
  async agentPermissionRequests(
    daemonId: string,
    req: AgentPermissionRequestList
  ): Promise<AgentPermissionRequestPage> {
    const c = this.must(daemonId)
    return c.conn.request<AgentPermissionRequestPage>('agent/permission-requests', req, {
      epoch: c.sessionEpoch,
      agentId: req.agentId
    })
  }

  /** Resolve a live ACP approval request on the owning daemon. */
  async agentPermissionDecision(daemonId: string, req: AgentPermissionDecision): Promise<Ack> {
    const c = this.must(daemonId)
    return c.conn.request<Ack>('agent/permission-decision', req, {
      epoch: c.sessionEpoch,
      agentId: req.agentId
    })
  }

  /** Full-replace one daemon's bot-agnostic collaboration routing snapshot. */
  async collaborationRoutes(daemonId: string, snapshot: CollabRoutesSnapshot): Promise<void> {
    const c = this.must(daemonId)
    c.conn.send('collaboration/routes', snapshot, { epoch: c.sessionEpoch })
  }

  /**
   * Install/update a platform integration on the owning agent's daemon (live,
   * epoch-fenced EVT). Token-bearing payload — NEVER log it.
   */
  async integrationUpsert(daemonId: string, u: IntegrationUpsert): Promise<void> {
    const c = this.must(daemonId)
    c.conn.send('integration/upsert', u, { epoch: c.sessionEpoch, agentId: u.agentId })
  }

  /** Tell a running daemon an integration was removed (live, epoch-fenced EVT).
   *  Takes an explicit orgId for the same reason the agent frames do: the payload
   *  is an id alone, so an install-wide connection has nothing to resolve the org
   *  from — and a duty holder that acquired the integration through `duty/fetch`
   *  never registered it, so the connection's id→org map has nothing either. */
  async integrationRemove(daemonId: string, r: IntegrationRemove, orgId?: string): Promise<void> {
    const c = this.must(daemonId)
    c.conn.send('integration/remove', r, { epoch: c.sessionEpoch }, orgId)
  }

  /** Tell a daemon to stop REPORTING conversations an operator forgot (REQ → ack).
   *  Without it the daemon's next observed refresh pushes them straight back: that set
   *  is derived from session history, which knows nothing about a row being removed —
   *  so this is awaited, and an undeliverable suppression is the caller's problem to
   *  surface rather than a silent future resurrection. */
  async integrationForget(daemonId: string, f: IntegrationForget): Promise<Ack> {
    const c = this.must(daemonId)
    return c.conn.request<Ack>('integration/forget', f, { epoch: c.sessionEpoch })
  }

  /** Ask a daemon to withdraw the bot from a conversation/space at the PLATFORM
   *  (REQ → verdict). Unlike its EVT siblings this one is awaited: it changes the
   *  outside world, and the operator is shown what the platform actually said. */
  async integrationLeave(daemonId: string, l: IntegrationLeave): Promise<IntegrationLeaveOk> {
    const c = this.must(daemonId)
    return c.conn.request<IntegrationLeaveOk>('integration/leave', l, { epoch: c.sessionEpoch })
  }

  /**
   * Push a proxied MCP server def to a daemon whose agents enabled it (live CRUD,
   * epoch-fenced EVT). Daemon-wide def map (no agentId fence). The spec carries the
   * relay proxy URL + the plaintext grant key — NEVER log it.
   */
  async mcpServerUpsert(daemonId: string, spec: McpServerSpec): Promise<void> {
    const c = this.must(daemonId)
    c.conn.send('mcpserver/upsert', spec, { epoch: c.sessionEpoch })
  }

  /** Drop a proxied MCP server def by name from a daemon (live CRUD, epoch-fenced EVT). */
  async mcpServerRemove(daemonId: string, orgId: string, name: string): Promise<void> {
    const c = this.must(daemonId)
    c.conn.send('mcpserver/remove', { orgId, name }, { epoch: c.sessionEpoch })
  }

  /** Push one daemon-private external-memory connection definition. Relay grants
   * and local secret leases are secret-bearing; never log. */
  async memoryConnectionUpsert(daemonId: string, spec: MemoryConnectionSpec): Promise<void> {
    const c = this.must(daemonId)
    const ack = await c.conn.request<Ack>('memoryconnection/upsert', spec, { epoch: c.sessionEpoch })
    if (!ack.ok) throw new Error(`memory connection probe rejected${ack.reason ? `: ${ack.reason}` : ''}`)
  }

  /** Drop a daemon-private connection definition no placed agent references. */
  async memoryConnectionRemove(daemonId: string, connectionId: string): Promise<void> {
    const c = this.must(daemonId)
    c.conn.send('memoryconnection/remove', { connectionId }, { epoch: c.sessionEpoch })
  }

  /**
   * Push one session's effective capture gate (session-visibility.md §5.1).
   *
   * A single privacy bit + its revision — control signaling, never content. The
   * revision (not the epoch) is what orders competing pushes, so retransmits and
   * out-of-order delivery are safe: the daemon acks a stale revision
   * `superseded` rather than erroring, and the register-time snapshot converges
   * anything this connection never delivered.
   */
  async sessionVisibility(daemonId: string, orgId: string, p: SessionVisibilityPush): Promise<SessionVisibilityOk> {
    const c = this.must(daemonId)
    return c.conn.request<SessionVisibilityOk>('session/visibility', p, { epoch: c.sessionEpoch }, undefined, orgId)
  }

  /** Replay the whole gate set to a (re)connecting daemon (§5.1) — a snapshot,
   *  not a diff, so a change made while it was offline cannot stay unapplied. */
  async sessionVisibilitySnapshot(daemonId: string, orgId: string, entries: SessionVisibilityPush[]): Promise<Ack> {
    const c = this.must(daemonId)
    return c.conn.request<Ack>('session/visibility/snapshot', { entries }, { epoch: c.sessionEpoch }, undefined, orgId)
  }

  /** Sink a cron def to a running daemon (live CRUD, epoch-fenced REQ → ack, §5.4). */
  async cronUpsert(daemonId: string, u: CronUpsert): Promise<Ack> {
    const c = this.must(daemonId)
    return c.conn.request<Ack>('cron/upsert', u, { epoch: c.sessionEpoch })
  }

  /** Remove a cron from a running daemon (live CRUD, epoch-fenced REQ → ack, §5.4).
   *  Explicit orgId for the same reason as `integrationRemove`: the payload is a
   *  bare cronId, and a duty holder never registered the cron. */
  async cronRemove(daemonId: string, r: CronRemove, orgId?: string): Promise<Ack> {
    const c = this.must(daemonId)
    return c.conn.request<Ack>('cron/remove', r, { epoch: c.sessionEpoch }, undefined, orgId)
  }

  /** Fire a cron immediately on its daemon (console "Run now"; REQ → ack — the
   *  ack only confirms the daemon holds the cron; outcome arrives via cron/report). */
  async cronRun(daemonId: string, r: CronRunNow): Promise<Ack> {
    const c = this.must(daemonId)
    return c.conn.request<Ack>('cron/run', r, { epoch: c.sessionEpoch })
  }

  /** Read a daemon's local session projection (REQ → `session/list/page`).
   * Read-only; current console list is served from CP-stored metadata snapshots,
   * while this frame remains useful for daemon read-back/debugging. */
  async sessionList(daemonId: string, req: SessionListReq): Promise<SessionListPage> {
    const c = this.must(daemonId)
    return c.conn.request<SessionListPage>('session/list', req, { epoch: c.sessionEpoch })
  }

  /**
   * Pull one page of a session's history from a daemon holding it for the console
   * (REQ → `session/history/page`). Read-only — the CP proxies the bodies to the
   * UI live and never stores them (body-locality, §1/§12).
   *
   * Explicit orgId, for the same reason the agent frames take one: an install-wide pool
   * member resolves an org from `orgByAgent`, which holds only the agents that connection
   * was told about, and a shared-store peer answering for a retired member was told about
   * none of them — so a bare agent id is SCOPE_DENIED before the frame leaves the CP.
   */
  async sessionHistory(daemonId: string, orgId: string, req: SessionHistoryReq): Promise<SessionHistoryPage> {
    const c = this.must(daemonId)
    return c.conn.request<SessionHistoryPage>('session/history', req, { epoch: c.sessionEpoch }, undefined, orgId)
  }

  /**
   * Fetch one frame-budgeted byte slice of a tool call's FULL ToolBody JSON from a
   * daemon holding the session (REQ → `session/tool-body/chunk`), with an explicit org for
   * the same scoping reason as {@link ControlSender.sessionHistory}. Read-only
   * — the CP proxies the bytes to the UI live and never stores them (body-locality,
   * §1/§12). The console pages by `offset` until `nextOffset` is absent, then
   * concatenates and JSON.parses the assembled string.
   */
  async sessionToolBody(daemonId: string, orgId: string, req: SessionToolBodyReq): Promise<SessionToolBodyChunk> {
    const c = this.must(daemonId)
    return c.conn.request<SessionToolBodyChunk>('session/tool-body', req, { epoch: c.sessionEpoch }, undefined, orgId)
  }

  /**
   * List one page of a directory in an agent's workspace from the owning daemon
   * for the console (REQ → `workspace/list/page`). Read-only — the CP proxies
   * the entries to the UI live and never stores them (body-locality, §1/§12).
   */
  async workspaceList(daemonId: string, req: WorkspaceListReq): Promise<WorkspaceListPage> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceListPage>('workspace/list', req, { epoch: c.sessionEpoch })
  }

  /**
   * Read one byte slice of a workspace file from the owning daemon for the
   * console (REQ → `workspace/read/content`). Read-only — the CP proxies the
   * bytes to the UI live and never stores them (body-locality, §1/§12).
   */
  async workspaceRead(daemonId: string, req: WorkspaceReadReq): Promise<WorkspaceReadContent> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceReadContent>('workspace/read', req, { epoch: c.sessionEpoch })
  }

  /** Create or replace one scratch-workspace text file on the owning daemon. */
  async workspaceWrite(daemonId: string, req: WorkspaceWriteReq): Promise<WorkspaceWriteOk> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceWriteOk>('workspace/write', req, { epoch: c.sessionEpoch })
  }

  /** Delete one unchanged scratch-workspace file on the owning daemon. */
  async workspaceDelete(daemonId: string, req: WorkspaceDeleteReq): Promise<WorkspaceDeleteOk> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceDeleteOk>('workspace/delete', req, { epoch: c.sessionEpoch })
  }

  /**
   * List the files in an agent's memory dir from the owning daemon for the console
   * (REQ → `memory/list/page`). Read-only — the CP proxies the listing live and
   * never stores it (body-locality, §1/§12).
   */
  async memoryList(daemonId: string, req: MemoryListReq): Promise<MemoryListPage> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryListPage>('memory/list', req, { epoch: c.sessionEpoch })
  }

  /**
   * List the channels that have a memory folder for a channel-scoped agent, for the
   * console channel selector (REQ → `memory/channels/page`). Read-only proxy.
   */
  async memoryChannels(daemonId: string, req: MemoryChannelsReq): Promise<MemoryChannelsPage> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryChannelsPage>('memory/channels', req, { epoch: c.sessionEpoch })
  }

  /**
   * Read one byte slice of an agent's memory file from the owning daemon for the
   * console (REQ → `memory/read/content`). Read-only — the CP proxies the bytes to
   * the UI live and never stores them (body-locality, §1/§12).
   */
  async memoryRead(daemonId: string, req: MemoryReadReq): Promise<MemoryReadContent> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryReadContent>('memory/read', req, { epoch: c.sessionEpoch })
  }

  /**
   * Replace an agent's memory file from the console (REQ → `memory/write/ok`). The
   * new content is written on the daemon; the CP stores nothing.
   */
  async memoryWrite(daemonId: string, req: MemoryWriteReq): Promise<MemoryWriteOk> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryWriteOk>('memory/write', req, { epoch: c.sessionEpoch })
  }

  /** Page a managed memory file's provenance log without persisting its bodies. */
  async memoryHistory(daemonId: string, req: MemoryHistoryReq): Promise<MemoryHistoryPage> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryHistoryPage>('memory/history', req, { epoch: c.sessionEpoch })
  }

  /** Discover the provider-neutral memory administration shape/capabilities. */
  async memorySurface(daemonId: string, req: MemorySurfaceReq): Promise<MemorySurfaceInfo> {
    const c = this.must(daemonId)
    return c.conn.request<MemorySurfaceInfo>('memory/surface', req, { epoch: c.sessionEpoch })
  }

  async memoryRecordSearch(daemonId: string, req: MemoryRecordSearchReq): Promise<MemoryRecordSearchPage> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryRecordSearchPage>('memory/record/search', req, { epoch: c.sessionEpoch })
  }

  async memoryRecordList(daemonId: string, req: MemoryRecordListReq): Promise<MemoryRecordListPage> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryRecordListPage>('memory/record/list', req, { epoch: c.sessionEpoch })
  }

  async memoryRecordGet(daemonId: string, req: MemoryRecordGetReq): Promise<MemoryRecordGetResult> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryRecordGetResult>('memory/record/get', req, { epoch: c.sessionEpoch })
  }

  async memoryRecordCreate(daemonId: string, req: MemoryRecordCreateReq): Promise<MemoryRecordCreateResult> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryRecordCreateResult>('memory/record/create', req, { epoch: c.sessionEpoch })
  }

  async memoryRecordUpdate(daemonId: string, req: MemoryRecordUpdateReq): Promise<MemoryRecordUpdateResult> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryRecordUpdateResult>('memory/record/update', req, { epoch: c.sessionEpoch })
  }

  async memoryRecordDelete(daemonId: string, req: MemoryRecordDeleteReq): Promise<MemoryRecordDeleteResult> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryRecordDeleteResult>('memory/record/delete', req, { epoch: c.sessionEpoch })
  }

  async memoryRecordHistory(daemonId: string, req: MemoryRecordHistoryReq): Promise<MemoryRecordHistoryPage> {
    const c = this.must(daemonId)
    return c.conn.request<MemoryRecordHistoryPage>('memory/record/history', req, { epoch: c.sessionEpoch })
  }

  // ── memory dreaming (docs/designs/memory-dreaming.md §10) — the CP relays the
  //    dream lifecycle + staged-output review to the owning daemon and persists
  //    nothing (offline metadata caching is deferred). Staged bodies ride
  //    byte-sliced correlated replies, exactly like memory/read.

  async dreamStart(daemonId: string, req: DreamStartReq): Promise<DreamState> {
    const c = this.must(daemonId)
    return c.conn.request<DreamState>('memory/dream/start', req, { epoch: c.sessionEpoch })
  }

  async dreamCancel(daemonId: string, req: DreamCancelReq): Promise<DreamState> {
    const c = this.must(daemonId)
    return c.conn.request<DreamState>('memory/dream/cancel', req, { epoch: c.sessionEpoch })
  }

  async dreamList(daemonId: string, req: DreamListReq): Promise<DreamListPage> {
    const c = this.must(daemonId)
    return c.conn.request<DreamListPage>('memory/dream/list', req, { epoch: c.sessionEpoch })
  }

  async dreamGet(daemonId: string, req: DreamGetReq): Promise<DreamState> {
    const c = this.must(daemonId)
    return c.conn.request<DreamState>('memory/dream/get', req, { epoch: c.sessionEpoch })
  }

  async dreamAdopt(daemonId: string, req: DreamAdoptReq): Promise<DreamState> {
    const c = this.must(daemonId)
    return c.conn.request<DreamState>('memory/dream/adopt', req, { epoch: c.sessionEpoch })
  }

  async dreamDiscard(daemonId: string, req: DreamDiscardReq): Promise<DreamState> {
    const c = this.must(daemonId)
    return c.conn.request<DreamState>('memory/dream/discard', req, { epoch: c.sessionEpoch })
  }

  async dreamFiles(daemonId: string, req: DreamFilesReq): Promise<DreamFilesPage> {
    const c = this.must(daemonId)
    return c.conn.request<DreamFilesPage>('memory/dream/files', req, { epoch: c.sessionEpoch })
  }

  /** Full staged body of one candidate, so a reviewer sees what accepting installs. */
  async dreamSkillRead(daemonId: string, req: DreamSkillReadReq): Promise<DreamSkillContent> {
    const c = this.must(daemonId)
    return c.conn.request<DreamSkillContent>('memory/dream/skill/read', req, { epoch: c.sessionEpoch })
  }

  /** Read-only inventory of the skills an agent's workspace can load, tagged by origin. */
  async listLocalSkills(daemonId: string, req: LocalSkillsReq): Promise<LocalSkillsList> {
    const c = this.must(daemonId)
    return c.conn.request<LocalSkillsList>('skills/local', req, { epoch: c.sessionEpoch })
  }

  /** The slash commands the agent's runtime advertised over ACP — what it can be asked to run. */
  async listRuntimeCommands(daemonId: string, req: RuntimeCommandsReq): Promise<RuntimeCommandsList> {
    const c = this.must(daemonId)
    return c.conn.request<RuntimeCommandsList>('runtime/commands', req, { epoch: c.sessionEpoch })
  }

  /** Accept one mined skill candidate — installs it for the agent (design §7). */
  async dreamSkillAccept(daemonId: string, req: DreamSkillReviewReq): Promise<DreamState> {
    const c = this.must(daemonId)
    return c.conn.request<DreamState>('memory/dream/skill/accept', req, { epoch: c.sessionEpoch })
  }

  /** Dismiss one mined skill candidate — drops its staging, records the decision. */
  async dreamSkillDismiss(daemonId: string, req: DreamSkillReviewReq): Promise<DreamState> {
    const c = this.must(daemonId)
    return c.conn.request<DreamState>('memory/dream/skill/dismiss', req, { epoch: c.sessionEpoch })
  }

  async dreamFileRead(daemonId: string, req: DreamFileReadReq): Promise<DreamFileReadContent> {
    const c = this.must(daemonId)
    return c.conn.request<DreamFileReadContent>('memory/dream/file/read', req, { epoch: c.sessionEpoch })
  }

  // ── organization Knowledge suggestion bodies (daemon-local until review) ──

  async organizationSuggestionRead(
    daemonId: string,
    req: Omit<OrganizationSuggestionReadReq, 'offset' | 'limit'>,
    orgId?: string
  ): Promise<OrganizationSuggestionContent> {
    const c = this.must(daemonId)
    const chunks: Buffer[] = []
    let offset = 0
    let size: number | undefined
    let digest: string | undefined
    while (size === undefined || offset < size) {
      const chunk = await c.conn.request<OrganizationSuggestionChunk>(
        'knowledge/suggestion/read',
        { ...req, offset, limit: ORGANIZATION_SUGGESTION_CHUNK_BYTES },
        { epoch: c.sessionEpoch },
        undefined,
        orgId
      )
      if (
        chunk.sourceAgentId !== req.sourceAgentId ||
        chunk.dreamId !== req.dreamId ||
        chunk.candidateId !== req.candidateId
      ) {
        throw new ProtocolError('BAD_PAYLOAD', 'daemon returned mismatched suggestion identity')
      }
      if (!chunk.exists) {
        if (offset !== 0) throw new ProtocolError('BAD_PAYLOAD', 'suggestion disappeared during content read')
        return {
          sourceAgentId: req.sourceAgentId,
          dreamId: req.dreamId,
          candidateId: req.candidateId,
          digest: chunk.digest,
          exists: false
        }
      }
      if (
        chunk.offset !== offset ||
        chunk.size > MAX_ORGANIZATION_SUGGESTION_BODY_BYTES ||
        (size !== undefined && chunk.size !== size) ||
        (digest !== undefined && chunk.digest !== digest)
      ) {
        throw new ProtocolError('BAD_PAYLOAD', 'daemon returned mismatched suggestion chunk metadata')
      }
      size ??= chunk.size
      digest ??= chunk.digest
      const bytes = decodeCanonicalBase64(chunk.data)
      if (
        bytes.byteLength > ORGANIZATION_SUGGESTION_CHUNK_BYTES ||
        chunk.nextOffset !== offset + bytes.byteLength ||
        chunk.nextOffset > size ||
        chunk.truncated !== chunk.nextOffset < size ||
        (offset < size && bytes.byteLength === 0)
      ) {
        throw new ProtocolError('BAD_PAYLOAD', 'daemon returned an invalid suggestion content chunk')
      }
      chunks.push(bytes)
      offset = chunk.nextOffset
    }
    const raw = Buffer.concat(chunks)
    if (raw.byteLength !== size || digest === undefined) {
      throw new ProtocolError('BAD_PAYLOAD', 'daemon returned an incomplete suggestion body')
    }
    let json: unknown
    try {
      json = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new ProtocolError('BAD_PAYLOAD', 'daemon returned malformed suggestion JSON')
    }
    const body = OrganizationSuggestionContentBody.safeParse(json)
    if (!body.success) throw new ProtocolError('BAD_PAYLOAD', 'daemon returned an invalid suggestion body')
    const actualDigest = `sha256:${createHash('sha256')
      .update(organizationSuggestionCanonical(body.data))
      .digest('hex')}`
    if (actualDigest !== digest) {
      throw new ProtocolError('BAD_PAYLOAD', 'daemon returned suggestion content with a mismatched digest')
    }
    return {
      sourceAgentId: req.sourceAgentId,
      dreamId: req.dreamId,
      candidateId: req.candidateId,
      digest,
      exists: true,
      body: body.data
    }
  }

  /** `orgId` is explicit: an install-wide holder resolves no org from a bare source-agent id. */
  async organizationSuggestionReview(
    daemonId: string,
    req: OrganizationSuggestionReviewReq,
    orgId?: string
  ): Promise<Ack> {
    const c = this.must(daemonId)
    return c.conn.request<Ack>('knowledge/suggestion/review', req, { epoch: c.sessionEpoch }, undefined, orgId)
  }

  /**
   * Report `git status` of an agent's git-repo workspace from the owning daemon
   * for the console (REQ → `workspace/gitstatus/result`). Read-only — a dirty or
   * non-repo workspace is DATA, not an error.
   */
  async workspaceGitStatus(daemonId: string, req: WorkspaceGitStatusReq): Promise<WorkspaceGitStatus> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceGitStatus>('workspace/gitstatus', req, { epoch: c.sessionEpoch })
  }

  /**
   * Read the unified diff of ONE workspace path from the owning daemon for the
   * console (REQ → `workspace/gitdiff/result`). Read-only — the CP proxies the
   * diff text to the UI live and never stores it (body-locality, §1/§12). A
   * binary path, an unchanged path and a non-repo workspace are all DATA.
   */
  async workspaceGitDiff(daemonId: string, req: WorkspaceGitDiffReq): Promise<WorkspaceGitDiffResult> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceGitDiffResult>('workspace/gitdiff', req, { epoch: c.sessionEpoch })
  }

  /**
   * Read the newest commits of an agent's checked-out branch from the owning
   * daemon for the console (REQ → `workspace/gitlog/result`). Read-only — an
   * empty repo comes back as `commits: []` (DATA), not an error.
   */
  async workspaceGitLog(daemonId: string, req: WorkspaceGitLogReq): Promise<WorkspaceGitLog> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceGitLog>('workspace/gitlog', req, { epoch: c.sessionEpoch })
  }

  /**
   * Force an on-demand fast-forward `git pull` in an agent's git-repo workspace
   * on the owning daemon (REQ → `workspace/gitpull/result`). A pull that can't
   * fast-forward comes back as `ok:false` (DATA), not an error frame.
   */
  async workspaceGitPull(daemonId: string, req: WorkspaceGitPullReq): Promise<WorkspaceGitPullResult> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceGitPullResult>('workspace/gitpull', req, { epoch: c.sessionEpoch })
  }

  /**
   * Stage exactly these paths in an agent's checkout (or an authorized session
   * worktree) on the owning daemon (REQ → `workspace/gitstage/result`). The REP is
   * the FRESH `WorkspaceGitStatus`, so the console never re-polls for the result of
   * its own action. An empty list, a path that is not currently changed and a
   * non-repo workspace are all DATA.
   */
  async workspaceGitStage(daemonId: string, req: WorkspaceGitStageReq): Promise<WorkspaceGitStatus> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceGitStatus>('workspace/gitstage', req, { epoch: c.sessionEpoch })
  }

  /** Unstage exactly these paths (REQ → `workspace/gitunstage/result`), answering with
   *  the fresh status like {@link workspaceGitStage}. */
  async workspaceGitUnstage(daemonId: string, req: WorkspaceGitStageReq): Promise<WorkspaceGitStatus> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceGitStatus>('workspace/gitunstage', req, { epoch: c.sessionEpoch })
  }

  /**
   * Commit the staged changes of an agent's checkout on the owning daemon (REQ →
   * `workspace/gitcommit/result`), attributed to the daemon's registered
   * `gitCommitIdentity`. Nothing staged, a blank message, no registered identity and
   * a git refusal all come back as `ok:false` + `reason` (DATA), not an error frame.
   * The CP forwards the message and stores none of it.
   */
  async workspaceGitCommit(daemonId: string, req: WorkspaceGitCommitReq): Promise<WorkspaceGitCommitResult> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceGitCommitResult>('workspace/gitcommit', req, { epoch: c.sessionEpoch })
  }

  /**
   * Push the checked-out branch to the daemon-authorized remote (REQ →
   * `workspace/gitpush/result`). The daemon derives the refspec and never forces, so
   * a diverged branch, a detached HEAD, a branch with no upstream and a remote
   * rejection are all `ok:false` + `reason` (DATA), not error frames.
   */
  async workspaceGitPush(daemonId: string, req: WorkspaceGitPushReq): Promise<WorkspaceGitPushResult> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceGitPushResult>('workspace/gitpush', req, { epoch: c.sessionEpoch })
  }

  /**
   * Draft a commit message from the staged diff on the owning daemon, using the AGENT's own
   * runtime (REQ → `workspace/gitmessage/result`). The CP is never on the inference path
   * (webchat-side-panels.md §2) — it forwards a press and proxies the answer, storing nothing.
   * Single-shot with a long ack window, unlike every other workspace REQ: the default 5s/5-tries
   * budget would retransmit an in-flight model pass and then fail a request whose answer was coming.
   */
  async workspaceGitMessage(daemonId: string, req: WorkspaceGitMessageReq): Promise<WorkspaceGitMessageResult> {
    const c = this.must(daemonId)
    return c.conn.request<WorkspaceGitMessageResult>(
      'workspace/gitmessage',
      req,
      { epoch: c.sessionEpoch },
      { ackTimeoutMs: WORKSPACE_GIT_MESSAGE_BUDGET_MS, maxTries: 1 }
    )
  }

  /**
   * List the background tasks of ONE ACP session from the owning daemon's in-memory lease
   * (REQ → `task/list/result`). Read-only, and a pure projection on the daemon side, so it
   * cannot disturb a reclaim decision. The CP proxies the snapshot and stores none of it —
   * descriptions are model-authored (body-locality, webchat-side-panels.md §2). A session
   * the daemon holds no lease for (`tracked:false`) and a lease with nothing in it are both
   * DATA; only an unknown agent is an error. Default request budget: the daemon answers
   * from memory, so there is no in-flight pass a retransmit could duplicate.
   */
  async taskList(daemonId: string, req: TaskListReq): Promise<TaskList> {
    const c = this.must(daemonId)
    return c.conn.request<TaskList>('task/list', req, { epoch: c.sessionEpoch })
  }

  // Bring an agent's cluster sandbox to Running WITHOUT a turn (REQ → `agent/wake/ok`). Addressed at the
  // DISPATCH daemon, which may not hold the agent yet (it claims on receipt like a trigger), so the org
  // is passed explicitly rather than read from the connection's agent index, where it is absent.
  async agentWake(daemonId: string, req: AgentWakeReq, orgId: string): Promise<AgentWakeOk> {
    const c = this.must(daemonId)
    return c.conn.request<AgentWakeOk>('agent/wake', req, { epoch: c.sessionEpoch }, undefined, orgId)
  }
}
