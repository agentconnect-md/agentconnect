// The `CpClientDeps` literal the daemon hands `CpClient`, hoisted out of `Daemon.startCpClient`.
// Construction order is load-bearing (the workspace resolvers feed the file, git and skills seams),
// so `buildCpClientDeps` is the single wiring site and keeps it verbatim.
import { hostname } from 'node:os'
import { join } from 'node:path'
import type {
  FactsMcpServer,
  FactsRuntimeProfile,
  GitCommitIdentity,
  Heartbeat,
  RegisterReq,
  ChildSessionStatus,
  ChildSessionStatusProbe,
  SessionPullRequestFeedback,
  SessionPullRequestFeedbackResult,
  TaskList,
  TaskListReq
} from '@agentconnect.md/protocol'
import { POD_TEMPLATE_HASH_ENV } from '@agentconnect.md/protocol'
import { ClientTransport, systemClock } from '@agentconnect.md/connection'
import { CP_SUBPROTOCOL, CP_WS_PATH, type BootstrapUpgradeOutcome, type CpClient, type CpClientDeps } from './client.js'
import type { ConfigApply } from './config-apply.js'
import { createSessionReader } from './session-reader.js'
import { createWorkspaceReader } from './workspace-reader.js'
import { createWorkspaceScope } from './workspace-scope.js'
import { createWorkspaceGit, type CommitMessagePass } from './workspace-git.js'
import { createAgentWaker } from './agent-wake.js'
import { createMemoryReader, type AgentMemoryAdminResolver } from './memory-reader.js'
import { createDreamReader } from './dream-reader.js'
import { createLocalSkillsReader } from './local-skills-reader.js'
import { createRuntimeCommandsReader } from './runtime-commands-reader.js'
import type { RuntimeCommandsCache } from '../runtimes/runtime-commands.js'
import type { CpAgentRegistry } from './cp-agent-registry.js'
import type { CpIntegrationRegistry } from './cp-integration-registry.js'
import type { CpCronRegistry } from './cp-cron.js'
import type { CpCollabRoutes } from './cp-collab-routes.js'
import type { CpMemoryConnectionRegistry } from './memory-connection-registry.js'
import type { DutyCoordinator } from './duty-coordinator.js'
import type { DutyRegistry } from './duty-registry.js'
import { persistDaemonId } from '../config/load-config.js'
import { DAEMON_VERSION } from '../version.js'
import type { Logger } from '../log.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import type { LocalStore, SessionRecord } from '../store/local-store.js'
import type { SessionMetadataOutbox } from '../store/session-metadata-outbox.js'
import type { WebchatMcpRevocations } from '../webchat/mcp-revocations.js'
import type { WorkspaceManager } from '../workspace/workspace-manager.js'
import type { K8sRuntimePlane } from '../k8s/runtime-plane.js'
import type { AutoMergeWatcher } from '../github/auto-merge/watcher.js'
import type { SandboxHolds } from '../k8s/sandbox-hold.js'
import { createSandboxKeepAlive } from './sandbox-keepalive.js'
import type { SystemMetrics } from '../metrics/system-metrics.js'
import type { ReadinessGate } from '../readiness.js'
import type { MemoryFs } from '../memory/store.js'
import type { DreamRunner } from '../dream/runner.js'
import type { CodeHostNoteProjector } from '../gitlab/note-projection.js'

/** The credentials, identity and logging this connection is built from, plus its single-point writes. */
export interface CpClientConnectionHost {
  /** The control-plane address, already checked by the caller's `configuredControlPlane` guard. */
  cpUrl(): string
  cpApiKey(): string | undefined
  /** False ⇒ this daemon never emits `usage/report`; a deployment that meters upstream is the single writer. */
  usageReporting(): boolean
  clusterIdentityToken(): (() => string | undefined) | undefined
  /** Echoed in the auth frame ONLY when the operator pinned one via `--daemon-id` — the token's `sub` is
   *  otherwise authoritative, and a config-persisted id would either be rejected (4401) or be redundant. */
  echoDaemonId(): string | undefined
  heartbeatDefaultMs(): number
  maxAgents(): number
  /** The config root `startCpClient` was called with, and the explicit config path if any. */
  configRoot(): string
  configPath(): string | undefined
  /** The daemon's own root dir (state that is not an agent's), e.g. `skill-installs/`. */
  daemonRoot(): string
  log(): Logger
  /** Read lazily — the client is assigned only after these deps are built. */
  cpClient(): CpClient | undefined
  /** Stop serving and end the process with this exit code — the daemon's fatal-exit seam. */
  exitFatal(code: number): void
  setDaemonId(daemonId: string): void
  setWebAppUrl(webAppUrl: string | undefined): void
  setOrgSlug(orgSlug: string | undefined): void
  /** Settles the promise `startCpClient` returns, on the first register/ok. */
  resolveInitialRegistry(): void
}

/** What the register frame, the runtime/MCP facts and the heartbeat report about this daemon. */
export interface CpClientRegistrationHost {
  registrationPlatforms(): string[]
  registrationFeatures(): string[]
  admittedRuntimeIds(): string[]
  reportedRuntimeIds(): string[]
  /** Registry id -> human-facing runtime name. */
  runtimeNames(): Record<string, string>
  runtimeProfileFor(id: string): FactsRuntimeProfile
  mcpServerFactsFromDefs(): FactsMcpServer[]
  cpLocalState(): RegisterReq['localState']
  metrics(): SystemMetrics | undefined
  hostCount(): number
  activeSessions(): number
  bootstrapUpgradeCapable(): boolean
  runBootstrapFleetUpgrade(targetVersion: string): Promise<BootstrapUpgradeOutcome>
}

/** The replay batch that runs once this daemon reaches READY on each (re)connect. */
export interface CpClientReadyHost {
  readiness(): ReadinessGate | undefined
  probeRuntimesAndEmit(): Promise<void>
  syncOrganizationSuggestions(): Promise<void>
  memoryConnections(): CpMemoryConnectionRegistry | undefined
  replayHookTerminalReports(): Promise<void>
  replayChannelSnapshots(): Promise<void>
  sessionMetadataOutbox(): SessionMetadataOutbox
  webchatMcpRevocations(): WebchatMcpRevocations
  drainSessionPurges(): Promise<void>
  effectiveAgents(): LoadedAgent[]
  /** The §16 run-projection writer: the CP dispatch target and the interrupted-write reconciler. */
  noteProjector(): CodeHostNoteProjector
  /** The §15 review adapter, for the control-plane frames a finished attempt still owes. */
  gitlabReviews(): { reconcilePending(): Promise<void> }
}

/** Tenant lookups for agent-scoped frames, plus the duty seam the heartbeat carries. */
export interface CpClientOrgHost {
  cpAgents(): CpAgentRegistry | undefined
  cpIntegrations(): CpIntegrationRegistry | undefined
  cpCrons(): CpCronRegistry | undefined
  cpCollab(): CpCollabRoutes
  cpDegradedScopes(): string[]
  dutyCoordinator(): DutyCoordinator
  duties(): DutyRegistry
}

/** The read/write seams the CP serves the console from — sessions, workspaces, memory, tasks. */
export interface CpClientSeamHost {
  configApply(): ConfigApply
  store(): LocalStore
  agents(): ReadonlyMap<string, LoadedAgent>
  workspaces(): WorkspaceManager
  k8sPlane(): K8sRuntimePlane | undefined
  memory(): AgentMemoryAdminResolver
  dreamRunner(): DreamRunner
  runtimeCommands(): RuntimeCommandsCache
  memoryFsFor(agentId: string): MemoryFs | undefined
  gitCommitIdentity(): GitCommitIdentity | undefined
  sessionThreadUrl(session: SessionRecord): string | undefined
  childSessionStatusProbe(probe: ChildSessionStatusProbe): Promise<ChildSessionStatus>
  dispatchPullRequestFeedback(req: SessionPullRequestFeedback): Promise<SessionPullRequestFeedbackResult>
  listBackgroundTasks(req: TaskListReq): Promise<TaskList>
  /** The edge's in-memory merge-when-ready registry, or undefined before agents are loaded. */
  autoMerge(): AutoMergeWatcher | undefined
  /** The console keep-alive leases over this daemon's sandboxes (`k8s/sandbox-hold.ts`). */
  sandboxHolds(): SandboxHolds
  withWorkspaceFileWrite<T>(agentId: string, write: () => Promise<T>): Promise<T>
  withWorkspaceIndexWrite<T>(agentId: string, write: () => Promise<T>): Promise<T>
  runCommitMessagePass: CommitMessagePass
}

/** Everything the CP client's dependency literal touches on the `Daemon`. */
export interface CpClientDepsHost
  extends CpClientConnectionHost, CpClientRegistrationHost, CpClientReadyHost, CpClientOrgHost, CpClientSeamHost {}

export function buildCpClientDeps(host: CpClientDepsHost): CpClientDeps {
  const url = host.cpUrl()
  const apiKey = host.cpApiKey()
  const clusterIdentityToken = host.clusterIdentityToken()
  const echoDaemonId = host.echoDaemonId()

  // Which root a console request addresses and where it IS — the sandbox pod's volume under --k8s.
  // ONE resolver for the file reader and the git seam: the directory the console browses and the one
  // it commits are the same directory, and describing them two different ways broke both panels.
  const workspaceScope = createWorkspaceScope({
    workspaces: host.workspaces(),
    agentOf: (id) => host.agents().get(id),
    sessionOf: (id, sessionId) => host.store().getSessionByOutwardId(sessionId, id),
    runtimeRootOf: (id) => host.k8sPlane()?.workspaceRootFor(id)
  })

  const workspaceGit = createWorkspaceGit(
    host.workspaces(),
    workspaceScope.gitRoot,
    // Derived from the SCOPE's own target, not the primary workspace's credential mode: a manual
    // GitHub workspace may authorize an App-covered repository, whose secondary root then needs the
    // helper the primary does not. The helper itself is URL-routed, so it only answers for that root.
    (id, repo) => (workspaceScope.usesGithubApp(id, repo) ? id : undefined),
    workspaceScope.target,
    // Registered on `register/ok` only, and reset by every reconnect — a console commit is
    // refused as data whenever it is absent (workspace-git.ts explains why).
    () => host.gitCommitIdentity(),
    // The model pass runs HERE, on the agent's own runtime: the CP is never on the inference path.
    (id, systemPrompt, prompt, signal) => host.runCommitMessagePass(id, systemPrompt, prompt, signal)
  )

  return {
    url,
    usageReporting: host.usageReporting(),
    ...(apiKey ? { token: apiKey } : {}),
    ...(clusterIdentityToken ? { clusterIdentityToken } : {}),
    ...(echoDaemonId ? { daemonId: echoDaemonId } : {}),
    onDaemonId: (id) => {
      host.setDaemonId(id)
      // An in-cluster daemon persists nothing: its identity is re-derived from the
      // projected token on every connect, so a stored id could only go stale.
      if (!clusterIdentityToken) persistDaemonId(host.configRoot(), id, host.configPath())
      host.log().info(`cp: adopted daemonId ${id} from auth/ok`)
    },
    onWebAppUrl: (webAppUrl) => {
      host.setWebAppUrl(webAppUrl)
      if (webAppUrl) host.log().debug(`cp: web app url ${webAppUrl} (session deep links)`)
    },
    onOrgSlug: (slug) => {
      host.setOrgSlug(slug)
      if (slug) host.log().debug(`cp: org slug "${slug}" (session deep links)`)
    },
    // Only ever called on the identity path (client.ts states why); the diagnosis is logged there.
    // Non-zero: a failure, not a planned lifecycle exit, so no supervisor treats it as a clean stop.
    onAuthFatal: () => host.exitFatal(1),
    ...(host.bootstrapUpgradeCapable()
      ? {
          onBootstrapUpgrade: (lifecycle: { targetVersion: string }) =>
            host.runBootstrapFleetUpgrade(lifecycle.targetVersion)
        }
      : {}),
    agentVersion: DAEMON_VERSION,
    host: hostname(),
    // The deployment side sets this from the pod-template-hash label; the ledger's rollout barrier
    // lets only the newest live generation of the set claim vacated groups. Unset locally.
    generation: process.env[POD_TEMPLATE_HASH_ENV]?.trim() || undefined,
    heartbeatDefaultMs: host.heartbeatDefaultMs(),
    maxAgents: host.maxAgents(),
    capabilities: () => ({
      platforms: host.registrationPlatforms(),
      // Report the human-facing tool name (e.g. "Claude Agent"), not the
      // registry id ("claude-acp"); fall back to the id for user-defined or
      // unnamed runtimes.
      runtimes: host.admittedRuntimeIds().map((id) => host.runtimeNames()[id] ?? id),
      acp: true,
      features: host.registrationFeatures()
    }),
    // Observed runtime profiles, sent as one `facts/daemon-runtimes` snapshot on
    // each register. Keyed by the registry id (the launch key), so the console can
    // offer a runtime whose value round-trips back to `this.runtimes[agent.runtime]`
    // at launch. `models` comes from the background probe sweep (empty until it
    // completes on first connect); the picker falls back to "Runtime default" while
    // empty. Includes auth-required curated candidates (reported, not admitted).
    runtimeProfiles: (): FactsRuntimeProfile[] => host.reportedRuntimeIds().map((id) => host.runtimeProfileFor(id)),
    // Daemon-configured MCP servers, derived from the effective def set (no
    // probing), riding the same facts frame with replace-on-register semantics.
    mcpServerFacts: (): FactsMcpServer[] => host.mcpServerFactsFromDefs(),
    // On (re)connect, probe runtimes in the background and push refreshed profiles,
    // and re-assert each integration's cached channel-membership snapshot (the CP
    // may have missed emits while we were disconnected; latest-wins upsert).
    onReady: async () => {
      host.resolveInitialRegistry()
      host.readiness()?.refresh()
      void host.probeRuntimesAndEmit()
      void host
        .syncOrganizationSuggestions()
        .catch((err) =>
          host.log().warn(`cp: organization suggestion replay failed (${err instanceof Error ? err.name : 'unknown'})`)
        )
      host.cpClient()?.emitMemoryConnectionFacts(host.memoryConnections()?.facts() ?? [])
      await host.replayHookTerminalReports()
      await host.replayChannelSnapshots()
      // Only snapshots written to the durable outbox by this build are
      // replayed. Historical session rows are never scanned or backfilled.
      void host.sessionMetadataOutbox().drainSessionMetadataSnapshots()
      // Replay remote MCP revocations that could not reach the CP (revokes
      // queued while disconnected or left over from a previous process).
      void host.webchatMcpRevocations().drainWebchatMcpRevocations()
      // ...and every §16 projection write this daemon started but never settled. Each is reconciled
      // by the hidden marker before the merge request is touched again, never by replaying the write.
      void host.noteProjector().reconcilePending()
      // ...and every §15 settle/result frame a review attempt still owes. Both are idempotent
      // REQs, so replaying one the CP already took is a no-op; not replaying wedges its ledger.
      void host.gitlabReviews().reconcilePending()
      // ...and the retention-GC receipts (#485). A sweep that ran while the CP
      // was unreachable (or before it advertised the feature) left the deleted
      // sessions' metadata rows unmarked; this is the only side that still knows.
      void host.drainSessionPurges()
      // ...and each CP cron's stored last-run stamp — fires while the CP was
      // unreachable would otherwise never land (latest-wins upsert, so
      // re-asserting an already-known stamp is a no-op).
      for (const a of host.effectiveAgents())
        for (const c of a.crons) {
          if (c.origin !== 'cp') continue
          const at = (await host.store().cronRun(`${a.id}:${c.id}`))?.lastRunAt
          if (at !== undefined)
            host.cpClient()?.emitCronReport({ cronId: c.id, agentId: a.id, firedAt: new Date(at).toISOString() })
        }
    },
    localState: () => host.cpLocalState(),
    loadSnapshot: (): Heartbeat['load'] => ({
      // 0..1 utilization fractions sampled in the background by SystemMetrics
      // (systeminformation): real busy-time CPU across cores + active memory,
      // read synchronously here so the heartbeat send never blocks on a probe.
      ...(host.metrics()?.snapshot() ?? { cpu: 0, mem: 0 }),
      agents: host.hostCount()
    }),
    activeSessions: () => host.activeSessions(),
    orgForAgent: (agentId) => host.cpAgents()?.orgForAgent(agentId) ?? host.cpCollab().orgForAgent(agentId),
    orgForIntegration: (integrationId) => {
      const agentId = host.cpIntegrations()?.agentForIntegration(integrationId)
      return agentId ? (host.cpAgents()?.orgForAgent(agentId) ?? host.cpCollab().orgForAgent(agentId)) : undefined
    },
    orgForCron: (cronId) => {
      const agentId = host.cpCrons()?.agentForCron(cronId)
      return agentId ? (host.cpAgents()?.orgForAgent(agentId) ?? host.cpCollab().orgForAgent(agentId)) : undefined
    },
    degradedScopes: () => host.cpDegradedScopes(),
    duties: () => host.dutyCoordinator().dutyDigest(),
    dutyPending: () => host.dutyCoordinator().pendingDutyAdmissions(),
    onDutyFence: (groupIds) => host.dutyCoordinator().fenceDuties(groupIds),
    configApply: host.configApply(),
    sessionRead: createSessionReader(host.store(), (session) => host.sessionThreadUrl(session)),
    // §5.4: serve a CP-forwarded status probe for a child session we own. Authorization is
    // re-done here (the lineage rule lives where the session lives), not trusted from the CP.
    childSessionStatusProbe: (probe) => host.childSessionStatusProbe(probe),
    pullRequestFeedback: async (req) => {
      if (host.dutyCoordinator().dutyEnforced() && !host.duties().holdsAgent(req.agentId)) {
        const claimed = await host.dutyCoordinator().claimDutyForTrigger(req.agentId)
        if (!claimed.granted) return { deliveryKey: req.deliveryKey, accepted: false, reason: 'not_ready' }
      }
      return host.dispatchPullRequestFeedback(req)
    },
    // The third argument is what makes a cluster agent's files reachable at all: the operations
    // run inside its pod, on the volume the root above names.
    workspaceRead: createWorkspaceReader(
      host.workspaces(),
      workspaceScope.location,
      (id, write) => host.withWorkspaceFileWrite(id, write),
      (id) => host.k8sPlane()?.workspaceFilesFor(id)
    ),
    workspaceGit: {
      status: (id, sessionId, repo) => workspaceGit.status(id, sessionId, repo),
      // diff/log are read-only, so they skip the runtime-quiescence coordinator the pull needs.
      diff: (req) => workspaceGit.diff(req),
      log: (req) => workspaceGit.log(req),
      pull: (id, repo) => host.withWorkspaceFileWrite(id, () => workspaceGit.pull(id, repo)),
      // The four console git writes serialize against agent turns without evicting the warm host
      // — they touch `.git`, never the working tree (see withWorkspaceIndexWrite).
      stage: (req) => host.withWorkspaceIndexWrite(req.agentId, () => workspaceGit.stage(req)),
      unstage: (req) => host.withWorkspaceIndexWrite(req.agentId, () => workspaceGit.unstage(req)),
      commit: (req) => host.withWorkspaceIndexWrite(req.agentId, () => workspaceGit.commit(req)),
      push: (req) => host.withWorkspaceIndexWrite(req.agentId, () => workspaceGit.push(req)),
      // The wand writes nothing, so it skips both coordinators like the other reads. It does start
      // the agent's host, which the admission fence blocks while a mutation holds it — reported as
      // data, not an error, because a workspace write is exactly when the answer would be stale.
      message: (req) => workspaceGit.message(req)
    },
    // A pure projection of the in-memory lease — no I/O, no runtime, and nothing it can do to a
    // reclaim decision, so it needs neither of the workspace coordinators.
    taskReader: { list: async (req) => host.listBackgroundTasks(req) },
    // Merge-when-ready lives at the EDGE and nowhere else — the CP relays these two frames and
    // stores nothing, so an unarmed answer is the truth about this process, not a lost row.
    ...(host.autoMerge() ? { autoMerge: host.autoMerge()! } : {}),
    // The keep-alive lease is the daemon's own decision, from facts the console cannot assert. Only
    // a cluster daemon has a pod to hold; elsewhere the handler answers `placement:'daemon'` unasked.
    ...(host.k8sPlane()
      ? {
          sandboxKeepAlive: createSandboxKeepAlive({
            runsInSandbox: (id) => host.k8sPlane()!.runsInSandbox(id),
            knownAgent: (id) => host.agents().has(id),
            armedFor: async (id) => (await host.autoMerge()?.armedFor(id)) === true,
            gitStatus: (id, sessionId) => workspaceGit.status(id, sessionId),
            holds: host.sandboxHolds(),
            log: { debug: (m) => host.log().debug?.(m) }
          })
        }
      : {}),
    // §16 desired projection generations, converged by the only GitLab Notes writer for this surface.
    codeHostNoteProjection: (desired, orgId) => host.noteProjector().apply(desired, orgId),
    // The console's "start this agent's sandbox": duty claim + channel bind, no host — the same
    // condition the file reader serves on, reached without a turn. Local daemons have no plane.
    agentWake: createAgentWaker({
      ...(host.k8sPlane()
        ? {
            sandbox: {
              isRunning: (id) => host.k8sPlane()!.runsInSandbox(id),
              ensureChannel: (id) => host.k8sPlane()!.ensureChannel(id)
            }
          }
        : {}),
      knowsAgent: (id) =>
        host.agents().has(id) && (!host.dutyCoordinator().dutyEnforced() || host.duties().holdsAgent(id)),
      claimDuty: async (id) =>
        host.dutyCoordinator().dutyEnforced() && (await host.dutyCoordinator().claimDutyForTrigger(id)).granted,
      log: host.log()
    }),
    memoryReader: createMemoryReader((id) => host.memoryFsFor(id), host.memory()),
    dreamReader: createDreamReader(host.dreamRunner()),
    localSkillsReader: createLocalSkillsReader(
      host.workspaces(),
      // The workspace root in EXECUTION coordinates, like the file reader's: the skill roots the
      // console lists are the ones the agent's harness loads, and those are in the pod.
      async (id) => (await workspaceScope.location(id))?.root,
      join(host.daemonRoot(), 'skill-installs'),
      (id) => host.k8sPlane()?.workspaceFilesFor(id),
      async (id) => {
        const incarnation = host.k8sPlane()?.workspaceIncarnationFor?.(id)
        return incarnation ? (await host.store().clusterSkillLedger(id, incarnation))?.ledger : undefined
      }
    ),
    runtimeCommandsReader: createRuntimeCommandsReader(host.runtimeCommands(), (id) => host.agents().has(id)),
    // webchat is no longer a CP control-WS integration (milestone A4) — it rides the
    // relay's rd/* wire, wired through RelayManager.onRelayMsg.
    clock: systemClock,
    connect: () => ClientTransport.dial(url, { subprotocol: CP_SUBPROTOCOL, path: CP_WS_PATH }),
    log: host.log()
  }
}
