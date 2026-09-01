// The `ConfigApply` bodies, one named handler per frame kind, hoisted out of `Daemon`.
// Order is load-bearing (duty/cron grants depend on agents and integrations landing
// first), so `buildConfigApply` is the single wiring site and keeps it verbatim.
import { randomUUID } from 'node:crypto'
import type {
  RegisterOk,
  RelayRosterEntry,
  CronUpsert,
  RouteAssign,
  RouteUpdate,
  AgentUpsert,
  CollabRoutesSnapshot,
  AgentLaunch,
  AgentLaunched,
  AgentStop,
  AgentDetach,
  AgentActivate,
  IntegrationSpec,
  IntegrationForget,
  IntegrationLeave,
  IntegrationLeaveOk,
  McpServerSpec,
  McpServerRemove,
  MemoryConnectionSpec,
  Ack,
  Drain,
  DrainProgress,
  DrainDone,
  DaemonRestart,
  DaemonUpgrade,
  DaemonControlAck,
  AgentPermissionRequestList,
  AgentPermissionRequestPage,
  AgentPermissionDecision,
  SessionVisibilityPush,
  DutyGrantEntry,
  DutyRevoke,
  GitCommitIdentity
} from '@agentconnect.md/protocol'
import type { Clock } from '@agentconnect.md/connection'
import { mergeConfigPush, type ConfigApply } from './config-apply.js'
import { makeLogger, type Logger } from '../log.js'
import { formatErr } from '../daemon/text.js'
import type { Config, RuntimeDef } from '../config/config-schema.js'
import type { Agent } from '../agents/agent-schema.js'
import type { LoadedAgent } from '../agents/load-agents.js'
import {
  clearAgentMoveStage,
  commitAgentMove,
  stageAgentMove,
  type AgentMoveStageMetadata
} from '../agents/write-agent.js'
import type { LocalStore } from '../store/local-store.js'
import type { AcpHost } from '../acp/acp-host.js'
import type { WorkspaceManager, PrepareSessionWorkspaceRequest } from '../workspace/workspace-manager.js'
import { unauthorizedWorkspaceGitOrigin } from '../workspace/git-origin-policy.js'
import type { KeyServerClient } from '../key-server/client.js'
import type { GitCredentialCache } from './git-credential.js'
import type { GitCredServer } from './gitcred-server.js'
import type { CpAgentRegistry } from './cp-agent-registry.js'
import type { CpIntegrationRegistry } from './cp-integration-registry.js'
import type { CpCronRegistry } from './cp-cron.js'
import type { CpCollabRoutes } from './cp-collab-routes.js'
import type { CpMemoryConnectionRegistry } from './memory-connection-registry.js'
import type { CpMcpDefs } from '../mcp/cp-mcp-defs.js'
import type { CpRoutingLayer } from '../router/cp-routing-layer.js'
import type { RemoteWebchatGrantManager } from '../mcp/remote-webchat-grant.js'
import { RESERVED_MCP_SERVER_NAME } from '../mcp/resolve-servers.js'

/** Process-wide daemon state the apply path reads, plus its single-point writes. */
export interface ConfigApplyCoreHost {
  cfg(): Config
  log(): Logger
  /** `config/push` may swap the level, which rebuilds the logger in place. */
  setLog(log: Logger): void
  store(): LocalStore
  clock(): Clock
  agentsDir(): string
  /** `--agent` single-agent mode refuses every agent move. */
  singleAgentMode(): boolean
  setGitCommitIdentity(identity: GitCommitIdentity | undefined): void
  flushReconcile(): Promise<void>
}

/** The CP-owned in-memory definition registries this daemon converges. */
export interface ConfigApplyRegistryHost {
  cpAgents(): CpAgentRegistry | undefined
  cpIntegrations(): CpIntegrationRegistry | undefined
  cpCrons(): CpCronRegistry | undefined
  cpRouting(): CpRoutingLayer | undefined
  cpCollab(): CpCollabRoutes
  cpMcpDefs(): CpMcpDefs | undefined
  memoryConnections(): CpMemoryConnectionRegistry | undefined
  convergeRelays(relays: RelayRosterEntry[]): void
  onMcpDefsChanged(): void
  /** Prune every CP dependent of an agent that is absent from the given exact set. */
  exactCpDependents(agentId: string, desired: { integrationIds: string[]; cronIds: string[] }): void
}

/** Removal tombstones, move staging fences, and the per-agent lifecycle queues. */
export interface ConfigApplyGateHost {
  drainingAgents(): Set<string>
  cpDroppedAgents(): Set<string>
  removedAgentTombstones(): ReadonlySet<string>
  moveStagedAgents(): Set<string>
  moveStageMetadata(): Map<string, AgentMoveStageMetadata>
  activatingAgents(): Set<string>
  preparingWorkspaces(): Set<string>
  pendingLaunchCorrelation(): Map<string, string>
  reserveAgentRemoval(agentId: string): { release: () => boolean; markerError?: Error }
  reserveAgentDrain(agentId: string): (preserveGate: boolean) => void
  agentRemovalPending(agentId: string): boolean
  agentDestructivePending(agentId: string): boolean
  clearRemovalAfterDestruction(agentId: string): void
  clearRemovalForReadd(agentId: string): void
  queueAgentLifecycle<T>(
    agentId: string,
    work: () => Promise<T>,
    opts?: { failureOwner?: string; onSettled?: () => void }
  ): Promise<T>
  queueAgentMove(kind: 'detach' | 'activate', agentId: string, moveId: string, work: () => Promise<Ack>): Promise<Ack>
}

/** Live agents, their hosts, workspaces, and the credentials bound to them. */
export interface ConfigApplyRuntimeHost {
  agents(): ReadonlyMap<string, LoadedAgent>
  workspaces(): WorkspaceManager
  runtimes(): Record<string, RuntimeDef>
  keyServer(): KeyServerClient | undefined
  gitCreds(): GitCredentialCache | undefined
  gitCredServer(): GitCredServer | undefined
  quiesceAgentWorkspaceAuthority(agentId: string): Promise<void>
  discardClusterSandbox(agentId: string): Promise<void>
  revokeRemoteWebchatGrantsForAgent(
    agentId: string,
    reason: Parameters<RemoteWebchatGrantManager['revokeAgent']>[1]
  ): Promise<void>
  stopAgent(agentId: string): Promise<void>
  stopHost(agentId: string, deadlineMs?: number): Promise<void>
  ensureHostAsync(agentId: string, opts?: { allowAgentDrain?: boolean }): Promise<AcpHost>
  prepareAgentWorkspace(
    agent: Agent,
    expectedWarmHost?: AcpHost,
    request?: PrepareSessionWorkspaceRequest,
    allowAgentDrain?: boolean
  ): Promise<string>
  enqueueAgentWorkspacePreparation<T>(
    agent: Agent,
    operation: () => Promise<T>,
    expectedWarmHost?: AcpHost,
    allowAgentDrain?: boolean
  ): Promise<T>
  activationCapabilityError(agent: LoadedAgent): string | undefined
  /** True when this daemon holds the duty that serves the agent. */
  servesAgent(agentId: string): boolean
  closeUnusedPlatformConnections(): Promise<void>
}

/** Duty, platform, cron and daemon-lifecycle control the apply path delegates to. */
export interface ConfigApplyControlHost {
  applyDutyGrant(grants: DutyGrantEntry[]): void
  applyDutyRevoke(revocations: DutyRevoke['revocations']): void
  decideEditorPermission(req: AgentPermissionDecision): Promise<Ack>
  leaveConversation(leave: IntegrationLeave): Promise<IntegrationLeaveOk>
  retractChannels(integrationId: string, channelIds: readonly string[]): Promise<void>
  runCronNow(cronId: string): Ack
  runDrain(drain: Drain, onProgress: (p: DrainProgress) => void): Promise<DrainDone>
  scheduleFleetExit(kind: 'restart' | 'upgrade', targetVersion?: string): DaemonControlAck
}

/** Everything the CP apply path touches on the `Daemon`. */
export interface ConfigApplyHost
  extends
    ConfigApplyCoreHost,
    ConfigApplyRegistryHost,
    ConfigApplyGateHost,
    ConfigApplyRuntimeHost,
    ConfigApplyControlHost {}

export function applyConfigPush(host: ConfigApplyCoreHost, keys: Record<string, unknown>): void {
  const { applied, ignored } = mergeConfigPush(host.cfg(), keys)
  if (applied.includes('logging.level')) host.setLog(makeLogger(host.cfg().logging.level))
  if (applied.length) host.log().info(`cp: applied config keys: ${applied.join(', ')}`)
  if (ignored.length) host.log().warn(`cp: ignored config keys: ${ignored.join(', ')}`)
}

export async function applyReconcileSnapshot(host: ConfigApplyHost, snap: RegisterOk): Promise<void> {
  host.setGitCommitIdentity(snap.gitCommitIdentity)
  // Console-set finished-session retention — the reconnect baseline for the
  // `config/push` hot update. Absent (older CP) ⇒ keep the local config value.
  if (snap.sessionRetention) host.cfg().sessions.retention = snap.sessionRetention
  // Reserve every agent drop before ANY fallible snapshot convergence.
  // Otherwise an unrelated integration/memory write could abort the frame
  // while a CP-removed agent remains live with no gate or durable marker.
  const droppedAgents = snap.drop.agents ?? []
  if (droppedAgents.length > 0) {
    await Promise.all(
      droppedAgents.map(({ agentId, action }) => {
        // Reserve every drop synchronously while building this array. No
        // queued lifecycle body runs until the current call stack yields.
        const removal = host.reserveAgentRemoval(agentId)
        let completed = false
        return host.queueAgentLifecycle(
          agentId,
          async () => {
            host.drainingAgents().add(agentId)
            host.cpDroppedAgents().add(agentId)
            await host.quiesceAgentWorkspaceAuthority(agentId)
            const cpAgents = host.cpAgents()
            if (!cpAgents) throw new Error('agent registry is not ready')
            try {
              if (action === 'remove') {
                cpAgents.remove(agentId)
                await host.discardClusterSandbox(agentId)
                host.moveStageMetadata().delete(agentId)
                host.moveStagedAgents().delete(agentId)
              } else {
                // A missed move is a cold detach: preserve workspace/memory/local
                // files, but scrub platform credentials and stop serving immediately.
                cpAgents.detach(agentId)
              }
            } catch (cleanupError) {
              if (removal.markerError) {
                throw new AggregateError(
                  [removal.markerError, cleanupError],
                  `agent "${agentId}" removal marker and durable ${action} both failed`
                )
              }
              throw cleanupError
            }
            if (removal.markerError) {
              host
                .log()
                .warn(
                  `cp: agent "${agentId}" removal marker publication failed, but durable ${action} completed (${formatErr(removal.markerError)})`
                )
            }
            completed = true
          },
          {
            failureOwner: 'remove',
            onSettled: () => {
              const lastReservation = removal.release()
              if (completed && lastReservation && !removal.markerError) {
                host.clearRemovalAfterDestruction(agentId)
              }
            }
          }
        )
      })
    )
  }

  // Registry before agent re-add: an AgentSpec may reference one of these
  // definitions, and static admission must never observe the new agent
  // before at least a probing (fail-closed) connection entry exists.
  host.memoryConnections()?.converge(snap.memoryConnections ?? [])
  // Apply only the ownership-aware, CP-authorized drop set. Roster absence
  // by itself is not destructive because this daemon may also host purely
  // local hand-authored agents/integrations.
  for (const integrationId of snap.drop.integrations ?? []) host.cpIntegrations()?.remove(integrationId)

  // A staged move is a durable tombstone. A register snapshot racing after
  // source detach (but before placement CAS) must not restore its archive or
  // rehydrate credentials. Only the ACKed atomic activate bundle may do so.
  const desiredAgents = (snap.agents ?? []).filter((agent) => !host.moveStagedAgents().has(agent.agentId))
  // The reconnect snapshot is authoritative after every lifecycle frame
  // already admitted on the old connection. Join those per-agent lanes
  // before clearing a drop gate or republishing the whole desired set.
  await Promise.all(desiredAgents.map(({ agentId }) => host.queueAgentLifecycle(agentId, async () => undefined)))
  // Install the authoritative replicas in memory while any removal tombstone
  // still excludes them from effectiveAgents. Only complete applications clear
  // the durable latch and reopen their admission gate.
  const revivableAgents = desiredAgents.filter(({ agentId }) => !host.agentRemovalPending(agentId))
  // Only entries the revision fence actually applied may clear a tombstone
  // below: a stale or refused roster entry (organization-secrets-and-
  // variables.md §7) leaves the existing replica untouched, so it is not the
  // complete authority replacement that re-add requires.
  const rewrittenAgents = new Set(host.cpAgents()?.converge(revivableAgents) ?? [])
  const desiredIntegrations = (snap.integrations ?? []).filter(
    (integration) => !host.moveStagedAgents().has(integration.agentId)
  )
  host.cpIntegrations()?.converge(desiredIntegrations)
  // Crons AFTER agents: the owning in-memory agent must exist first.
  // drop.crons prunes stale CP entries.
  for (const id of snap.drop.crons) host.cpCrons()?.remove(id)
  const desiredCrons = (snap.crons ?? []).filter((cron) => !host.moveStagedAgents().has(cron.agentId))
  host.cpCrons()?.converge(desiredCrons)
  for (const { agentId } of revivableAgents) {
    if (!rewrittenAgents.has(agentId)) continue
    if (host.removedAgentTombstones().has(agentId) || host.cpDroppedAgents().has(agentId)) {
      // A failed/interrupted removal can leave platform credentials in the
      // old root. Re-add is a complete authority replacement: exact-prune
      // every absent CP dependent and fsync the resulting bundle while the
      // tombstone gate is still closed.
      host.exactCpDependents(agentId, {
        integrationIds: desiredIntegrations
          .filter((integration) => integration.agentId === agentId)
          .map((integration) => integration.integrationId),
        cronIds: desiredCrons.filter((cron) => cron.agentId === agentId).map((cron) => cron.cronId)
      })
      host.clearRemovalForReadd(agentId)
    }
    if (!host.cpDroppedAgents().delete(agentId)) continue
    if (!host.agentDestructivePending(agentId)) host.drainingAgents().delete(agentId)
    host.gitCreds()?.clearDenied(agentId)
  }
  // Reconnect full-replaces tenant-scoped CP definitions; daemon-local definitions remain unchanged.
  host
    .cpMcpDefs()
    ?.converge(
      (snap.mcpServers ?? [])
        .filter((s) => s.name !== RESERVED_MCP_SERVER_NAME)
        .flatMap(({ orgId, name, issuedAt, ...def }) => (orgId ? [[orgId, name, def, issuedAt] as const] : []))
    )
  host.cpCollab().replace(snap.collabRoutes) // baseline collaboration routing snapshot (P2 terminal-verify)
  host.convergeRelays(snap.relays) // connect ingress only after its organization authority is installed
  host.cpRouting()?.converge({
    routingEpoch: snap.routingEpoch,
    assignments: snap.assignments,
    drop: { assignments: snap.drop.assignments }
  })
  if (snap.leases.length) host.log().debug(`cp: ${snap.leases.length} lease(s) noted (secrets handled later)`)
  if (snap.assignments.length) host.log().debug(`cp: converged ${snap.assignments.length} assignment(s)`)
  if (snap.agents.length) host.log().debug(`cp: converged ${snap.agents.length} agent spec(s)`)
  if (snap.integrations?.length) host.log().debug(`cp: converged ${snap.integrations.length} integration(s)`)
  await host.flushReconcile()
}

/**
 * §24.4 spec admission. The deployment's own code host is ADOPTED from the spec that names it —
 * it is deployment configuration, not tenant input, and this daemon already trusts it to decide
 * where an agent's git credential may go, so refusing to clone the same host protected nothing and
 * made every self-managed install restate an address the control plane had already sent. What is
 * still refused HERE is a repository somewhere else entirely: the refusal names the origin and
 * travels back on the upsert ack, the control plane's own record of why this daemon will not serve
 * the agent. An operator who set `workspaceGitAllowedOrigins: []` turned remote workspaces off, and
 * nothing adopts past that.
 */
function gitlabOriginRefusal(spec: AgentUpsert['spec']): string | undefined {
  // Keyed on the credential axis, not the wire arm: the host-neutral `git` arm
  // carries the same managed-GitLab binding the legacy `gitlab` arm did.
  const workspace = spec.workspace
  const gitlabBacked =
    workspace?.mode === 'gitlab' || (workspace?.mode === 'git' && workspace.credential?.provider === 'gitlab')
  if (!gitlabBacked) return undefined
  const origin = unauthorizedWorkspaceGitOrigin(workspace.gitRepo, spec.gitlabHost)
  return origin === undefined
    ? undefined
    : `workspace refused: ${origin} is neither this deployment's code host nor in security.workspaceGitAllowedOrigins on this daemon`
}

export function applyAgentUpsert(host: ConfigApplyHost, { agentId, spec }: AgentUpsert): Promise<Ack> {
  return host.queueAgentLifecycle(agentId, async () => {
    if (host.moveStagedAgents().has(agentId)) return { ok: false, reason: 'agent is staged for a move' }
    const originRefusal = gitlabOriginRefusal(spec)
    if (originRefusal !== undefined) {
      host.log().warn(`cp: agent "${agentId}" ${originRefusal}`)
      return { ok: false, reason: originRefusal }
    }
    if (host.agentRemovalPending(agentId)) return { ok: false, reason: 'agent is pending removal' }
    const cpAgents = host.cpAgents()
    if (!cpAgents) return { ok: false, reason: 'agent registry is not ready' }
    // Publish the in-memory spec first while a crash tombstone (if present)
    // still keeps the root outside the effective roster. Clearing it is the
    // authoritative re-add commit point.
    const replacingDroppedAuthority = host.removedAgentTombstones().has(agentId) || host.cpDroppedAgents().has(agentId)
    const takingOwnership = !cpAgents.has(agentId)
    const applied = cpAgents.upsert(agentId, spec)
    // The revision fence applied nothing (organization-secrets-and-variables.md
    // §7). A stale/idempotent snapshot is ACKed as a no-op — a newer revision
    // already went through this same path and cleared any tombstone — while an
    // equal revision carrying different content is a CP invariant violation and
    // must be refused rather than silently resolved in either direction.
    if (applied === 'conflict') {
      return { ok: false, reason: 'agent config revision already applied with different content' }
    }
    if (applied !== 'apply') return { ok: true }
    if (takingOwnership) await host.store().recoverPermissionRequests([agentId], host.clock().now())
    if (replacingDroppedAuthority) {
      // A standalone upsert has no dependent bundle. Scrub every stale CP
      // integration/cron now; subsequent live frames may repopulate them.
      host.exactCpDependents(agentId, { integrationIds: [], cronIds: [] })
    }
    if (replacingDroppedAuthority) host.clearRemovalForReadd(agentId)
    if (host.cpDroppedAgents().delete(agentId) && !host.agentDestructivePending(agentId)) {
      host.drainingAgents().delete(agentId)
    }
    // A replicated spec change may re-enable gitcred for a previously denied agent.
    host.gitCreds()?.clearDenied(agentId)
    await host.flushReconcile()
    return { ok: true }
  })
}

export function applyAgentRemove(host: ConfigApplyHost, agentId: string): Promise<void> {
  // Publish the gate and lifecycle-tail reservation synchronously. A later
  // upsert is queued behind this removal and cannot clear the gate or write
  // a new root while old workspace authority is still quiescing.
  const removal = host.reserveAgentRemoval(agentId)
  let completed = false
  return host.queueAgentLifecycle(
    agentId,
    async () => {
      host.drainingAgents().add(agentId)
      host.cpDroppedAgents().add(agentId)
      await host.quiesceAgentWorkspaceAuthority(agentId)
      const cpAgents = host.cpAgents()
      if (!cpAgents) throw new Error('agent registry is not ready')
      try {
        cpAgents.remove(agentId)
      } catch (cleanupError) {
        if (removal.markerError) {
          throw new AggregateError(
            [removal.markerError, cleanupError],
            `agent "${agentId}" removal marker and durable delete both failed`
          )
        }
        throw cleanupError
      }
      if (removal.markerError) {
        host
          .log()
          .warn(
            `cp: agent "${agentId}" removal marker publication failed, but durable delete completed (${formatErr(removal.markerError)})`
          )
      }
      await host.discardClusterSandbox(agentId)
      await host.flushReconcile()
      // Clear fail-closed gates only after destructive disk removal succeeds;
      // otherwise an old active root could become servable again on failure.
      host.moveStageMetadata().delete(agentId)
      host.moveStagedAgents().delete(agentId)
      completed = true
    },
    {
      failureOwner: 'remove',
      onSettled: () => {
        const lastReservation = removal.release()
        if (completed && lastReservation && !removal.markerError) {
          host.clearRemovalAfterDestruction(agentId)
        }
      }
    }
  )
}

export function applyAgentDetach(host: ConfigApplyHost, detach: AgentDetach): Promise<Ack> {
  const { agentId, moveId } = detach
  return host.queueAgentMove('detach', agentId, moveId, async () => {
    if (host.singleAgentMode()) {
      return { ok: false, reason: 'agent move is unavailable in --agent single-agent mode' }
    }
    const previous = host.moveStageMetadata().get(agentId)
    // A delayed duplicate detach after this same operation committed must
    // not take the newly-live agent back down. Its original detach did finish.
    if (previous?.moveId === moveId && previous.state === 'committed') return { ok: true }

    // Seed the materialization marker while the current definition is
    // still live. A later workspace activation uses it to distinguish a
    // permission/subdirectory edit from a destructive mode/repo/branch
    // replacement, including after an ACK-loss retry.
    const currentWorkspace = host.agents().get(agentId)
    if (currentWorkspace) host.workspaces().ensureWorkspaceMaterialization(currentWorkspace)

    // This is also the destination staging gate. An absent agent is expected:
    // ACK after arming the gate so the atomic activate bundle cannot serve early.
    stageAgentMove(host.agentsDir(), agentId, moveId, detach.requireEmptyWorkspace)
    host.cpDroppedAgents().delete(agentId)
    host.moveStageMetadata().set(agentId, {
      moveId,
      state: 'staging',
      ...(detach.requireEmptyWorkspace ? { requireEmptyWorkspace: true } : {})
    })
    host.moveStagedAgents().add(agentId)
    host.drainingAgents().add(agentId)
    // A placement cutover does not preserve the old execution context.
    // Start cancellation before any remote cleanup await, then wait only
    // for runtime authority to stop. Workspace edits keep the graceful
    // drain because they resume the same local agent after mutating files.
    if (detach.discardActiveTurns) await host.quiesceAgentWorkspaceAuthority(agentId)
    // Placement is revalidated by the CP for every remote-MCP request.
    // Clearing the memory-only descriptors prevents local reuse while the
    // durable revocation sweep converges.
    await host.revokeRemoteWebchatGrantsForAgent(agentId, 'agent_detached')
    if (!detach.discardActiveTurns) await host.stopAgent(agentId)
    const fence = host.moveStageMetadata().get(agentId)
    if (fence?.moveId !== moveId || fence.state !== 'staging') {
      return { ok: false, reason: 'agent/detach: move was superseded' }
    }
    if (detach.requireEmptyWorkspace) {
      const current = host.agents().get(agentId)
      const reason = !current
        ? `agent ${agentId} is not active on this daemon`
        : current.workspace.mode !== 'from-scratch'
          ? 'workspace is no longer scratch'
          : !host.workspaces().isWorkspaceEmpty(current)
            ? 'scratch workspace is not empty; remove or move its files before converting'
            : undefined
      if (reason) {
        // The root was never archived, so roll the temporary lifecycle
        // fence back and let the stopped host restart lazily on demand.
        clearAgentMoveStage(host.agentsDir(), agentId)
        host.moveStageMetadata().delete(agentId)
        host.moveStagedAgents().delete(agentId)
        await host.flushReconcile()
        return { ok: false, reason: `agent/detach: ${reason}` }
      }
    }
    host.gitCreds()?.remove(agentId)
    host.gitCredServer()?.revoke(agentId)
    host.cpAgents()?.detach(agentId)
    await host.flushReconcile()
    // Retry the strict close even when a previous detach pass already removed
    // the agent but failed while stopping its final socket.
    await host.closeUnusedPlatformConnections()
    const finalFence = host.moveStageMetadata().get(agentId)
    if (finalFence?.moveId !== moveId || finalFence.state !== 'staging') {
      return { ok: false, reason: 'agent/detach: move was superseded' }
    }
    return { ok: true }
  })
}

export function applyAgentActivate(host: ConfigApplyHost, activate: AgentActivate): Promise<Ack> {
  const { agentId } = activate
  return host.queueAgentMove('activate', agentId, activate.moveId ?? 'unstage', async () => {
    if (host.singleAgentMode()) {
      return { ok: false, reason: 'agent move is unavailable in --agent single-agent mode' }
    }
    const stage = host.moveStageMetadata().get(agentId)
    // A token-less activate releases whatever stale staging fence remains (#1093); none ⇒ no-op.
    if (activate.moveId === undefined && stage?.state !== 'staging') return { ok: true }
    // Token-less ⇒ adopt the stored fence's token, so commit supersedes the stale move exactly.
    const moveId = activate.moveId ?? stage!.moveId
    if (stage?.moveId === moveId && stage.state === 'committed') return { ok: true }
    if (
      stage?.moveId !== moveId ||
      stage.state !== 'staging' ||
      !host.moveStagedAgents().has(agentId) ||
      !host.drainingAgents().has(agentId)
    ) {
      return { ok: false, reason: 'agent/activate: staging fence is missing or superseded' }
    }
    const capacityUsed = host.agents().size + host.activatingAgents().size
    if (host.cfg().limits.maxAgents > 0 && capacityUsed >= host.cfg().limits.maxAgents) {
      return {
        ok: false,
        reason: `agent/activate: daemon capacity ${capacityUsed}/${host.cfg().limits.maxAgents} is full`
      }
    }
    host.activatingAgents().add(agentId)
    if (activate.prepareWorkspace || activate.reconcileWorkspace) host.preparingWorkspaces().add(agentId)
    try {
      if (activate.integrations.some((integration) => integration.agentId !== agentId)) {
        return { ok: false, reason: 'agent/activate: integration bundle contains a different agentId' }
      }
      if (activate.crons.some((cron) => cron.agentId !== agentId)) {
        return { ok: false, reason: 'agent/activate: cron bundle contains a different agentId' }
      }
      // Apply the complete authoritative bundle synchronously while the staged
      // agent is still excluded from effectiveAgents. Every update either lands
      // before the ACK or throws; retries remain safe behind the same gate.
      host.gitCreds()?.clearDenied(agentId)
      // The target enforces the revision fence independently (organization-
      // secrets-and-variables.md §7). A bundle whose resolved spec is older
      // than (or contradicts) what this daemon already applied must NOT
      // activate stale credentials — refuse so the CP re-resolves and replays.
      const applied = host.cpAgents()?.upsert(agentId, activate.spec) ?? 'apply'
      if (applied === 'stale' || applied === 'conflict') {
        return {
          ok: false,
          reason: `agent/activate: spec revision ${activate.spec.configRevision ?? '(none)'} is not newer than the applied configuration`
        }
      }
      for (const integration of activate.integrations) host.cpIntegrations()?.upsert(integration)
      for (const cron of activate.crons) host.cpCrons()?.upsert(cron)
      host.exactCpDependents(agentId, {
        integrationIds: activate.integrations.map((integration) => integration.integrationId),
        cronIds: activate.crons.map((cron) => cron.cronId)
      })
      const activation =
        host.cpAgents()?.activate(agentId, {
          integrationIds: activate.integrations.map((integration) => integration.integrationId),
          cronIds: activate.crons.map((cron) => cron.cronId)
        }) ?? 'missing'
      if (activation === 'missing') {
        return { ok: false, reason: `agent/activate: unknown agent ${agentId}` }
      }
      await host.store().recoverPermissionRequests([agentId], host.clock().now())
      if (host.agentRemovalPending(agentId)) {
        return { ok: false, reason: 'agent/activate: superseded by a newer agent removal' }
      }
      // The staged gate stays closed, so a tokened activate may clear a crash tombstone here.
      if (host.removedAgentTombstones().has(agentId) || host.cpDroppedAgents().has(agentId)) {
        // A token-less unstage is not an authoritative re-add: never resurrect a removed agent.
        if (activate.moveId === undefined) {
          return { ok: false, reason: 'agent/activate: a removal tombstone owns this agent' }
        }
        host.clearRemovalForReadd(agentId)
      }
      // Dependents were pruned while the agent was still invisible. Publish the
      // exact-set config now, but keep the dispatch gate until the host proves ready.
      host.moveStagedAgents().delete(agentId)
      try {
        await host.flushReconcile()
      } catch (err) {
        host.moveStagedAgents().add(agentId)
        await host.stopHost(agentId).catch(() => {})
        await host.flushReconcile().catch(() => {})
        throw err
      }
      const agent = host.agents().get(agentId)
      if (!agent) {
        host.moveStagedAgents().add(agentId)
        await host.flushReconcile()
        return { ok: false, reason: `agent/activate: agent ${agentId} did not reconcile` }
      }
      if (!host.runtimes()[agent.runtime]) {
        host.moveStagedAgents().add(agentId)
        await host.flushReconcile()
        return { ok: false, reason: `agent/activate: runtime "${agent.runtime}" is unavailable` }
      }
      const capabilityError = host.activationCapabilityError(agent)
      if (capabilityError) {
        host.moveStagedAgents().add(agentId)
        await host.flushReconcile()
        return { ok: false, reason: `agent/activate: ${capabilityError}` }
      }
      let rollbackPreparedWorkspace: (() => void) | undefined
      if (activate.prepareWorkspace || activate.reconcileWorkspace) {
        try {
          // A prior incarnation of this agent id must relinquish every
          // queued/running preparation before activation rewrites or
          // reconciles the target workspace. Register activation's own
          // mutation in the same tail so remove/shutdown cannot release
          // its root before the rollback-capable operation settles.
          rollbackPreparedWorkspace = await host.enqueueAgentWorkspacePreparation(
            agent,
            () =>
              host.workspaces().prepareWorkspaceForActivation(agent, {
                allowExistingCheckout: stage.requireEmptyWorkspace !== true,
                reconcileMaterialization: activate.reconcileWorkspace === true
              }),
            undefined,
            true
          )
        } catch (err) {
          host.moveStagedAgents().add(agentId)
          await host.stopHost(agentId).catch(() => {})
          await host.flushReconcile().catch(() => {})
          return { ok: false, reason: `agent/activate: workspace preparation failed: ${(err as Error).message}` }
        }
      }
      // Prove ACP can initialize under the still-closed gate; the workspace reconciled first, so the
      // spawned runtime and its sandbox bind the new directory rather than an unlinked old one.
      // An unstage restores the replica, not serving authority: a non-holder must not bind the sandbox (#1093).
      // Read HERE, never captured: a revoke landing during the awaits above already stopped this host.
      // Tokened stays host-proving: its target is the placement, or a source whose duty the move never released.
      if (activate.moveId !== undefined || host.servesAgent(agentId)) {
        try {
          // Key-server mode gives every session its own credential-scoped host, so there is no
          // shared agent host to prove — reconciling the workspace is the whole of the proof.
          if (host.keyServer()) await host.prepareAgentWorkspace(agent, undefined, undefined, true)
          else await host.ensureHostAsync(agentId, { allowAgentDrain: true })
        } catch (err) {
          host.moveStagedAgents().add(agentId)
          await host.stopHost(agentId).catch(() => {})
          try {
            await rollbackPreparedWorkspace?.()
          } catch (rollbackErr) {
            host
              .log()
              .error(`agent/activate: failed to roll workspace back for "${agentId}": ${formatErr(rollbackErr)}`)
          }
          await host.flushReconcile().catch(() => {})
          return { ok: false, reason: `agent/activate: ${(err as Error).message}` }
        }
      }
      if (host.agentDestructivePending(agentId)) {
        host.moveStagedAgents().add(agentId)
        await host.stopHost(agentId).catch(() => {})
        try {
          rollbackPreparedWorkspace?.()
        } catch (rollbackErr) {
          host.log().error(`agent/activate: failed to roll workspace back for "${agentId}": ${formatErr(rollbackErr)}`)
        }
        await host.flushReconcile().catch(() => {})
        return {
          ok: false,
          reason: host.agentRemovalPending(agentId)
            ? 'agent/activate: superseded by agent removal'
            : 'agent/activate: superseded by a newer agent drain'
        }
      }
      try {
        commitAgentMove(host.agentsDir(), agentId, moveId)
      } catch (err) {
        await host.stopHost(agentId).catch(() => {})
        try {
          await rollbackPreparedWorkspace?.()
        } catch (rollbackErr) {
          host.log().error(`agent/activate: failed to roll workspace back for "${agentId}": ${formatErr(rollbackErr)}`)
        }
        host.moveStagedAgents().add(agentId)
        await host.flushReconcile().catch(() => {})
        return { ok: false, reason: `agent/activate: failed to commit staging fence: ${(err as Error).message}` }
      }
      host.moveStageMetadata().set(agentId, { moveId, state: 'committed' })
      if (!host.agentDestructivePending(agentId)) host.drainingAgents().delete(agentId)
      return { ok: true }
    } finally {
      host.preparingWorkspaces().delete(agentId)
      host.activatingAgents().delete(agentId)
    }
  })
}

export async function listAgentPermissionRequests(
  host: ConfigApplyCoreHost,
  { agentId, limit }: AgentPermissionRequestList
): Promise<AgentPermissionRequestPage> {
  return {
    agentId,
    requests: await Promise.all(
      (await host.store().listPermissionRequests(agentId, limit)).map(async (request) => ({
        id: request.id,
        agentId: request.agentId,
        // The console scopes approvals to the session it is showing, by the id it routed on —
        // the outward one (§1.1). The row is keyed by the runtime's, so it translates here.
        sessionId: await outwardSessionId(host, request.agentId, request.sessionId),
        createdAt: new Date(request.createdAt).toISOString(),
        requesterId: request.requesterId,
        requesterName: request.requesterName,
        command: request.command,
        status: request.status,
        resolvedAt: request.resolvedAt === null ? null : new Date(request.resolvedAt).toISOString(),
        resolvedBy: request.resolvedBy ?? null,
        resolvedByName: request.resolvedByName ?? null
      }))
    )
  }
}

export function applyIntegrationUpsert(
  host: ConfigApplyRegistryHost & ConfigApplyGateHost,
  spec: IntegrationSpec
): void {
  if (!host.moveStagedAgents().has(spec.agentId)) host.cpIntegrations()?.upsert(spec)
}

export function applyIntegrationRemove(host: ConfigApplyRegistryHost, integrationId: string): void {
  host.cpIntegrations()?.remove(integrationId)
}

export function applyMcpServerUpsert(host: ConfigApplyCoreHost & ConfigApplyRegistryHost, spec: McpServerSpec): void {
  if (spec.name === RESERVED_MCP_SERVER_NAME) {
    host.log().warn(`mcp: ignoring CP push for reserved server name "${spec.name}"`)
    return
  }
  // `issuedAt` is the ordering marker, not part of the definition the runtime
  // spawns with — strip it out of `def` at every apply site.
  const { orgId, name, issuedAt, ...def } = spec
  if (!orgId) return
  if (host.cpMcpDefs()?.upsert(orgId, name, def, issuedAt)) {
    host.onMcpDefsChanged()
    // NEVER log def values — an http proxy def's headers carry the bearer grant key.
    host.log().info(`mcp: applied CP server def "${name}" for organization ${orgId}`)
  }
}

export function applyMcpServerRemove(
  host: ConfigApplyCoreHost & ConfigApplyRegistryHost,
  { orgId, name }: McpServerRemove
): void {
  if (!orgId) return
  if (host.cpMcpDefs()?.remove(orgId, name)) {
    host.onMcpDefsChanged()
    host.log().info(`mcp: removed CP server def "${name}" for organization ${orgId}`)
  }
}

export async function applyMemoryConnectionUpsert(
  host: ConfigApplyRegistryHost,
  spec: MemoryConnectionSpec
): Promise<Ack> {
  const memoryConnections = host.memoryConnections()
  if (!memoryConnections) return { ok: false, reason: 'memory connection registry is unavailable' }
  if (!memoryConnections.upsert(spec)) {
    return { ok: false, reason: 'memory connection definition is stale or conflicts at the same revision' }
  }
  const reason = await memoryConnections.waitForAdmission(spec.connectionId)
  return reason ? { ok: false, reason } : { ok: true }
}

export function applyMemoryConnectionRemove(host: ConfigApplyRegistryHost, connectionId: string): void {
  host.memoryConnections()?.remove(connectionId)
}

export function upsertCron(host: ConfigApplyRegistryHost & ConfigApplyGateHost, cron: CronUpsert): void {
  if (!host.moveStagedAgents().has(cron.agentId)) host.cpCrons()!.upsert(cron)
}

export function removeCron(host: ConfigApplyRegistryHost, cronId: string): void {
  host.cpCrons()!.remove(cronId)
}

export function applyRouteAssign(host: ConfigApplyRegistryHost, a: RouteAssign): void {
  host.cpRouting()?.upsertAssign(a)
}

export function applyRouteUpdate(host: ConfigApplyRegistryHost, u: RouteUpdate): void {
  host.cpRouting()?.applyUpdate(u)
}

export function applyCollabRoutes(host: ConfigApplyRegistryHost, snap: CollabRoutesSnapshot): void {
  host.cpCollab().replace(snap)
}

export function applyAgentLaunch(host: ConfigApplyHost, launch: AgentLaunch): Promise<AgentLaunched> {
  return host.queueAgentLifecycle(launch.agentId, async () => {
    if (host.moveStagedAgents().has(launch.agentId)) {
      throw new Error(`agent/launch: agent ${launch.agentId} is staged for a daemon move`)
    }
    const agent = host.agents().get(launch.agentId)
    if (!agent) throw new Error(`agent/launch: unknown agent ${launch.agentId}`)
    if (host.agentDestructivePending(launch.agentId)) {
      throw new Error(`agent/launch: superseded by a newer agent drain for ${launch.agentId}`)
    }
    // Revive a stopped agent only after every older lifecycle mutation has
    // settled. The queue prevents launch from clearing a slow remove's gate.
    host.drainingAgents().delete(launch.agentId)
    // Park the CP's launch provenance for the next session this agent
    // creates, so ingest can attribute it to the launching user (§4.4).
    if (launch.launchCorrelationId) {
      host.pendingLaunchCorrelation().set(launch.agentId, launch.launchCorrelationId)
    }
    if (host.keyServer()) await host.prepareAgentWorkspace(agent, undefined, undefined, true)
    else await host.ensureHostAsync(launch.agentId, { allowAgentDrain: true })
    return {
      agentId: launch.agentId,
      launchId: randomUUID(),
      startedAt: new Date(host.clock().now()).toISOString(),
      runtime: agent.runtime
    }
  })
}

export function applyAgentStop(host: ConfigApplyGateHost & ConfigApplyRuntimeHost, stop: AgentStop): Promise<Ack> {
  const releaseDrain = host.reserveAgentDrain(stop.agentId)
  const run = host.queueAgentLifecycle(
    stop.agentId,
    async () => {
      await host.stopAgent(stop.agentId)
      return { ok: true }
    },
    { failureOwner: 'stop' }
  )
  return run.then(
    (ack) => {
      releaseDrain(true)
      return ack
    },
    (error) => {
      releaseDrain(true)
      throw error
    }
  )
}

// The CP is the authority on effective visibility (§4.3 changes, §4.5
// settlements and cascades); the daemon only enforces the resulting
// capture gate. Ordering is by the CP's durable revision, so retransmits
// and out-of-order delivery are safe.
/** How the CONSOLE names the session an ACP id belongs to (session-concept.md §1.1). Falls back
 *  to the id it was given, which is what a pre-v12 session was reported under. */
async function outwardSessionId(host: ConfigApplyCoreHost, agentId: string, acpSessionId: string): Promise<string> {
  const slot = await host.store().getSessionByAcpIdForAgent(agentId, acpSessionId)
  return slot ? await host.store().ensureOutwardSessionId(slot.key, agentId, host.clock().now()) : acpSessionId
}

export async function applySessionVisibility(
  host: ConfigApplyCoreHost,
  p: SessionVisibilityPush
): Promise<'applied' | 'superseded'> {
  // A CP too old to name the agent leaves only the id: use the sole local holder, and where
  // there is none leave the gate closed (still ACKed).
  const agentId = p.agentId ?? (await host.store().soleAgentForAcpSession(p.sessionId))
  if (!agentId) return 'superseded'
  // The push names the session outwardly; the gate is keyed by the runtime's id.
  const slot = await host.store().getSessionByOutwardId(p.sessionId, agentId)
  const acpSessionId = slot?.acpSessionId ?? p.sessionId
  return host
    .store()
    .applyCpCaptureGate(agentId, acpSessionId, p.sharedMemoryExcluded ?? p.visibility === 'private', p.visibilityRev)
}

/** Wire the handlers into the seam — member order mirrors the `ConfigApply` contract. */
export function buildConfigApply(host: ConfigApplyHost): ConfigApply {
  return {
    applyConfigPush: (keys) => applyConfigPush(host, keys),
    applyDutyGrant: (grants) => host.applyDutyGrant(grants),
    applyDutyRevoke: (revocations) => host.applyDutyRevoke(revocations),
    applyReconcileSnapshot: (snap: RegisterOk) => applyReconcileSnapshot(host, snap),
    applyAgentUpsert: (upsert) => applyAgentUpsert(host, upsert),
    applyAgentRemove: (agentId: string) => applyAgentRemove(host, agentId),
    applyAgentDetach: (detach: AgentDetach) => applyAgentDetach(host, detach),
    applyAgentActivate: (activate: AgentActivate) => applyAgentActivate(host, activate),
    listAgentPermissionRequests: (req: AgentPermissionRequestList) => listAgentPermissionRequests(host, req),
    decideAgentPermission: async (req: AgentPermissionDecision): Promise<Ack> => await host.decideEditorPermission(req),
    applyIntegrationUpsert: (spec) => applyIntegrationUpsert(host, spec),
    applyIntegrationRemove: (integrationId) => applyIntegrationRemove(host, integrationId),
    applyIntegrationLeave: (leave) => host.leaveConversation(leave),
    applyIntegrationForget: (forget: IntegrationForget) => host.retractChannels(forget.integrationId, forget.channels),
    applyMcpServerUpsert: (spec) => applyMcpServerUpsert(host, spec),
    applyMcpServerRemove: (remove) => applyMcpServerRemove(host, remove),
    applyMemoryConnectionUpsert: (spec) => applyMemoryConnectionUpsert(host, spec),
    applyMemoryConnectionRemove: (connectionId) => applyMemoryConnectionRemove(host, connectionId),
    upsertCron: (cron: CronUpsert) => upsertCron(host, cron),
    removeCron: (cronId: string) => removeCron(host, cronId),
    runCron: (cronId: string) => host.runCronNow(cronId),
    applyRouteAssign: (a: RouteAssign) => applyRouteAssign(host, a),
    applyRouteUpdate: (u: RouteUpdate) => applyRouteUpdate(host, u),
    applyRelayRoster: (relays: RelayRosterEntry[]) => host.convergeRelays(relays),
    applyCollabRoutes: (snap) => applyCollabRoutes(host, snap),
    // ── lifecycle control (§5.3/§8) ──
    applyAgentLaunch: (launch: AgentLaunch) => applyAgentLaunch(host, launch),
    applyAgentStop: (stop: AgentStop) => applyAgentStop(host, stop),
    applyDaemonDrain: (drain: Drain, onProgress: (p: DrainProgress) => void): Promise<DrainDone> =>
      host.runDrain(drain, onProgress),
    applyDaemonRestart: (_req: DaemonRestart): DaemonControlAck => host.scheduleFleetExit('restart'),
    applyDaemonUpgrade: (req: DaemonUpgrade): DaemonControlAck => host.scheduleFleetExit('upgrade', req.targetVersion),
    applySessionVisibility: (p: SessionVisibilityPush) => applySessionVisibility(host, p)
  }
}
