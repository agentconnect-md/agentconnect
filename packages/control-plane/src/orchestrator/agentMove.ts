/**
 * Safe cold agent movement between daemons.
 *
 * The source daemon first ACKs `agent/detach`, which drains the running turn and
 * archives the complete agent root out of the active tree. Only then does the CP
 * compare-and-set `Agent.daemonId`. The target is bootstrapped from the durable CP
 * definition and activated last. A failed target bootstrap is compensated by
 * detaching the partial target, moving the DB placement back, and reactivating the
 * source archive.
 *
 * This is deliberately a cold reprovision, not state migration: workspace,
 * transcript, and memory bytes remain daemon-local.
 */
import { randomUUID } from 'node:crypto'
import {
  gitRepoLabel,
  type Ack,
  type AgentActivate,
  type AgentSkillEntry,
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
  AgentWorkspace,
  IntegrationChannelRepo,
  IntegrationRepo
} from '../persistence/ports.js'
import { AgentWorkspaceIntegrationConflict } from '../persistence/errors.js'
import type { AgentId, DaemonId } from '../domain/ids.js'
import { cronToUpsert, integrationToSpec, isGatedAgent, sharedIntegrationToSpec } from './placement.js'
import type { AgentSpecAssembler } from './agentSpecAssembler.js'
import type { ControlSender } from './outbound.js'
import type { HookService } from '../hooks/hook.service.js'
import type { SharedBotOrchestrator } from './sharedBot.js'
import type { CollabRoutesService } from './collabRoutes.service.js'
import type { AgentMutationGate } from './agentMutationGate.js'
import type { SessionKey } from '../domain/sessionKey.js'

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
  /** Owns AgentSpec assembly (secret loading + icon bases) for the activation definition. */
  specs: AgentSpecAssembler
  crons: CronRepo
  control: ControlSender
  hooks: HookService
  sharedBot: SharedBotOrchestrator
  collabRoutes: CollabRoutesService
  mutations: AgentMutationGate
  sessionOwners: { releaseSession(key: SessionKey): void }
  log?: AgentMoveLog
}

interface MoveBundle {
  integrations: Array<{ spec: IntegrationSpec; botId: string; shared: boolean }>
  crons: CronUpsert[]
  sharedBotIds: string[]
  /** The agent's write-only secret env vars (AgentSecretStore) — part of the wire
   *  definition, so a mid-move secret edit trips the fingerprint stability check. */
  secrets: Record<string, string>
  /** Resolved skill entries (shared-skills.md) — pinned so the authoritative
   *  `agent/activate` ships them; a bare project() would clear skills on the target. */
  skills: AgentSkillEntry[]
}

interface ActivationSnapshot {
  agent: AgentRecord
  bundle: MoveBundle
  fingerprint: string
}

const MAX_STABILITY_ATTEMPTS = 3

function requireAck(action: string, ack: Ack): void {
  if (!ack.ok) throw new AgentMoveFailed(`${action} rejected${ack.reason ? `: ${ack.reason}` : ''}`)
}

function sameWorkspaceDefinition(left: AgentWorkspace, right: AgentWorkspace): boolean {
  if (left.mode !== right.mode) return false
  if (left.mode === 'scratch' || right.mode === 'scratch') return true
  return (
    gitRepoLabel(left.gitRepo).toLowerCase() === gitRepoLabel(right.gitRepo).toLowerCase() &&
    (left.gitBranch ?? 'main') === (right.gitBranch ?? 'main') &&
    (left.agentDir ?? '') === (right.agentDir ?? '') &&
    left.installationId === right.installationId &&
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
    agent.daemonId === original.daemonId &&
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

  async move(agent: AgentRecord, targetDaemonId: DaemonId, editor?: string): Promise<AgentRecord> {
    return this.withMoveGate(agent.id, async () =>
      this.moveLocked(await this.reloadAfterGate(agent), targetDaemonId, editor)
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
    const current = await this.deps.agents.get(observed.id)
    if (!current) throw new AgentMoveConflict('agent was deleted while preparing the move; refresh and retry')
    if (
      current.daemonId !== observed.daemonId ||
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
      const current = await this.deps.agents.get(agentId)
      if (!current || current.daemonId !== daemonId) return

      const candidate = await this.snapshotOwned(agentId, daemonId)
      const resumed = await this.deps.control.agentActivate(daemonId, {
        ...this.activationDefinition(candidate.agent, candidate.bundle),
        moveId,
        reconcileWorkspace: true
      })

      let stable: ActivationSnapshot
      if (resumed.ok) {
        const observed = await this.snapshotOwned(agentId, daemonId)
        if (candidate.fingerprint === observed.fingerprint) {
          const confirmed = await this.deps.agents.get(agentId)
          if (!confirmed || confirmed.daemonId !== daemonId) return this.failClosedOwnership(agentId, daemonId)
          stable = { ...observed, agent: confirmed }
        } else {
          stable = await this.activateUntilStable(agentId, daemonId, 'staged reconnect recovery', {
            reconcileWorkspace: true
          })
        }
      } else {
        // A conversion may have crashed after swapping its checkout, where the
        // old token retains a one-shot empty-workspace guard. A fresh generic
        // token safely supersedes that fence and completes from current CP state.
        stable = await this.activateUntilStable(agentId, daemonId, 'staged reconnect recovery', {
          reconcileWorkspace: true
        })
      }
      await this.convergeDerived(stable.agent, stable.bundle.sharedBotIds)
    } finally {
      release()
    }
  }

  private async ensureActiveLocked(agent: AgentRecord): Promise<AgentRecord> {
    if (!agent.daemonId) throw new AgentMoveConflict('agent is not placed')
    let stable: ActivationSnapshot
    try {
      stable = await this.activateUntilStable(agent.id, agent.daemonId, 'target repair', {
        reconcileWorkspace: true
      })
    } catch (err) {
      if (err instanceof AgentMoveFailed) throw err
      throw new AgentMoveFailed('target daemon repair failed', err)
    }
    await this.convergeDerived(stable.agent, stable.bundle.sharedBotIds)
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
    if (sameWorkspace(agent, workspace, workspaceRepoId)) {
      if (!agent.daemonId) {
        await this.finalizeWorkspaceChange(agent, workspaceRepoId, [])
        return agent
      }
      // Lost-response repair: the daemon's durable materialization marker makes
      // this replay idempotent even when the prior edit changed repo/branch/mode.
      const stable = await this.activateUntilStable(agent.id, agent.daemonId, 'workspace edit repair', {
        reconcileWorkspace: true
      })
      await this.finalizeWorkspaceChange(stable.agent, workspaceRepoId, stable.bundle.sharedBotIds)
      return stable.agent
    }

    if (!agent.daemonId) {
      let converted: AgentRecord | null = null
      try {
        converted = await this.deps.agents.setWorkspace(
          agent.id,
          agent.lastModifiedAt,
          agent.workspace.mode,
          workspace,
          workspaceRepoId,
          editor
        )
      } catch (err) {
        const observed = await this.deps.agents.get(agent.id).catch(() => null)
        if (observed?.daemonId === null && sameWorkspace(observed, workspace, workspaceRepoId)) {
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

    const daemonId = agent.daemonId
    const bundle = await this.snapshot(agent)
    const moveId = randomUUID()
    let detached: Ack
    try {
      detached = await this.deps.control.agentDetach(daemonId, {
        agentId: agent.id,
        moveId
      })
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
        observed = await this.deps.agents.get(agent.id)
      } catch (readError) {
        // The write may have committed even though its response was lost. Keep
        // the daemon fenced until a retry can prove which definition owns it.
        throw new AgentMoveFailClosed('workspace persistence outcome could not be confirmed; retry the same edit', {
          persistenceError,
          readError
        })
      }

      if (observed?.daemonId === daemonId && sameWorkspace(observed, workspace, workspaceRepoId)) {
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

    let activated: Ack
    try {
      activated = await this.deps.control.agentActivate(daemonId, {
        ...this.activationDefinition(converted, bundle),
        moveId,
        reconcileWorkspace: true
      })
    } catch (err) {
      // The daemon may have committed and only lost the response. Never roll DB
      // authority back on an unknown outcome; the same request repairs safely.
      throw new AgentMoveFailed('workspace edit outcome is uncertain; retry the same edit', err)
    }
    if (!activated.ok) {
      await this.rollbackWorkspaceChange(agent, converted, bundle, moveId, activated.reason)
    }

    await this.finalizeWorkspaceChange(converted, workspaceRepoId, bundle.sharedBotIds)
    return converted
  }

  private async moveLocked(agent: AgentRecord, targetDaemonId: DaemonId, editor?: string): Promise<AgentRecord> {
    const sourceDaemonId = agent.daemonId
    // Retained only as compensation input if the source is detached but the
    // placement CAS never commits. The target always receives a fresh post-CAS
    // snapshot, never this pre-detach copy.
    const sourceBundle = await this.snapshot(agent)

    if (sourceDaemonId) {
      try {
        requireAck('source detach', await this.detach(sourceDaemonId, agent.id))
      } catch (err) {
        if (err instanceof AgentMoveFailed) throw err
        throw new AgentMoveFailed('source daemon detach failed', err)
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
      moved = await this.deps.agents.movePlacement(agent.id, sourceDaemonId, targetDaemonId, editor)
    } catch (err) {
      await this.restoreSourceIfStillOwner(agent, sourceDaemonId, sourceBundle)
      throw new AgentMoveFailed('failed to persist agent placement', err)
    }
    if (!moved) {
      await this.restoreSourceIfStillOwner(agent, sourceDaemonId, sourceBundle)
      throw new AgentMoveConflict('agent placement changed concurrently; refresh and retry')
    }

    let stable: ActivationSnapshot
    try {
      // Re-read the full wire definition only AFTER the placement CAS. The
      // stability loop re-reads after each ACK and re-stages/re-activates if an
      // out-of-band writer changed any spec, integration, secret, or cron.
      stable = await this.activateUntilStable(moved.id, targetDaemonId, 'target')
    } catch (err) {
      if (err instanceof AgentMoveFailClosed) throw err
      const rolledBack = await this.rollback(agent, moved, sourceDaemonId, targetDaemonId, editor, sourceBundle)
      if (!rolledBack) {
        throw new AgentMoveFailed(
          'target bootstrap failed and target detach was not confirmed; placement remains on target for manual recovery',
          err
        )
      }
      if (err instanceof AgentMoveFailed) throw err
      throw new AgentMoveFailed('target daemon bootstrap failed', err)
    }

    await this.convergeDerived(stable.agent, stable.bundle.sharedBotIds)
    return stable.agent
  }

  private async restoreDetachedWorkspace(
    daemonId: DaemonId,
    agent: AgentRecord,
    bundle: MoveBundle,
    moveId: string,
    after: string
  ): Promise<void> {
    try {
      requireAck(
        `workspace restore after ${after}`,
        await this.deps.control.agentActivate(daemonId, {
          ...this.activationDefinition(agent, bundle),
          moveId,
          reconcileWorkspace: true
        })
      )
    } catch (err) {
      throw new AgentMoveFailClosed(`${after} and the original workspace could not be reactivated`, err)
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
    await this.restoreDetachedWorkspace(converted.daemonId!, original, bundle, moveId, 'workspace activation rejection')
    await this.convergeDerived(restored, bundle.sharedBotIds)
    throw new AgentMoveFailed(`workspace edit rejected${reason ? `: ${reason}` : ''}`)
  }

  private async finalizeWorkspaceChange(
    agent: AgentRecord,
    workspaceRepoId: bigint | undefined,
    sharedBotIds: string[]
  ): Promise<void> {
    if (agent.workspace.mode !== 'github' || workspaceRepoId === undefined) {
      await this.convergeDerived(agent, sharedBotIds)
      return
    }
    try {
      // Classify the target as the implicit workspace repo and remove the now-
      // redundant explicit grant without tombstoning valid review projections.
      if (!(await this.deps.agents.setWorkspaceRepoId(agent.id, workspaceRepoId))) {
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
    await this.convergeDerived(agent, sharedBotIds)
  }

  /** Read every placement-dependent wire definition. */
  private async snapshot(agent: AgentRecord): Promise<MoveBundle> {
    const [integrations, cronRows, secrets, skills] = await Promise.all([
      this.deps.integrations.listForAgent(agent.id),
      this.deps.crons.listForAgent(agent.id),
      this.deps.specs.secretsOf(agent),
      this.deps.specs.skillsOf(agent)
    ])
    const specs = await Promise.all(
      integrations.map(async (integration) => {
        const [bot, secret, channels] = await Promise.all([
          this.deps.bots.get(integration.botId),
          this.deps.botSecrets.get(integration.botId),
          this.deps.integrationChannels.listForIntegration(integration.id)
        ])
        if (!bot) throw new AgentMoveConflict(`integration ${integration.id} has no bot`)
        if (!secret) throw new AgentMoveConflict(`integration ${integration.id} has no credentials`)
        const isHttp = bot.transport === 'http'
        const gated = isGatedAgent(agent)
        return {
          botId: String(bot.id),
          shared: isHttp,
          spec: isHttp
            ? sharedIntegrationToSpec(integration, secret, bot.shareable, channels, gated, bot.slackAppId ?? undefined)
            : integrationToSpec(integration, secret, channels, gated)
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
      sharedBotIds: [...new Set(specs.filter((s) => s.shared).map((s) => s.botId))].sort(),
      secrets,
      skills
    }
  }

  private activationDefinition(agent: AgentRecord, bundle: MoveBundle): Omit<AgentActivate, 'moveId'> {
    return {
      agentId: agent.id,
      // project() (not assemble()): the snapshot pinned the secrets + skills into the
      // bundle so the activation fingerprint compares stable inputs.
      spec: this.deps.specs.project(agent, bundle.secrets, bundle.skills),
      integrations: bundle.integrations.map(({ spec }) => spec),
      crons: bundle.crons
    }
  }

  private async snapshotOwned(agentId: AgentId, targetDaemonId: DaemonId): Promise<ActivationSnapshot> {
    const agent = await this.deps.agents.get(agentId)
    if (!agent || agent.daemonId !== targetDaemonId) {
      return this.failClosedOwnership(agentId, targetDaemonId)
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
    workspace: Pick<AgentActivate, 'prepareWorkspace' | 'reconcileWorkspace'> = {}
  ): Promise<ActivationSnapshot> {
    let candidate = await this.snapshotOwned(agentId, targetDaemonId)
    for (let attempt = 1; attempt <= MAX_STABILITY_ATTEMPTS; attempt += 1) {
      // A committed token is idempotent by design, so every replay needs a new
      // detach/activate token pair. The newer detach also fences a delayed
      // activate from any prior attempt.
      await this.bootstrap(targetDaemonId, candidate.agent, candidate.bundle, `${label} attempt ${attempt}`, workspace)
      const observed = await this.snapshotOwned(agentId, targetDaemonId)
      if (candidate.fingerprint === observed.fingerprint) {
        // Explicit final ownership read: an agent deleted or re-placed after the
        // ACK must never leave this target serving an orphaned copy.
        const confirmed = await this.deps.agents.get(agentId)
        if (!confirmed || confirmed.daemonId !== targetDaemonId) {
          return this.failClosedOwnership(agentId, targetDaemonId)
        }
        return { ...observed, agent: confirmed }
      }
      candidate = observed
    }
    throw new AgentMoveFailed(
      `agent definition did not stabilize after ${MAX_STABILITY_ATTEMPTS} target activation attempts`
    )
  }

  private async failClosedOwnership(agentId: AgentId, targetDaemonId: DaemonId): Promise<never> {
    try {
      requireAck('target detach after ownership change', await this.detach(targetDaemonId, agentId))
    } catch (err) {
      throw new AgentMoveFailClosed(
        'agent placement changed during move and target detach was not confirmed; manual recovery is required',
        err
      )
    }
    throw new AgentMoveFailClosed('agent placement changed during move; target was detached and the move stopped')
  }

  private detach(daemonId: DaemonId, agentId: AgentId, moveId = randomUUID()): Promise<Ack> {
    return this.deps.control.agentDetach(daemonId, { agentId, moveId })
  }

  private async rollback(
    sourceAgent: AgentRecord,
    moved: AgentRecord,
    sourceDaemonId: DaemonId | null,
    targetDaemonId: DaemonId,
    editor: string | undefined,
    bundle: MoveBundle
  ): Promise<boolean> {
    // Never reactivate the source unless target quiescence is positively ACKed:
    // an unavailable target may still be running the partial copy, and restoring
    // source in that state would create split brain.
    try {
      requireAck('target detach rollback', await this.detach(targetDaemonId, moved.id))
    } catch (err) {
      this.deps.log?.warn(
        { err, agentId: moved.id, targetDaemonId },
        'agent move: target detach unconfirmed; placement left on target for manual recovery'
      )
      return false
    }
    let restored: AgentRecord | null = null
    try {
      restored = await this.deps.agents.movePlacement(moved.id, targetDaemonId, sourceDaemonId, editor)
    } catch (err) {
      this.deps.log?.warn({ err, agentId: moved.id }, 'agent move: placement rollback failed')
    }
    if (restored && sourceDaemonId) {
      await this.bestEffortBootstrap('source bootstrap rollback', sourceDaemonId, sourceAgent, bundle)
    }
    return restored !== null
  }

  private async restoreSourceIfStillOwner(
    agent: AgentRecord,
    sourceDaemonId: DaemonId | null,
    bundle: MoveBundle
  ): Promise<void> {
    if (!sourceDaemonId) return
    const current = await this.deps.agents.get(agent.id).catch(() => null)
    if (current?.daemonId !== sourceDaemonId) return
    await this.bestEffortBootstrap('source bootstrap after CAS failure', sourceDaemonId, agent, bundle)
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
    requireAck(`${label} staging detach`, await this.detach(daemonId, agent.id, moveId))
    requireAck(
      `${label} activate`,
      await this.deps.control.agentActivate(daemonId, {
        ...this.activationDefinition(agent, bundle),
        moveId,
        ...workspace
      })
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

  private async convergeDerived(agent: AgentRecord, sharedBotIds: string[]): Promise<void> {
    const jobs: Array<{ label: string; run: () => Promise<void> }> = [
      { label: 'hook routes', run: () => this.deps.hooks.rebroadcastForAgent(agent.id) },
      { label: 'collaboration routes', run: () => this.deps.collabRoutes.broadcast(agent.orgId) },
      ...sharedBotIds.map((botId) => ({ label: `shared bot ${botId}`, run: () => this.deps.sharedBot.syncBot(botId) }))
    ]
    for (const job of jobs) {
      try {
        await job.run()
      } catch (err) {
        // The placement and daemon activation are already committed. Each of
        // these derived tables has a reconnect/replay convergence backstop, so a
        // transient fan-out error is logged rather than turning success into 500.
        this.deps.log?.warn({ err, agentId: agent.id, job: job.label }, 'agent move: derived convergence deferred')
      }
    }
  }
}
