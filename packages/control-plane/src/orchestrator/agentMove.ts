/**
 * Hard-cutover agent movement between daemons.
 *
 * The source daemon first ACKs `agent/detach`, which gates new admission, cancels
 * running turns, and archives the complete agent root out of the active tree. It
 * does not wait for old turns to finish or migrate their session state. Only then
 * does the CP compare-and-set `Agent.daemonId`. The target is bootstrapped from the
 * durable CP definition and activated last. A failed target bootstrap is
 * compensated by detaching the partial target, moving the DB placement back, and
 * reactivating the source archive.
 *
 * An explicit force reassign may continue without the source ACK only when
 * the HTTP edge has proved the source unavailable and the operator accepted the
 * split-brain risk. It still attempts the detach so a source that reconnects in
 * the race can quiesce normally. This is deliberately a hard cutover, not
 * state migration: workspace, transcript, and memory bytes remain daemon-local.
 */
import { randomUUID } from 'node:crypto'
import {
  gitRepoLabel,
  type Ack,
  type AgentActivate,
  type DutyAgentBundle,
  type AgentAdditionalRepo,
  type AgentSkillEntry,
  type ManagedSkillEntry,
  type CronUpsert,
  type IntegrationSpec
} from '@agentconnect.md/protocol'
import type {
  AgentRecord,
  AgentRepo,
  AssignmentRepo,
  BotRepo,
  BotSecretStore,
  CronRepo,
  MemberSetRepo,
  AgentWorkspace,
  IntegrationChannelRepo,
  IntegrationRepo
} from '../persistence/ports.js'
import { AgentWorkspaceIntegrationConflict } from '../persistence/errors.js'
import type { AgentId, DaemonId } from '../domain/ids.js'
import {
  claimScopeOf,
  isPlaced,
  mayHold,
  placementColumns,
  placementLabel,
  placementTargetOf,
  samePlacement,
  type PlacementTarget
} from '../domain/placement.js'
import { PLACEMENT_ONLY, type PlacementResolver } from './placementResolver.js'
import { convergeAgentRouting } from './agentRouting.js'
import { cronToUpsert, integrationToSpec, isGatedAgent, httpIntegrationToSpec } from './placement.js'
import {
  mcpDefsForAgents,
  memoryDefsForAgents,
  type McpDefinitionDeps,
  type MemoryDefinitionDeps
} from './agentDefinitions.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import type { AgentSpecAssembler } from './agentSpecAssembler.js'
import type { OrganizationEnvironmentValues } from './organizationEnvironment.js'
import type { ControlSender } from './outbound.js'
import type { HookService } from '../hooks/hook.service.js'
import type { HttpBotOrchestrator } from './httpBot.js'
import type { CollabRoutesService } from './collabRoutes.service.js'
import type { AgentMutationGate } from './agentMutationGate.js'
import type { SessionKey } from '../domain/sessionKey.js'
import type { DaemonLiveness } from '../ports.js'

export class AgentMoveConflict extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentMoveConflict'
  }
}

export class AgentMoveFailed extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'AgentMoveFailed'
  }
}

/** A placement ownership race was fenced and must not enter normal rollback. */
class AgentMoveFailClosed extends AgentMoveFailed {}

export interface AgentMoveLog {
  warn(obj: unknown, msg?: string): void
}

export interface AgentMoveDeps {
  agents: AgentRepo
  assignments: AssignmentRepo
  integrations: IntegrationRepo
  integrationChannels: IntegrationChannelRepo
  bots: BotRepo
  botSecrets: BotSecretStore
  /** §9 platform providers — the projector behind every `IntegrationSpec.config`
   *  in the move bundle (`orchestrator/placement.ts`). */
  platforms: CpPlatformRegistry
  /** Owns AgentSpec assembly (secret loading + icon bases) for the activation definition. */
  specs: AgentSpecAssembler
  crons: CronRepo
  /** The `duty/fetch` bundle's MCP and external-memory projections — the same
   *  optional seams `PlacementOrchDeps` carries, so the bundle and the reconnect
   *  snapshot are one projector. Absent (tests / no orch) ⇒ neither kind ships. */
  mcp?: McpDefinitionDeps
  memory?: MemoryDefinitionDeps
  control: ControlSender
  hooks: HookService
  httpBot: HttpBotOrchestrator
  collabRoutes: CollabRoutesService
  mutations: AgentMutationGate
  sessionOwners: { releaseSession(key: SessionKey): void }
  /** Set membership, for deciding whether a detached source is still an eligible holder of the
   *  new placement. Absent ⇒ no source is ever unstaged, the pre-pool behavior. */
  memberSets?: Pick<MemberSetRepo, 'setIdOf' | 'memberIdsOf'>
  /** Live-connection reads for the set-commit unstage broadcast. Absent ⇒ no member is broadcast to. */
  liveness?: DaemonLiveness
  /** Resolves the members currently serving an agent — the sources a move must quiesce when
   *  placement names no machine of its own. Absent ⇒ placement alone (the pre-duty behavior). */
  placement?: PlacementResolver
  log?: AgentMoveLog
  /** Placement decides duty incumbency (design §4.4 soak policy), so a completed
   *  move re-derives the org's groups. Fire-and-forget; the sweep is the backstop. */
  recomputeDuties?: (orgId: string) => void
}

interface MoveBundle {
  integrations: Array<{ spec: IntegrationSpec; botId: string; http: boolean }>
  crons: CronUpsert[]
  httpBotIds: string[]
  /** The agent's write-only secret env vars (AgentSecretStore) — part of the wire
   *  definition, so a mid-move secret edit trips the fingerprint stability check. */
  secrets: Record<string, string>
  /** Resolved skill entries (shared-skills.md) — pinned so the authoritative
   *  `agent/activate` ships them; a bare project() would clear skills on the target. */
  skills: AgentSkillEntry[]
  /** Exact accepted managed-skill revisions, pinned across the activation ACK. */
  managedSkills: ManagedSkillEntry[]
  /**
   * The organization entries assigned to this agent, resolved at snapshot time
   * (organization-secrets-and-variables.md §7). Pinned like `secrets` so it enters
   * the activation fingerprint: an entry rotation or audience change racing the
   * move makes the bundle REPLAY instead of activating stale credentials on the
   * target daemon.
   */
  organizationEnvironment: OrganizationEnvironmentValues
  /** The agent's authorized additional repositories — pinned for the same reason
   *  as skills: a bare project() would ship [] and clear them on the target. */
  additionalRepos: AgentAdditionalRepo[]
  /** Whether an enabled gitlab hook rides the agent — the §24.4 consumer no other
   *  bundle field reveals, and the host must be on the spec before the agent spawns. */
  gitlabHook: boolean
}

interface ActivationSnapshot {
  agent: AgentRecord
  bundle: MoveBundle
  fingerprint: string
}

type SourceDetachMode = 'required' | 'best-effort'

const MAX_STABILITY_ATTEMPTS = 3

function requireAck(action: string, ack: Ack): void {
  if (!ack.ok) throw new AgentMoveFailed(`${action} rejected${ack.reason ? `: ${ack.reason}` : ''}`)
}

function sameWorkspaceDefinition(left: AgentWorkspace, right: AgentWorkspace): boolean {
  if (left.mode !== right.mode) return false
  if (left.mode === 'scratch' || right.mode === 'scratch') return true
  return (
    (left.isolation ?? 'shared') === (right.isolation ?? 'shared') &&
    gitRepoLabel(left.gitRepo).toLowerCase() === gitRepoLabel(right.gitRepo).toLowerCase() &&
    (left.gitBranch ?? 'main') === (right.gitBranch ?? 'main') &&
    (left.agentDir ?? '') === (right.agentDir ?? '') &&
    (left.mode === 'github' ? left.installationId : undefined) ===
      (right.mode === 'github' ? right.installationId : undefined) &&
    (left.gitAccess ?? 'write') === (right.gitAccess ?? 'write')
  )
}

function sameWorkspace(agent: AgentRecord, workspace: AgentWorkspace, workspaceRepoId?: bigint): boolean {
  if (!sameWorkspaceDefinition(agent.workspace, workspace)) return false
  if (workspace.mode === 'scratch') return agent.workspaceRepoId === undefined
  return agent.workspaceRepoId === undefined || agent.workspaceRepoId === workspaceRepoId
}

function isUnchangedWorkspace(agent: AgentRecord | null, original: AgentRecord): agent is AgentRecord {
  return (
    agent !== null &&
    sameWorkspaceDefinition(agent.workspace, original.workspace) &&
    agent.workspaceRepoId === original.workspaceRepoId &&
    samePlacement(placementTargetOf(agent), placementTargetOf(original)) &&
    agent.lastModifiedAt.getTime() === original.lastModifiedAt.getTime()
  )
}

export class AgentMoveService {
  constructor(private readonly deps: AgentMoveDeps) {}

  /** Idempotent repair path for a retry whose DB placement already equals target. */
  async ensureActive(agent: AgentRecord): Promise<AgentRecord> {
    return this.withMoveGate(agent.id, async () => this.ensureActiveLocked(await this.reloadAfterGate(agent)))
  }

  /** Resume a durable daemon-side staging fence reported during register. The
   * queued gate waits for the request that lost its socket to settle first, then
   * re-checks authoritative placement before sending any activation material. */
  async recoverStaged(agentId: AgentId, daemonId: DaemonId, moveId: string): Promise<void> {
    try {
      await this.recoverStagedOnce(agentId, daemonId, moveId)
    } catch (err) {
      this.deps.log?.warn({ err, agentId, daemonId }, 'agent move: staged reconnect recovery failed')
    }
  }

  async move(agent: AgentRecord, target: PlacementTarget, editor?: string): Promise<AgentRecord> {
    return this.withMoveGate(agent.id, async () =>
      this.moveLocked(await this.reloadAfterGate(agent), target, editor, 'required')
    )
  }

  /** Disaster recovery for a source daemon that cannot confirm detach. Target
   * admission and activation remain fully acknowledged; only the source handoff
   * becomes best-effort. */
  async forceReassign(agent: AgentRecord, target: PlacementTarget, editor?: string): Promise<AgentRecord> {
    return this.withMoveGate(agent.id, async () =>
      this.moveLocked(await this.reloadAfterGate(agent), target, editor, 'best-effort')
    )
  }

  /** Cold-edit any workspace definition. The daemon reconciles mode/repo/branch
   *  under its move fence and preserves a checkout only when its materialization
   *  is unchanged. */
  async setWorkspace(
    agent: AgentRecord,
    workspace: AgentWorkspace,
    workspaceRepoId?: bigint,
    editor?: string
  ): Promise<AgentRecord> {
    return this.withMoveGate(agent.id, async () =>
      this.setWorkspaceLocked(await this.reloadAfterGate(agent), workspace, workspaceRepoId, editor)
    )
  }

  private async reloadAfterGate(observed: AgentRecord): Promise<AgentRecord> {
    const current = await this.deps.agents.getUnscoped(observed.id)
    if (!current) throw new AgentMoveConflict('agent was deleted while preparing the move; refresh and retry')
    if (
      !samePlacement(placementTargetOf(current), placementTargetOf(observed)) ||
      current.lastModifiedAt.getTime() !== observed.lastModifiedAt.getTime()
    ) {
      throw new AgentMoveConflict('agent changed while preparing the move; refresh and retry')
    }
    return current
  }

  private async withMoveGate<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const release = this.deps.mutations.tryBeginMove(agentId)
    if (!release) throw new AgentMoveConflict('agent is already being modified or moved; refresh and retry')
    try {
      return await run()
    } finally {
      release()
    }
  }

  private async recoverStagedOnce(agentId: AgentId, daemonId: DaemonId, moveId: string): Promise<void> {
    const release = await this.deps.mutations.beginMoveWhenIdle(agentId)
    try {
      const current = await this.deps.agents.getUnscoped(agentId)
      if (!current) return
      if (!(await (this.deps.placement ?? PLACEMENT_ONLY).mayAct(current, daemonId))) {
        // A member that missed a set-commit unstage while offline reports its stale fence here (#1093).
        await this.unstageReportedFence(current, daemonId)
        return
      }

      const candidate = await this.snapshotOwned(agentId, daemonId, current.orgId)
      const resumed = await this.deps.control.agentActivate(
        daemonId,
        {
          ...this.activationDefinition(candidate.agent, candidate.bundle),
          moveId,
          reconcileWorkspace: true
        },
        candidate.agent.orgId
      )

      let stable: ActivationSnapshot
      if (resumed.ok) {
        const observed = await this.snapshotOwned(agentId, daemonId, current.orgId)
        if (candidate.fingerprint === observed.fingerprint) {
          const confirmed = await this.deps.agents.getUnscoped(agentId)
          if (!confirmed || !(await (this.deps.placement ?? PLACEMENT_ONLY).mayAct(confirmed, daemonId))) {
            return this.failClosedOwnership(agentId, daemonId, current.orgId)
          }
          stable = { ...observed, agent: confirmed }
        } else {
          stable = await this.activateUntilStable(agentId, daemonId, 'staged reconnect recovery', current.orgId, {
            reconcileWorkspace: true
          })
        }
      } else {
        // A conversion may have crashed after swapping its checkout, where the
        // old token retains a one-shot empty-workspace guard. A fresh generic
        // token safely supersedes that fence and completes from current CP state.
        stable = await this.activateUntilStable(agentId, daemonId, 'staged reconnect recovery', current.orgId, {
          reconcileWorkspace: true
        })
      }
      await this.convergeDerived(stable.agent, stable.bundle.httpBotIds)
    } finally {
      release()
    }
  }

  private async ensureActiveLocked(agent: AgentRecord): Promise<AgentRecord> {
    const placement = placementTargetOf(agent)
    if (placement.kind === 'unplaced') throw new AgentMoveConflict('agent is not placed')
    // Repairing a pool placement is the ledger's job: re-derive the duty group, clear any stale
    // member fence that would make the next grant a dark hold, and let the lease exchange install.
    if (placement.kind !== 'daemon') {
      this.deps.recomputeDuties?.(agent.orgId)
      await this.unstageEligibleSources(agent, new Map(), placement)
      await this.convergeDerived(agent, (await this.snapshot(agent)).httpBotIds)
      return agent
    }
    const daemonId = placement.daemonId
    let stable: ActivationSnapshot
    try {
      stable = await this.activateUntilStable(agent.id, daemonId, 'target repair', agent.orgId, {
        reconcileWorkspace: true
      })
    } catch (err) {
      if (err instanceof AgentMoveFailed) throw err
      throw new AgentMoveFailed('target daemon repair failed', err)
    }
    await this.convergeDerived(stable.agent, stable.bundle.httpBotIds)
    return stable.agent
  }

  private async setWorkspaceLocked(
    agent: AgentRecord,
    workspace: AgentWorkspace,
    workspaceRepoId?: bigint,
    editor?: string
  ): Promise<AgentRecord> {
    if (workspace.mode === 'github' && workspaceRepoId === undefined) {
      throw new AgentMoveConflict('a GitHub workspace requires a resolved repository')
    }
    // The member to fence and re-activate: placement when it names a machine, otherwise whichever
    // pool member currently holds the agent. Nothing serving it ⇒ this is a cold edit.
    const servingDaemonId = await (this.deps.placement ?? PLACEMENT_ONLY).servingDaemon(agent)
    if (sameWorkspace(agent, workspace, workspaceRepoId)) {
      if (!servingDaemonId) {
        await this.finalizeWorkspaceChange(agent, workspaceRepoId, [])
        return agent
      }
      // Lost-response repair: the daemon's durable materialization marker makes
      // this replay idempotent even when the prior edit changed repo/branch/mode.
      const stable = await this.activateUntilStable(agent.id, servingDaemonId, 'workspace edit repair', agent.orgId, {
        reconcileWorkspace: true
      })
      await this.finalizeWorkspaceChange(stable.agent, workspaceRepoId, stable.bundle.httpBotIds)
      return stable.agent
    }

    if (!servingDaemonId) {
      let converted: AgentRecord | null = null
      try {
        converted = await this.deps.agents.setWorkspace(
          agent.orgId,
          agent.id,
          agent.lastModifiedAt,
          agent.workspace.mode,
          workspace,
          workspaceRepoId,
          editor
        )
      } catch (err) {
        const observed = await this.deps.agents.getUnscoped(agent.id).catch(() => null)
        if (observed && !isPlaced(observed) && sameWorkspace(observed, workspace, workspaceRepoId)) {
          converted = observed
        } else if (err instanceof AgentWorkspaceIntegrationConflict) {
          throw new AgentMoveConflict(err.message)
        } else {
          throw new AgentMoveFailed('failed to persist the workspace settings', err)
        }
      }
      if (!converted) throw new AgentMoveConflict('agent changed while editing its workspace; refresh and retry')
      await this.finalizeWorkspaceChange(converted, workspaceRepoId, [])
      return converted
    }

    const daemonId = servingDaemonId
    const bundle = await this.snapshot(agent)
    const moveId = randomUUID()
    let detached: Ack
    try {
      detached = await this.deps.control.agentDetach(daemonId, { agentId: agent.id, moveId }, agent.orgId)
    } catch (err) {
      throw new AgentMoveFailed('workspace edit could not drain the agent', err)
    }
    if (!detached.ok) {
      throw new AgentMoveConflict(detached.reason ?? 'workspace edit was rejected by the daemon')
    }

    let converted: AgentRecord | null = null
    let persistenceError: unknown
    try {
      converted = await this.deps.agents.setWorkspace(
        agent.orgId,
        agent.id,
        agent.lastModifiedAt,
        agent.workspace.mode,
        workspace,
        workspaceRepoId,
        editor
      )
    } catch (err) {
      persistenceError = err
    }
    if (!converted) {
      let observed: AgentRecord | null
      try {
        observed = await this.deps.agents.getUnscoped(agent.id)
      } catch (readError) {
        // The write may have committed even though its response was lost. Keep
        // the daemon fenced until a retry can prove which definition owns it.
        throw new AgentMoveFailClosed('workspace persistence outcome could not be confirmed; retry the same edit', {
          persistenceError,
          readError
        })
      }

      if (observed && isPlaced(observed) && sameWorkspace(observed, workspace, workspaceRepoId)) {
        // The CAS committed and only its response was lost. Continue from the
        // durable GitHub definition instead of reviving stale scratch authority.
        converted = observed
      } else if (isUnchangedWorkspace(observed, agent)) {
        await this.restoreDetachedWorkspace(
          daemonId,
          agent,
          bundle,
          moveId,
          persistenceError ? 'workspace persistence failed' : 'workspace compare-and-set failed'
        )
        if (persistenceError) {
          if (persistenceError instanceof AgentWorkspaceIntegrationConflict) {
            throw new AgentMoveConflict(persistenceError.message)
          }
          throw new AgentMoveFailed('failed to persist the workspace settings', persistenceError)
        }
        throw new AgentMoveConflict('agent changed while editing its workspace; refresh and retry')
      } else {
        throw new AgentMoveFailClosed(
          'agent changed while workspace persistence was unresolved; retry after inspecting its current workspace',
          persistenceError
        )
      }
    }

    // Everything sent from here on carries a POST-CAS `configRevision`, so the repository
    // allowlist has to be read after the CAS too. Its writers — the grant routes and the
    // asynchronous rename repair — advance the same per-agent counter without holding this
    // section, so replaying the pre-detach list at the newer revision is exactly the
    // equal-revision/different-content violation the daemon refuses on every reconnect.
    let postCas: MoveBundle
    try {
      postCas = { ...bundle, additionalRepos: await this.deps.specs.additionalReposOf(converted) }
    } catch (err) {
      throw new AgentMoveFailed(
        'workspace edit could not re-read the authorized repositories; retry the same edit',
        err
      )
    }

    let activated: Ack
    try {
      activated = await this.deps.control.agentActivate(
        daemonId,
        {
          ...this.activationDefinition(converted, postCas),
          moveId,
          reconcileWorkspace: true
        },
        converted.orgId
      )
    } catch (err) {
      // The daemon may have committed and only lost the response. Never roll DB
      // authority back on an unknown outcome; the same request repairs safely.
      throw new AgentMoveFailed('workspace edit outcome is uncertain; retry the same edit', err)
    }
    if (!activated.ok) {
      await this.rollbackWorkspaceChange(agent, converted, postCas, moveId, activated.reason)
    }

    await this.finalizeWorkspaceChange(converted, workspaceRepoId, bundle.httpBotIds)
    return converted
  }

  private async moveLocked(
    agent: AgentRecord,
    target: PlacementTarget,
    editor: string | undefined,
    sourceDetachMode: SourceDetachMode
  ): Promise<AgentRecord> {
    const source = placementTargetOf(agent)
    // Every member serving the agent today, not only the one placement names: a `pool` agent is
    // served by whoever holds its duty, so moving it onto a machine has to quiesce that member or
    // the machine it lands on and the member it left both run it.
    const sourceDaemonIds = (await (this.deps.placement ?? PLACEMENT_ONLY).servingDaemons(agent)) as DaemonId[]
    // Retained only as compensation input if the source is detached but the
    // placement CAS never commits. The target always receives a fresh post-CAS
    // snapshot, never this pre-detach copy.
    const sourceBundle = await this.snapshot(agent)

    const stagedSources = new Map<DaemonId, string>()
    for (const sourceDaemonId of sourceDaemonIds) {
      const moveId = randomUUID()
      stagedSources.set(sourceDaemonId, moveId)
      try {
        requireAck(
          'source cutover',
          await this.detach(sourceDaemonId, agent.id, agent.orgId, { moveId, discardActiveTurns: true })
        )
      } catch (err) {
        if (sourceDetachMode === 'required') {
          if (err instanceof AgentMoveFailed) throw err
          throw new AgentMoveFailed('source daemon cutover failed', err)
        }
        this.deps.log?.warn(
          { err, agentId: agent.id, sourceDaemonId, target: placementLabel(target) },
          'agent force reassign: source detach unconfirmed; continuing by operator request'
        )
      }
      try {
        const released = await this.deps.assignments.releaseForAgent(agent.id, sourceDaemonId, new Date())
        for (const key of released) this.deps.sessionOwners.releaseSession(key)
      } catch (err) {
        await this.bestEffortBootstrap(
          'source restore after affinity release failure',
          sourceDaemonId,
          agent,
          sourceBundle
        )
        throw new AgentMoveFailed('failed to release source session affinities', err)
      }
    }

    let moved: AgentRecord | null
    try {
      moved = await this.deps.agents.movePlacement(agent.id, source, target, editor)
      if (moved) this.deps.recomputeDuties?.(moved.orgId)
    } catch (err) {
      await this.restoreSourceIfStillOwner(agent, source, sourceBundle)
      throw new AgentMoveFailed('failed to persist agent placement', err)
    }
    if (!moved) {
      await this.restoreSourceIfStillOwner(agent, source, sourceBundle)
      throw new AgentMoveConflict('agent placement changed concurrently; refresh and retry')
    }

    // A pool target has no daemon to bootstrap, and that is the design rather than a gap: the
    // ledger grants the agent's group to a live member, which installs exactly this bundle
    // through `duty/fetch` and starts serving. Committing the placement IS the move — a
    // synchronous activation would only name one member the ledger is free to replace next beat.
    if (target.kind !== 'daemon') {
      await this.unstageEligibleSources(moved, stagedSources, target)
      await this.convergeDerived(moved, sourceBundle.httpBotIds)
      return moved
    }

    const targetDaemonId = target.daemonId
    let stable: ActivationSnapshot
    try {
      // Re-read the full wire definition only AFTER the placement CAS. The
      // stability loop re-reads after each ACK and re-stages/re-activates if an
      // out-of-band writer changed any spec, integration, secret, or cron.
      stable = await this.activateUntilStable(moved.id, targetDaemonId, 'target', moved.orgId)
    } catch (err) {
      if (err instanceof AgentMoveFailClosed) throw err
      const rolledBack = await this.rollback(agent, moved, source, targetDaemonId, editor, sourceBundle)
      if (!rolledBack) {
        throw new AgentMoveFailed(
          'target bootstrap failed and target detach was not confirmed; placement remains on target for manual recovery',
          err
        )
      }
      if (err instanceof AgentMoveFailed) throw err
      throw new AgentMoveFailed('target daemon bootstrap failed', err)
    }

    await this.convergeDerived(stable.agent, stable.bundle.httpBotIds)
    return stable.agent
  }

  /** Clear staging fences wherever the new placement makes a daemon an eligible holder again (#1093). */
  private async unstageEligibleSources(
    agent: AgentRecord,
    stagedSources: ReadonlyMap<DaemonId, string>,
    target: PlacementTarget
  ): Promise<void> {
    const memberSets = this.deps.memberSets
    if (!memberSets) return
    // A set commit also clears fences from EARLIER moves off that set (pool→machine→pool), token-less.
    const staleMembers =
      target.kind === 'set'
        ? (await this.liveSetMembers(target.setId)).filter((daemonId) => !stagedSources.has(daemonId))
        : []
    if (stagedSources.size === 0 && staleMembers.length === 0) return
    const columns = placementColumns(target)
    const bundle = await this.snapshot(agent)
    // The arming token releases the fence and leaves the replica current; non-members stay fenced.
    for (const [daemonId, moveId] of stagedSources) {
      const setId = await memberSets.setIdOf(daemonId)
      if (!mayHold(columns, { daemonId, scope: claimScopeOf({ setId }) })) continue
      await this.bestEffortUnstage(agent, bundle, daemonId, moveId)
    }
    for (const daemonId of staleMembers) await this.bestEffortUnstage(agent, bundle, daemonId)
  }

  private async bestEffortUnstage(
    agent: AgentRecord,
    bundle: MoveBundle,
    daemonId: DaemonId,
    moveId?: string
  ): Promise<void> {
    try {
      requireAck(
        'source unstage',
        await this.deps.control.agentActivate(
          daemonId,
          { ...this.activationDefinition(agent, bundle), ...(moveId === undefined ? {} : { moveId }) },
          agent.orgId
        )
      )
    } catch (err) {
      this.deps.log?.warn(
        { err, agentId: agent.id, daemonId },
        'agent move: could not clear the source staging fence; its reconnect reconcile is the backstop'
      )
    }
  }

  /** Reconnect backstop: release a reported fence when the reporter is an eligible set member. */
  private async unstageReportedFence(agent: AgentRecord, daemonId: DaemonId): Promise<void> {
    const memberSets = this.deps.memberSets
    const target = placementTargetOf(agent)
    if (!memberSets || target.kind !== 'set') return
    const setId = await memberSets.setIdOf(daemonId)
    if (!mayHold(placementColumns(target), { daemonId, scope: claimScopeOf({ setId }) })) return
    // Token-less like the commit broadcast: `mayAct` said no, so this member must release without running.
    await this.bestEffortUnstage(agent, await this.snapshot(agent), daemonId)
  }

  /** The target set's READY members — who a set commit may need to unstage. */
  private async liveSetMembers(setId: string): Promise<DaemonId[]> {
    const { memberSets, liveness } = this.deps
    if (!memberSets || !liveness) return []
    return (await memberSets.memberIdsOf(setId)).filter((daemonId) => {
      const live = liveness.get(daemonId)
      return live?.reachable === true && live.state === 'READY'
    }) as DaemonId[]
  }

  private async restoreDetachedWorkspace(
    daemonId: DaemonId,
    agent: AgentRecord,
    bundle: MoveBundle,
    moveId: string,
    after: string,
    detail?: string
  ): Promise<void> {
    try {
      requireAck(
        `workspace restore after ${after}`,
        await this.deps.control.agentActivate(
          daemonId,
          {
            ...this.activationDefinition(agent, bundle),
            moveId,
            reconcileWorkspace: true
          },
          agent.orgId
        )
      )
    } catch (err) {
      // The rejection that started this is what an operator has to act on; the restoration failure
      // is the reason it is fail-closed. Dropping the first left the message naming only the second.
      throw new AgentMoveFailClosed(
        `${after}${detail ? ` (${detail})` : ''} and the original workspace could not be reactivated`,
        err
      )
    }
  }

  private async rollbackWorkspaceChange(
    original: AgentRecord,
    converted: AgentRecord,
    bundle: MoveBundle,
    moveId: string,
    reason?: string
  ): Promise<never> {
    let restored: AgentRecord | null
    try {
      restored = await this.deps.agents.restoreWorkspace(
        converted.orgId,
        converted.id,
        converted.lastModifiedAt,
        converted.workspace,
        converted.workspaceRepoId,
        original.workspace,
        original.workspaceRepoId
      )
    } catch (err) {
      throw new AgentMoveFailClosed('workspace edit was rejected and its database rollback failed', err)
    }
    if (!restored) {
      throw new AgentMoveFailClosed(
        'workspace edit was rejected but the agent changed before rollback; manual recovery is required'
      )
    }
    // The RESTORED row, not the pre-edit copy: the rollback advanced its revision past the rejected
    // edit's, and the daemon's fence refuses a bundle whose spec is not newer than the one it just
    // applied. Replaying `original` therefore could not restore anything the target had accepted —
    // every rejected edit ended fail-closed with the agent staged and offline.
    //
    // The list is read against THAT row for the same reason the forward activation reads it after
    // its own CAS: a grant writer that committed while the rejected activation was in flight sits
    // under this restore's revision, so the caller's copy would ship stale content at it.
    let restoredBundle: MoveBundle
    try {
      restoredBundle = { ...bundle, additionalRepos: await this.deps.specs.additionalReposOf(restored) }
    } catch (err) {
      throw new AgentMoveFailClosed(
        'workspace edit was rejected and the authorized repositories could not be re-read for its rollback',
        err
      )
    }
    await this.restoreDetachedWorkspace(
      (await (this.deps.placement ?? PLACEMENT_ONLY).servingDaemon(converted))!,
      restored,
      restoredBundle,
      moveId,
      'workspace activation rejection',
      reason
    )
    await this.convergeDerived(restored, restoredBundle.httpBotIds)
    throw new AgentMoveFailed(`workspace edit rejected${reason ? `: ${reason}` : ''}`)
  }

  private async finalizeWorkspaceChange(
    agent: AgentRecord,
    workspaceRepoId: bigint | undefined,
    httpBotIds: string[]
  ): Promise<void> {
    if (agent.workspace.mode !== 'github' || workspaceRepoId === undefined) {
      await this.convergeDerived(agent, httpBotIds)
      return
    }
    try {
      // Classify the target as the implicit workspace repo and remove the now-
      // redundant explicit grant without tombstoning valid review projections.
      if (await this.deps.agents.setWorkspaceRepoId(agent.id, workspaceRepoId)) {
        // The cleanup runs AFTER the activation, and it both advances the revision and can drop a
        // row the activation still listed in `workspace.additionalRepos` — so the daemon would
        // otherwise carry the new primary repo as an additional one until it reconnected.
        await this.pushPostCleanupSpec(agent)
      } else {
        this.deps.log?.warn(
          { agentId: agent.id, workspaceRepoId: workspaceRepoId.toString() },
          'workspace edit: redundant repository grant cleanup deferred'
        )
      }
    } catch (err) {
      // Authority already moved successfully; grant cleanup is safe to retry via
      // lazy workspace-id repair and must not turn a committed edit into 5xx.
      this.deps.log?.warn({ err, agentId: agent.id }, 'workspace edit: repository grant cleanup deferred')
    }
    await this.convergeDerived(agent, httpBotIds)
  }

  /** Best-effort: the reconnect roster is the backstop, and the edit itself already committed. */
  private async pushPostCleanupSpec(agent: AgentRecord): Promise<void> {
    const fresh = await this.deps.agents.getUnscoped(agent.id)
    if (!fresh) return
    const spec = await this.deps.specs.assemble(fresh)
    for (const daemonId of await (this.deps.placement ?? PLACEMENT_ONLY).servingDaemons(fresh)) {
      try {
        await this.deps.control.agentUpsert(daemonId, { agentId: fresh.id, spec }, fresh.orgId)
      } catch (err) {
        this.deps.log?.warn(
          { err, agentId: fresh.id, daemonId },
          'workspace edit: post-cleanup agent/upsert failed (backstop: reconnect roster)'
        )
      }
    }
  }

  /**
   * The complete installable definition of one agent — secrets, org environment,
   * skills, integration specs, crons, and the two definition kinds the spec only
   * NAMES (its proxied MCP servers and its external-memory connection) — with no
   * move token, staging fence, or placement assertion attached.
   *
   * Used only by `duty/fetch`. The MCP and memory defs come from the SAME
   * projector the reconnect roster uses, scoped to this one agent's references,
   * so a holder's install and its next snapshot cannot disagree and the reply
   * carries nothing beyond what the duty it already holds covers. A move keeps
   * its narrower `activationDefinition` — placement moves converge these two
   * kinds through their own live pushes and the target's register.
   */
  async bundleFor(agent: AgentRecord): Promise<DutyAgentBundle> {
    const log = { warn: (obj: object, msg: string) => this.deps.log?.warn(obj, msg) }
    const [snapshot, mcpServers, memoryConnections] = await Promise.all([
      this.snapshot(agent),
      mcpDefsForAgents([agent], this.deps.mcp, log, { agentId: agent.id }),
      memoryDefsForAgents([agent], this.deps.memory, log, { agentId: agent.id })
    ])
    return { ...this.activationDefinition(agent, snapshot), mcpServers, memoryConnections }
  }

  /** Read every placement-dependent wire definition. */
  private async snapshot(agent: AgentRecord): Promise<MoveBundle> {
    const [
      integrations,
      cronRows,
      secrets,
      skills,
      managedSkills,
      organizationEnvironment,
      additionalRepos,
      gitlabHook
    ] = await Promise.all([
      this.deps.integrations.listForAgent(agent.id),
      this.deps.crons.listForAgent(agent.id),
      this.deps.specs.secretsOf(agent),
      this.deps.specs.skillsOf(agent),
      this.deps.specs.managedSkillsOf(agent),
      this.deps.specs.organizationEnvironmentOf(agent),
      this.deps.specs.additionalReposOf(agent),
      this.deps.specs.gitlabHookOf(agent)
    ])
    const specs = await Promise.all(
      integrations.map(async (integration) => {
        const [bot, secret, channels] = await Promise.all([
          // Orchestration: the bot behind an integration row of the agent being
          // moved — org derived from the record in hand (org-scoped-data-layer.md §4).
          this.deps.bots.getUnscoped(integration.botId),
          this.deps.botSecrets.get(integration.orgId, integration.botId),
          this.deps.integrationChannels.listForIntegration(integration.id)
        ])
        if (!bot) throw new AgentMoveConflict(`integration ${integration.id} has no bot`)
        if (!secret) throw new AgentMoveConflict(`integration ${integration.id} has no credentials`)
        const isHttp = bot.transport === 'http'
        const gated = isGatedAgent(agent)
        return {
          botId: String(bot.id),
          http: isHttp,
          spec: isHttp
            ? await httpIntegrationToSpec(this.deps.platforms, integration, bot, secret, channels, gated)
            : await integrationToSpec(this.deps.platforms, integration, bot, secret, channels, gated)
        }
      })
    )
    specs.sort((a, b) => a.spec.integrationId.localeCompare(b.spec.integrationId))
    const crons = cronRows
      .map(cronToUpsert)
      .filter((cron): cron is CronUpsert => cron !== null)
      .sort((a, b) => a.cronId.localeCompare(b.cronId))
    return {
      integrations: specs,
      crons,
      httpBotIds: [...new Set(specs.filter((s) => s.http).map((s) => s.botId))].sort(),
      secrets,
      skills,
      managedSkills,
      organizationEnvironment,
      additionalRepos,
      gitlabHook
    }
  }

  private activationDefinition(agent: AgentRecord, bundle: MoveBundle): Omit<AgentActivate, 'moveId'> {
    return {
      agentId: agent.id,
      // project() (not assemble()): the snapshot pinned the secrets, skills, and
      // resolved organization environment into the bundle so the activation
      // fingerprint compares stable inputs.
      spec: this.deps.specs.project(
        agent,
        bundle.secrets,
        bundle.skills,
        bundle.managedSkills,
        bundle.organizationEnvironment,
        bundle.additionalRepos,
        bundle.gitlabHook
      ),
      integrations: bundle.integrations.map(({ spec }) => spec),
      crons: bundle.crons
    }
  }

  private async snapshotOwned(agentId: AgentId, targetDaemonId: DaemonId, orgId: string): Promise<ActivationSnapshot> {
    const agent = await this.deps.agents.getUnscoped(agentId)
    // "Still ours" is the resolver's answer, not placement equality: a pool member legitimately
    // acts for an agent whose placement names no machine, and only the ledger can say so.
    if (!agent || !(await (this.deps.placement ?? PLACEMENT_ONLY).mayAct(agent, targetDaemonId))) {
      return this.failClosedOwnership(agentId, targetDaemonId, orgId)
    }
    const bundle = await this.snapshot(agent)
    return {
      agent,
      bundle,
      fingerprint: JSON.stringify(this.activationDefinition(agent, bundle))
    }
  }

  /**
   * Activate only a post-CAS snapshot, then prove that the full wire definition
   * stayed stable across the ACK. A changed snapshot is re-staged and replayed
   * with the same move token; persistent churn fails into the normal rollback.
   */
  private async activateUntilStable(
    agentId: AgentId,
    targetDaemonId: DaemonId,
    label: string,
    orgId: string,
    workspace: Pick<AgentActivate, 'prepareWorkspace' | 'reconcileWorkspace'> = {}
  ): Promise<ActivationSnapshot> {
    let candidate = await this.snapshotOwned(agentId, targetDaemonId, orgId)
    for (let attempt = 1; attempt <= MAX_STABILITY_ATTEMPTS; attempt += 1) {
      // A committed token is idempotent by design, so every replay needs a new
      // detach/activate token pair. The newer detach also fences a delayed
      // activate from any prior attempt.
      await this.bootstrap(targetDaemonId, candidate.agent, candidate.bundle, `${label} attempt ${attempt}`, workspace)
      const observed = await this.snapshotOwned(agentId, targetDaemonId, orgId)
      if (candidate.fingerprint === observed.fingerprint) {
        // Explicit final ownership read: an agent deleted or re-placed after the
        // ACK must never leave this target serving an orphaned copy.
        const confirmed = await this.deps.agents.getUnscoped(agentId)
        if (!confirmed || !(await (this.deps.placement ?? PLACEMENT_ONLY).mayAct(confirmed, targetDaemonId))) {
          return this.failClosedOwnership(agentId, targetDaemonId, orgId)
        }
        return { ...observed, agent: confirmed }
      }
      candidate = observed
    }
    throw new AgentMoveFailed(
      `agent definition did not stabilize after ${MAX_STABILITY_ATTEMPTS} target activation attempts`
    )
  }

  private async failClosedOwnership(agentId: AgentId, targetDaemonId: DaemonId, orgId: string): Promise<never> {
    try {
      requireAck('target detach after ownership change', await this.detach(targetDaemonId, agentId, orgId))
    } catch (err) {
      throw new AgentMoveFailClosed(
        'agent placement changed during move and target detach was not confirmed; manual recovery is required',
        err
      )
    }
    throw new AgentMoveFailClosed('agent placement changed during move; target was detached and the move stopped')
  }

  private detach(
    daemonId: DaemonId,
    agentId: AgentId,
    orgId: string,
    options: { moveId?: string; discardActiveTurns?: boolean } = {}
  ): Promise<Ack> {
    return this.deps.control.agentDetach(
      daemonId,
      {
        agentId,
        moveId: options.moveId ?? randomUUID(),
        ...(options.discardActiveTurns ? { discardActiveTurns: true } : {})
      },
      orgId
    )
  }

  private async rollback(
    sourceAgent: AgentRecord,
    moved: AgentRecord,
    source: PlacementTarget,
    targetDaemonId: DaemonId,
    editor: string | undefined,
    bundle: MoveBundle
  ): Promise<boolean> {
    // Never reactivate the source unless target quiescence is positively ACKed:
    // an unavailable target may still be running the partial copy, and restoring
    // source in that state would create split brain.
    try {
      requireAck('target detach rollback', await this.detach(targetDaemonId, moved.id, moved.orgId))
    } catch (err) {
      this.deps.log?.warn(
        { err, agentId: moved.id, targetDaemonId },
        'agent move: target detach unconfirmed; placement left on target for manual recovery'
      )
      return false
    }
    let restored: AgentRecord | null = null
    try {
      restored = await this.deps.agents.movePlacement(
        moved.id,
        { kind: 'daemon', daemonId: targetDaemonId },
        source,
        editor
      )
      if (restored) this.deps.recomputeDuties?.(restored.orgId)
    } catch (err) {
      this.deps.log?.warn({ err, agentId: moved.id }, 'agent move: placement rollback failed')
    }
    // Only a machine source has a bootstrap to restore. A pool source is restored by the ledger:
    // the placement is back, so the next sweep re-grants the group and install-on-grant replays.
    if (restored && source.kind === 'daemon') {
      await this.bestEffortBootstrap('source bootstrap rollback', source.daemonId, sourceAgent, bundle)
    }
    return restored !== null
  }

  private async restoreSourceIfStillOwner(
    agent: AgentRecord,
    source: PlacementTarget,
    bundle: MoveBundle
  ): Promise<void> {
    if (source.kind !== 'daemon') return
    const current = await this.deps.agents.getUnscoped(agent.id).catch(() => null)
    if (!current || !samePlacement(placementTargetOf(current), source)) return
    await this.bestEffortBootstrap('source bootstrap after CAS failure', source.daemonId, agent, bundle)
  }

  /** Stage first, then install one authoritative bundle under the daemon gate. */
  private async bootstrap(
    daemonId: DaemonId,
    agent: AgentRecord,
    bundle: MoveBundle,
    label: string,
    workspace: Pick<AgentActivate, 'prepareWorkspace' | 'reconcileWorkspace'> = {}
  ): Promise<void> {
    // Live CRUD EVTs are intentionally not part of move bootstrap: they are
    // unacknowledged and could expose a partially-applied or stale same-ID
    // definition. Activate persists, exact-prunes, reconciles, and warms this
    // complete snapshot synchronously while the staging tombstone remains armed.
    const moveId = randomUUID()
    requireAck(`${label} staging detach`, await this.detach(daemonId, agent.id, agent.orgId, { moveId }))
    requireAck(
      `${label} activate`,
      await this.deps.control.agentActivate(
        daemonId,
        {
          ...this.activationDefinition(agent, bundle),
          moveId,
          ...workspace
        },
        agent.orgId
      )
    )
  }

  private async bestEffortBootstrap(
    action: string,
    daemonId: DaemonId,
    agent: AgentRecord,
    bundle: MoveBundle
  ): Promise<void> {
    try {
      await this.bootstrap(daemonId, agent, bundle, action)
    } catch (err) {
      this.deps.log?.warn({ action, err, agentId: agent.id }, 'agent move: source restore failed')
    }
  }

  /** The placement and daemon activation are already committed, and every one of these projections
   *  has a reconnect/replay backstop, so a transient fan-out error is logged rather than turning a
   *  committed move into a 500. Shared with the duty path (`orchestrator/agentRouting.ts`): a
   *  holder change moves who serves the agent exactly as a placement move does, and two copies of
   *  this list would be two chances to forget one. */
  private async convergeDerived(agent: AgentRecord, httpBotIds: string[]): Promise<void> {
    await convergeAgentRouting(
      this.deps,
      { agentId: agent.id, orgId: agent.orgId, httpBotIds },
      { warn: (obj, msg) => this.deps.log?.warn(obj, msg) }
    )
  }
}
