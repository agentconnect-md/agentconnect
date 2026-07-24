/**
 * PgAgentRepo — agent definition & placement (design §3.6, §3.14).
 */
import { Prisma } from '../../generated/prisma/client.js'
import type { Agent, PrismaClient, User } from '../../generated/prisma/client.js'
import type { AgentMemoryBinding } from '@agentconnect.md/protocol'
import type { PrismaLike } from '../prisma.js'
import type {
  AgentCallPolicy,
  AgentRepo,
  AgentRecord,
  AgentWorkspace,
  CreateAgentInput,
  HookRecord,
  UpdateAgentInput,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../ports.js'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { parseAgentIcon, randomGlyphIcon } from '../../agents/agent-icon.js'
import {
  lockHookReviewAgentLifecycleScope,
  lockHookReviewAgentRepoScope,
  lockHookReviewOrgProducerScope
} from '../review-projection-lock.js'
import { PgHookRepo } from './hook.repo.js'
import { AgentWorkspaceIntegrationConflict } from '../errors.js'

// The agent row plus its joined creator + last-modifier users. Reads pull both
// relations so `toRecord` can surface each one's display name/email.
type AgentWithUsers = Agent & { createdBy: User | null; lastModifiedBy: User | null }
const withUsers = { createdBy: true, lastModifiedBy: true } as const

async function assertWorkspaceIntegrationCompatible(
  tx: Prisma.TransactionClient,
  agentId: AgentId,
  affectedRepoIds: bigint[],
  workspace: AgentWorkspace,
  workspaceRepoId?: bigint
): Promise<void> {
  const writableRepoId =
    workspace.mode === 'github' && (workspace.gitAccess ?? 'write') === 'write' ? workspaceRepoId : undefined
  const incompatibleRepoIds = [...new Set(affectedRepoIds)].filter((repoId) => repoId !== writableRepoId)
  if (incompatibleRepoIds.length === 0) return
  const blocking = await tx.hookDef.findFirst({
    where: {
      agentId,
      kind: 'github',
      enabled: true,
      repoId: { in: incompatibleRepoIds },
      OR: [{ reviewPolicy: { not: 'off' } }, { reportingMode: { not: 'off' } }]
    },
    select: { repoId: true }
  })
  if (blocking?.repoId !== null && blocking?.repoId !== undefined) {
    throw new AgentWorkspaceIntegrationConflict(blocking.repoId)
  }
}

// The runtimeOverrides JSON bag: per-agent runtime tuning the daemon applies at
// spawn (flattened into the wire AgentSpec by agentRecordToSpec).
type RuntimeOverrides = {
  model?: string
  reasoningEffort?: string
  outputMode?: string
  showFooter?: boolean
  fastMode?: boolean
  permissionMode?: string
  allowRuntimeChangesInChat?: boolean
  // Operational message-processing toggle (#288). Stored in the overrides bag for
  // consistency with the sibling boolean toggles; the daemon skips all turn dispatch
  // for a paused agent. Absent ⇒ not paused.
  pause?: boolean
  env?: Record<string, string>
  // NOTE: write-only secret env vars deliberately do NOT live in this bag — they
  // are rows in `agent_secret` behind the AgentSecretStore seam.
  mcpServers?: string[]
  // Which memory backend the agent uses (managed | native | external). Stored in
  // the overrides bag like the sibling knobs; the daemon builds the provider from it.
  memory?: AgentMemoryBinding
}

function overridesOf(a: Agent): RuntimeOverrides {
  return (a.runtimeOverrides as RuntimeOverrides | null) ?? {}
}

function workspaceOf(a: Agent): AgentWorkspace {
  if (a.workspaceMode === 'github') {
    return {
      mode: 'github',
      gitRepo: a.gitRepo ?? '',
      ...(a.gitBranch !== null ? { gitBranch: a.gitBranch } : {}),
      ...(a.agentDir !== null ? { agentDir: a.agentDir } : {}),
      ...(a.installationId !== null ? { installationId: a.installationId, gitAccess: a.gitAccess } : {})
    }
  }
  return { mode: 'scratch' }
}

function toRecord(a: AgentWithUsers): AgentRecord {
  const ov = overridesOf(a)
  return {
    id: AgentId(a.id),
    orgId: OrgId(a.orgId),
    name: a.name,
    displayName: a.displayName,
    icon: parseAgentIcon(a.icon),
    description: a.description,
    runtime: a.runtime,
    model: ov.model ?? null,
    reasoningEffort: ov.reasoningEffort ?? null,
    outputMode: ov.outputMode ?? null,
    showFooter: ov.showFooter ?? true,
    fastMode: ov.fastMode ?? null,
    permissionMode: ov.permissionMode ?? null,
    allowRuntimeChangesInChat: ov.allowRuntimeChangesInChat ?? false,
    pause: ov.pause ?? null,
    env: ov.env ?? {},
    mcpServers: ov.mcpServers ?? [],
    memory: ov.memory ?? null,
    status: a.status as AgentRecord['status'],
    daemonId: a.daemonId ? DaemonId(a.daemonId) : null,
    workspace: workspaceOf(a),
    ...(a.workspaceRepoId !== null ? { workspaceRepoId: a.workspaceRepoId } : {}),
    capabilities: a.capabilities,
    createdAt: a.createdAt,
    createdBy: a.createdBy
      ? { userId: a.createdBy.id, displayName: a.createdBy.displayName, email: a.createdBy.email }
      : null,
    // Raw creator scalar for the visibility creator-arm — independent of the joined
    // `createdBy` above, which is null once the user row is SetNull-deleted.
    createdByUserId: a.createdByUserId,
    visibility: a.visibility,
    sharedWith: a.sharedWith,
    callPolicy: a.callPolicy as AgentCallPolicy,
    allowedCallerAgentIds: a.allowedCallerAgentIds,
    outboundPolicy: a.outboundPolicy as AgentCallPolicy,
    allowedTargetAgentIds: a.allowedTargetAgentIds,
    introduceOnJoin: a.introduceOnJoin,
    restrictFileAccess: a.restrictFileAccess,
    lastModifiedAt: a.lastModifiedAt,
    lastModifiedBy: a.lastModifiedBy
      ? { userId: a.lastModifiedBy.id, displayName: a.lastModifiedBy.displayName, email: a.lastModifiedBy.email }
      : null
  }
}

export class PgAgentRepo implements AgentRepo {
  constructor(private readonly db: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    const ws = input.workspace ?? { mode: 'scratch' }
    return this.transaction(async (tx) => {
      // Close organization deletion's no-agent-row enumeration window without
      // taking a parent-row lock in the reverse order of Hook CRUD.
      await lockHookReviewOrgProducerScope(tx, input.orgId)
      const a = await tx.agent.create({
        data: {
          id: input.id,
          orgId: input.orgId,
          name: input.name,
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          // New agents always get a persisted icon: the caller's pick, else a random
          // glyph+color combo (product default — new agents are not runtime-branded).
          icon: (input.icon ?? randomGlyphIcon()) as Prisma.InputJsonValue,
          description: input.description ?? null,
          runtime: input.runtime,
          ...(input.daemonId ? { daemonId: input.daemonId, status: 'active' } : {}),
          ...(input.model ||
          input.reasoningEffort ||
          input.outputMode ||
          input.showFooter !== undefined ||
          input.fastMode !== undefined ||
          input.permissionMode ||
          input.allowRuntimeChangesInChat !== undefined ||
          input.pause !== undefined ||
          input.env ||
          input.mcpServers ||
          input.memory
            ? {
                runtimeOverrides: {
                  ...(input.model ? { model: input.model } : {}),
                  ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
                  ...(input.outputMode ? { outputMode: input.outputMode } : {}),
                  ...(input.showFooter !== undefined ? { showFooter: input.showFooter } : {}),
                  ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
                  ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
                  ...(input.allowRuntimeChangesInChat !== undefined
                    ? { allowRuntimeChangesInChat: input.allowRuntimeChangesInChat }
                    : {}),
                  ...(input.pause !== undefined ? { pause: input.pause } : {}),
                  ...(input.env ? { env: input.env } : {}),
                  ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
                  ...(input.memory ? { memory: input.memory } : {})
                }
              }
            : {}),
          // A user-created agent's first "last modification" is its creation, by the
          // same principal — stamp both so the audit pair is coherent from row one.
          ...(input.createdByUserId
            ? { createdByUserId: input.createdByUserId, lastModifiedByUserId: input.createdByUserId }
            : {}),
          workspaceMode: ws.mode,
          gitRepo: ws.mode === 'github' ? ws.gitRepo : null,
          gitBranch: ws.mode === 'github' ? (ws.gitBranch ?? 'main') : null,
          agentDir: ws.mode === 'github' ? (ws.agentDir ?? null) : null,
          installationId: ws.mode === 'github' ? (ws.installationId ?? null) : null,
          workspaceRepoId: ws.mode === 'github' ? (input.workspaceRepoId ?? null) : null,
          ...(ws.mode === 'github' && ws.installationId ? { gitAccess: ws.gitAccess ?? 'write' } : {}),
          capabilities: input.capabilities ?? [],
          // #536 self-introduce-on-join (dedicated column; absent ⇒ DB default false).
          ...(input.introduceOnJoin !== undefined ? { introduceOnJoin: input.introduceOnJoin } : {}),
          // #642 sandbox preference (dedicated column; absent ⇒ DB default false).
          ...(input.restrictFileAccess !== undefined ? { restrictFileAccess: input.restrictFileAccess } : {}),
          // Initial visibility (absent ⇒ DB default 'org'). sharedWith only bites
          // when restricted; a stray set under 'org' is inert (the predicate ignores it).
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.sharedWith ? { sharedWith: input.sharedWith } : {}),
          // Initial call policy (absent ⇒ DB default 'all'). allowedCallerAgentIds
          // only bites when 'selected'; the route intersects it with visible peers.
          ...(input.callPolicy ? { callPolicy: input.callPolicy } : {}),
          ...(input.allowedCallerAgentIds ? { allowedCallerAgentIds: input.allowedCallerAgentIds } : {})
        },
        include: withUsers
      })
      return toRecord(a)
    })
  }

  async get(agentId: AgentId): Promise<AgentRecord | null> {
    const a = await this.db.agent.findUnique({ where: { id: agentId }, include: withUsers })
    return a ? toRecord(a) : null
  }

  async update(agentId: AgentId, patch: UpdateAgentInput): Promise<AgentRecord> {
    // model/reasoningEffort/env live in the runtimeOverrides JSON — merge key by
    // key so patching one never clobbers the others (null deletes its key).
    let overrides: RuntimeOverrides | typeof undefined
    if (
      patch.model !== undefined ||
      patch.reasoningEffort !== undefined ||
      patch.outputMode !== undefined ||
      patch.showFooter !== undefined ||
      patch.fastMode !== undefined ||
      patch.permissionMode !== undefined ||
      patch.allowRuntimeChangesInChat !== undefined ||
      patch.pause !== undefined ||
      patch.env !== undefined ||
      patch.mcpServers !== undefined ||
      patch.memory !== undefined
    ) {
      const cur = (await this.db.agent.findUnique({ where: { id: agentId } }))
        ?.runtimeOverrides as RuntimeOverrides | null
      const next: RuntimeOverrides = { ...(cur ?? {}) }
      if (patch.model !== undefined) {
        if (patch.model === null) delete next.model
        else next.model = patch.model
      }
      if (patch.reasoningEffort !== undefined) {
        if (patch.reasoningEffort === null) delete next.reasoningEffort
        else next.reasoningEffort = patch.reasoningEffort
      }
      if (patch.outputMode !== undefined) {
        if (patch.outputMode === null) delete next.outputMode
        else next.outputMode = patch.outputMode
      }
      if (patch.showFooter !== undefined) next.showFooter = patch.showFooter
      if (patch.fastMode !== undefined) {
        if (patch.fastMode === null) delete next.fastMode
        else next.fastMode = patch.fastMode
      }
      if (patch.permissionMode !== undefined) {
        if (patch.permissionMode === null) delete next.permissionMode
        else next.permissionMode = patch.permissionMode
      }
      if (patch.allowRuntimeChangesInChat !== undefined) {
        next.allowRuntimeChangesInChat = patch.allowRuntimeChangesInChat
      }
      if (patch.pause !== undefined) {
        if (patch.pause === null) delete next.pause
        else next.pause = patch.pause
      }
      if (patch.env !== undefined) {
        if (patch.env === null) delete next.env
        else next.env = patch.env
      }
      if (patch.mcpServers !== undefined) {
        if (patch.mcpServers === null) delete next.mcpServers
        else next.mcpServers = patch.mcpServers
      }
      if (patch.memory !== undefined) {
        if (patch.memory === null) delete next.memory
        else next.memory = patch.memory
      }
      overrides = next
    }
    const a = await this.db.agent.update({
      where: { id: agentId },
      data: {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        // Absent ⇒ leave unchanged; explicit null ⇒ clear back to the runtime-mark default.
        ...(patch.icon !== undefined
          ? { icon: patch.icon === null ? Prisma.JsonNull : (patch.icon as Prisma.InputJsonValue) }
          : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.runtime !== undefined ? { runtime: patch.runtime } : {}),
        ...(patch.capabilities !== undefined ? { capabilities: patch.capabilities } : {}),
        ...(patch.introduceOnJoin !== undefined ? { introduceOnJoin: patch.introduceOnJoin } : {}),
        ...(patch.restrictFileAccess !== undefined ? { restrictFileAccess: patch.restrictFileAccess } : {}),
        ...(patch.gitAccess !== undefined ? { gitAccess: patch.gitAccess } : {}),
        ...(patch.agentDir !== undefined ? { agentDir: patch.agentDir } : {}),
        ...(overrides !== undefined ? { runtimeOverrides: overrides } : {}),
        // A PATCH is a human edit — advance the last-modified audit. The editor is
        // stamped when known (absent under devAuth ⇒ leave the prior editor as-is).
        lastModifiedAt: new Date(),
        ...(patch.lastModifiedByUserId ? { lastModifiedByUserId: patch.lastModifiedByUserId } : {})
      },
      include: withUsers
    })
    return toRecord(a)
  }

  async setWorkspace(
    agentId: AgentId,
    expectedLastModifiedAt: Date,
    expectedMode: AgentWorkspace['mode'],
    workspace: AgentWorkspace,
    workspaceRepoId?: bigint,
    byUserId?: string
  ): Promise<AgentRecord | null> {
    try {
      return await this.transaction(async (tx) => {
        // No explicit grant is required — the route authorizes the caller against
        // the covering installation. The lifecycle + repository locks serialize
        // this edit with HookDef configuration and projection/grant writes, so a
        // concurrent write-requiring integration cannot race a read downgrade.
        await lockHookReviewAgentLifecycleScope(tx, agentId)
        const current = await tx.agent.findUnique({
          where: { id: agentId },
          select: { workspaceMode: true, workspaceRepoId: true, lastModifiedAt: true }
        })
        if (
          !current ||
          current.workspaceMode !== expectedMode ||
          current.lastModifiedAt.getTime() !== expectedLastModifiedAt.getTime()
        ) {
          return null
        }
        const affectedRepoIds = [current.workspaceRepoId, workspaceRepoId]
          .filter((repoId): repoId is bigint => repoId !== null && repoId !== undefined)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        for (const repoId of new Set(affectedRepoIds)) {
          await lockHookReviewAgentRepoScope(tx, agentId, repoId)
        }
        await assertWorkspaceIntegrationCompatible(tx, agentId, affectedRepoIds, workspace, workspaceRepoId)
        const a = await tx.agent.update({
          where: { id: agentId, workspaceMode: expectedMode, lastModifiedAt: expectedLastModifiedAt },
          data: {
            workspaceMode: workspace.mode,
            gitRepo: workspace.mode === 'github' ? workspace.gitRepo : null,
            gitBranch: workspace.mode === 'github' ? (workspace.gitBranch ?? 'main') : null,
            agentDir: workspace.mode === 'github' ? (workspace.agentDir ?? null) : null,
            installationId: workspace.mode === 'github' ? (workspace.installationId ?? null) : null,
            workspaceRepoId: workspaceRepoId ?? null,
            gitAccess: workspace.mode === 'github' ? (workspace.gitAccess ?? 'write') : 'write',
            lastModifiedAt: new Date(Math.max(Date.now(), expectedLastModifiedAt.getTime() + 1)),
            ...(byUserId ? { lastModifiedByUserId: byUserId } : {})
          },
          include: withUsers
        })
        return toRecord(a)
      })
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2025') return null
      throw err
    }
  }

  async restoreWorkspace(
    agentId: AgentId,
    expectedLastModifiedAt: Date,
    expectedWorkspace: AgentWorkspace,
    expectedWorkspaceRepoId: bigint | undefined,
    workspace: AgentWorkspace,
    workspaceRepoId?: bigint,
    byUserId?: string
  ): Promise<AgentRecord | null> {
    try {
      return await this.transaction(async (tx) => {
        await lockHookReviewAgentLifecycleScope(tx, agentId)
        const affectedRepoIds = [expectedWorkspaceRepoId, workspaceRepoId]
          .filter((repoId): repoId is bigint => repoId !== undefined)
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        for (const repoId of new Set(affectedRepoIds)) {
          await lockHookReviewAgentRepoScope(tx, agentId, repoId)
        }
        await assertWorkspaceIntegrationCompatible(tx, agentId, affectedRepoIds, workspace, workspaceRepoId)
        const a = await tx.agent.update({
          where: {
            id: agentId,
            workspaceMode: expectedWorkspace.mode,
            workspaceRepoId: expectedWorkspaceRepoId ?? null,
            lastModifiedAt: expectedLastModifiedAt
          },
          data: {
            workspaceMode: workspace.mode,
            gitRepo: workspace.mode === 'github' ? workspace.gitRepo : null,
            gitBranch: workspace.mode === 'github' ? (workspace.gitBranch ?? 'main') : null,
            agentDir: workspace.mode === 'github' ? (workspace.agentDir ?? null) : null,
            installationId: workspace.mode === 'github' ? (workspace.installationId ?? null) : null,
            workspaceRepoId: workspaceRepoId ?? null,
            gitAccess: workspace.mode === 'github' ? (workspace.gitAccess ?? 'write') : 'write',
            lastModifiedAt: new Date(Math.max(Date.now(), expectedLastModifiedAt.getTime() + 1)),
            ...(byUserId ? { lastModifiedByUserId: byUserId } : {})
          },
          include: withUsers
        })
        return toRecord(a)
      })
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2025') return null
      throw err
    }
  }

  async setWorkspaceRepoId(agentId: AgentId, repoId: bigint): Promise<boolean> {
    return this.transaction(async (tx) => {
      // Serialize with additional-grant create/revoke and projection creation.
      // A pre-R2a rename could leave the workspace repo represented by both the
      // implicit workspace and an explicit grant; repair owns deleting that
      // redundant row, but must not schedule repo-revocation cleanup because
      // the workspace authority remains valid.
      await lockHookReviewAgentRepoScope(tx, agentId, repoId)
      const agent = await tx.agent.findUnique({
        where: { id: agentId },
        select: { workspaceMode: true, workspaceRepoId: true }
      })
      if (
        !agent ||
        agent.workspaceMode !== 'github' ||
        (agent.workspaceRepoId !== null && agent.workspaceRepoId !== repoId)
      ) {
        return false
      }
      await tx.agent.update({ where: { id: agentId }, data: { workspaceRepoId: repoId } })
      await tx.agentRepoAuthorization.deleteMany({ where: { agentId, repoId } })
      return true
    })
  }

  async setSharing(
    agentId: AgentId,
    sharing: { visibility: AgentRecord['visibility']; sharedWith: string[] },
    byUserId?: string
  ): Promise<AgentRecord> {
    // A sharing change is a human edit — advance the last-modified audit (editor
    // stamped when known; absent under devAuth ⇒ leave the prior editor as-is).
    const a = await this.db.agent.update({
      where: { id: agentId },
      data: {
        visibility: sharing.visibility,
        sharedWith: sharing.sharedWith,
        lastModifiedAt: new Date(),
        ...(byUserId ? { lastModifiedByUserId: byUserId } : {})
      },
      include: withUsers
    })
    return toRecord(a)
  }

  async setCallPolicy(
    agentId: AgentId,
    policy: {
      callPolicy: AgentCallPolicy
      allowedCallerAgentIds: string[]
      outboundPolicy?: AgentCallPolicy
      allowedTargetAgentIds?: string[]
    },
    byUserId?: string
  ): Promise<AgentRecord> {
    const a = await this.db.agent.update({
      where: { id: agentId },
      data: {
        callPolicy: policy.callPolicy,
        allowedCallerAgentIds: policy.allowedCallerAgentIds,
        ...(policy.outboundPolicy !== undefined ? { outboundPolicy: policy.outboundPolicy } : {}),
        ...(policy.allowedTargetAgentIds !== undefined ? { allowedTargetAgentIds: policy.allowedTargetAgentIds } : {}),
        lastModifiedAt: new Date(),
        ...(byUserId ? { lastModifiedByUserId: byUserId } : {})
      },
      include: withUsers
    })
    return toRecord(a)
  }

  async setPlacement(agentId: AgentId, daemonId: DaemonId | null): Promise<void> {
    await this.transaction(async (tx) => {
      const current = await tx.agent.findUnique({ where: { id: agentId }, select: { daemonId: true } })
      if (!current) return
      await tx.agent.update({
        where: { id: agentId },
        data: { daemonId, status: daemonId ? 'active' : 'inactive' }
      })
      if (current.daemonId !== daemonId) {
        await tx.hookDef.updateMany({
          where: { agentId },
          data: { dispatchRevision: { increment: 1 } }
        })
      }
    })
  }

  async movePlacement(
    agentId: AgentId,
    expectedDaemonId: DaemonId | null,
    daemonId: DaemonId | null,
    byUserId?: string
  ): Promise<AgentRecord | null> {
    // `id` keeps this an update-by-unique while `daemonId` is the compare-and-set
    // guard. A concurrent move changes daemonId, so Prisma reports P2025 and the
    // loser returns null instead of overwriting the winner's placement.
    try {
      return await this.transaction(async (tx) => {
        const a = await tx.agent.update({
          where: { id: agentId, daemonId: expectedDaemonId },
          data: {
            daemonId,
            status: daemonId ? 'active' : 'inactive',
            lastModifiedAt: new Date(),
            ...(byUserId ? { lastModifiedByUserId: byUserId } : {})
          },
          include: withUsers
        })
        if (expectedDaemonId !== daemonId) {
          await tx.hookDef.updateMany({
            where: { agentId },
            data: { dispatchRevision: { increment: 1 } }
          })
        }
        return toRecord(a)
      })
    } catch (err) {
      // Avoid importing a second Prisma runtime just for the P2025 class guard:
      // generated known-request errors expose their stable code structurally.
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2025') return null
      throw err
    }
  }

  async delete(agentId: AgentId): Promise<HookRecord[]> {
    return this.transaction(async (tx) => {
      // Keep the agent-owned hook set stable from enumeration through cleanup
      // and the cascading delete. Hook create/rebind/remove takes this same lock
      // before its per-hook lifecycle lock.
      await lockHookReviewAgentLifecycleScope(tx, agentId)
      const hooks = new PgHookRepo(tx)
      const removedHooks = await hooks.listForAgent(agentId)
      await hooks.tombstoneReviewProjections(
        removedHooks.map((hook) => hook.id),
        new Date(),
        'failure'
      )
      await tx.agent.delete({ where: { id: agentId } })
      return removedHooks
    })
  }

  async list(orgId: OrgId, viewer?: ViewCtx): Promise<AgentRecord[]> {
    const rows = await this.db.agent.findMany({
      where: { orgId, ...visibilityWhere(viewer) },
      orderBy: { createdAt: 'asc' },
      include: withUsers
    })
    return rows.map(toRecord)
  }

  async listForDaemon(daemonId: DaemonId): Promise<AgentRecord[]> {
    const rows = await this.db.agent.findMany({
      where: { daemonId },
      orderBy: { createdAt: 'asc' },
      include: withUsers
    })
    return rows.map(toRecord)
  }
}
