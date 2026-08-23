/**
 * PgAgentRepo — agent definition & placement (design §3.6, §3.14).
 */
import { Prisma } from '../../generated/prisma/client.js'
import type { Agent, PrismaClient, User } from '../../generated/prisma/client.js'
import { redactGitUrlSecrets, type AgentMemoryBinding, type ApprovalsReviewer } from '@agentconnect.md/protocol'
import type { PrismaLike } from '../prisma.js'
import type {
  AgentCallPolicy,
  AgentCreateOpts,
  AgentRepo,
  AgentRecord,
  AgentSkillSourceFence,
  AgentUpdateOpts,
  AgentWorkspace,
  CreateAgentInput,
  HookRecord,
  OrgAgentRecord,
  UpdateAgentInput,
  ViewCtx
} from '../ports.js'
import { visibilityWhere } from '../../authorization/policy.js'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import {
  placementColumns,
  placementTargetOf,
  samePlacement,
  type PlacementKind,
  type PlacementTarget
} from '../../domain/placement.js'
import { parseAgentIcon, randomGlyphIcon } from '../../agents/agent-icon.js'
import {
  lockHookReviewAgentLifecycleScope,
  lockHookReviewAgentRepoScope,
  lockHookReviewOrgProducerScope
} from '../review-projection-lock.js'
import { lockResourceWriteMemberships } from '../resource-membership-lock.js'
import { lockSkillSourceNameScopes } from '../skill-source-lock.js'
import { tryLockMemoryConnectionScopes } from '../memory-connection-lock.js'
import { PgHookRepo } from './hook.repo.js'
import { lockAgentPlacement, settlePlacementChange } from './agent-placement.js'
import { assertAgentMayUseSet, assertDaemonNotInSet } from './member-set.repo.js'

/** An agent may be created already placed. A `set` placement names a set rather than a machine, so
 *  the create input carries a kind and the columns follow from it rather than from a daemon id. */
function placementCreateColumns(input: { placementKind?: PlacementKind; daemonId?: string; setId?: string }): {
  placementKind?: PlacementKind
  daemonId?: string
  setId?: string
  status?: 'active'
} {
  if (input.placementKind === 'set' && input.setId)
    return { placementKind: 'set', setId: input.setId, status: 'active' }
  return input.daemonId ? { daemonId: input.daemonId, status: 'active' } : {}
}
import {
  bumpAgentConfigRevisions,
  fenceAgentLocalConfigWrite,
  lockOrgForConfigWrite,
  orgIdOfAgent
} from './organization-environment-fence.js'
import {
  AgentMissing,
  AgentWorkspaceIntegrationConflict,
  MemoryConnectionBusy,
  MemoryConnectionMissing
} from '../errors.js'

/**
 * Enter an agent write's skill-source fence: take the (orgId, name) advisory
 * scope of every submitted ref's source (sorted), then read the source names
 * the fence's viewer can see — the set `fence.authorize` later decides against.
 * Both happen inside the write's transaction, so a source delete, same-name
 * recreate, or sharing flip serializes with the enable-list write it would
 * otherwise race (they hold the same scopes).
 */
async function enterSkillSourceFence(
  tx: Prisma.TransactionClient,
  fence: AgentSkillSourceFence
): Promise<ReadonlySet<string>> {
  await lockSkillSourceNameScopes(tx, fence.orgId, fence.names)
  const rows = await tx.skillSource.findMany({
    where: { orgId: fence.orgId, ...visibilityWhere(fence.viewer) },
    select: { name: true }
  })
  return new Set(rows.map((row) => row.name))
}

/**
 * Fence an agent write against external-memory mutations: try-lock the
 * advisory mutation scope of every touched connection (the committed binding
 * plus the one being bound), and re-verify a newly bound connection still
 * exists in this org — inside the same transaction as the agent-row write, so
 * a connection DELETE's "no agent bound" scan can never interleave with a bind
 * committing under it. Try-locks never wait, so this cannot deadlock with the
 * row locks the caller already holds.
 */
async function fenceMemoryConnections(
  tx: Prisma.TransactionClient,
  orgId: string,
  touchedConnectionIds: readonly string[],
  bindConnectionId?: string
): Promise<void> {
  const ids = [...new Set(touchedConnectionIds)]
  if (ids.length === 0) return
  if (!(await tryLockMemoryConnectionScopes(tx, ids))) throw new MemoryConnectionBusy()
  if (!bindConnectionId) return
  const connection = await tx.externalMemoryConnection.findUnique({
    where: { id: bindConnectionId },
    select: { orgId: true }
  })
  if (!connection || connection.orgId !== orgId) throw new MemoryConnectionMissing()
}

/** The external connection id a memory binding references, if any. */
function externalConnectionIdOf(memory: { provider?: string; connectionId?: string } | null | undefined): string[] {
  return memory?.provider === 'external' && memory.connectionId ? [memory.connectionId] : []
}

// The agent row plus its joined creator + last-modifier users, and the preset
// rows referencing it (⇒ `builtin`). Reads pull all three so `toRecord` can
// surface the users' display name/email and derive the built-in flag.
type AgentWithUsers = Agent & {
  createdBy: User | null
  lastModifiedBy: User | null
  presetRecords: { preset: string }[]
}
const withUsers = { createdBy: true, lastModifiedBy: true, presetRecords: { select: { preset: true } } } as const

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
  showStatusBar?: boolean
  fastMode?: boolean
  permissionMode?: string
  approvalsReviewer?: ApprovalsReviewer
  allowRuntimeChangesInChat?: boolean
  // Operational message-processing toggle (#288). Stored in the overrides bag for
  // consistency with the sibling boolean toggles; the daemon skips all turn dispatch
  // for a paused agent. Absent ⇒ not paused.
  pause?: boolean
  env?: Record<string, string>
  // NOTE: write-only secret env vars deliberately do NOT live in this bag — they
  // are rows in `agent_secret` behind the AgentSecretStore seam.
  mcpServers?: string[]
  // Enabled shared-skills, "<sourceName>/<skillName>" or "<sourceName>/*". Stored in
  // the overrides bag like mcpServers; the CP resolves these into self-contained
  // AgentSpec.skills entries (agentSpecAssembler) when it builds the spec.
  skills?: string[]
  // Which memory backend the agent uses (managed | native | external). Stored in
  // the overrides bag like the sibling knobs; the daemon builds the provider from it.
  memory?: AgentMemoryBinding
}

function overridesOf(a: Agent): RuntimeOverrides {
  return (a.runtimeOverrides as RuntimeOverrides | null) ?? {}
}

// Preset one-shot settle (preset-agents.md §3.2): the FIRST placement of any
// kind — and an explicit delete — permanently stamps `placementSettledAt`, so
// M1 auto-placement never fights a user who placed, moved, or removed the
// preset. No-op for ordinary agents (no preset_agent row references them).
async function settlePresetPlacement(tx: Prisma.TransactionClient, agentId: string): Promise<void> {
  await tx.presetAgent.updateMany({
    where: { agentId, placementSettledAt: null },
    data: { placementSettledAt: new Date() }
  })
}

function workspaceOf(a: Agent): AgentWorkspace {
  if (a.workspaceMode === 'github') {
    return {
      mode: 'github',
      isolation: a.workspaceIsolation,
      // Legacy rows may predate the credential-free clone URL invariant. Keep
      // reads total, but never let URL userinfo/query secrets enter DTOs or wire
      // projections through the domain record.
      gitRepo: redactGitUrlSecrets(a.gitRepo ?? ''),
      ...(a.gitBranch !== null ? { gitBranch: a.gitBranch } : {}),
      ...(a.agentDir !== null ? { agentDir: a.agentDir } : {}),
      ...(a.installationId !== null ? { installationId: a.installationId, gitAccess: a.gitAccess } : {})
    }
  }
  if (a.workspaceMode === 'gitlab') {
    return {
      mode: 'gitlab',
      isolation: a.workspaceIsolation,
      gitRepo: redactGitUrlSecrets(a.gitRepo ?? ''),
      ...(a.gitBranch !== null ? { gitBranch: a.gitBranch } : {}),
      ...(a.agentDir !== null ? { agentDir: a.agentDir } : {}),
      gitAccess: a.gitAccess
    }
  }
  return { mode: 'scratch', isolation: a.workspaceIsolation }
}

function toRecord(a: AgentWithUsers): AgentRecord {
  const ov = overridesOf(a)
  return {
    id: AgentId(a.id),
    orgId: OrgId(a.orgId),
    name: a.name,
    displayName: a.displayName,
    builtin: a.presetRecords.length > 0,
    icon: parseAgentIcon(a.icon),
    description: a.description,
    runtime: a.runtime,
    model: ov.model ?? null,
    reasoningEffort: ov.reasoningEffort ?? null,
    outputMode: ov.outputMode ?? null,
    showFooter: ov.showFooter ?? true,
    showStatusBar: ov.showStatusBar ?? false,
    fastMode: ov.fastMode ?? null,
    permissionMode: ov.permissionMode ?? null,
    approvalsReviewer: ov.approvalsReviewer ?? null,
    allowRuntimeChangesInChat: ov.allowRuntimeChangesInChat ?? false,
    pause: ov.pause ?? null,
    env: ov.env ?? {},
    mcpServers: ov.mcpServers ?? [],
    skills: ov.skills ?? [],
    managedSkills: a.managedSkills,
    memory: ov.memory ?? null,
    status: a.status as AgentRecord['status'],
    placementKind: a.placementKind,
    daemonId: a.daemonId ? DaemonId(a.daemonId) : null,
    setId: a.setId,
    workspace: workspaceOf(a),
    ...(a.workspaceRepoId !== null ? { workspaceRepoId: a.workspaceRepoId } : {}),
    capabilities: a.capabilities,
    createdAt: a.createdAt,
    createdBy: a.createdBy
      ? { userId: a.createdBy.id, displayName: a.createdBy.displayName, email: a.createdBy.email }
      : null,
    createdByUserId: a.createdByUserId,
    visibility: a.visibility,
    sharedWith: a.sharedWith,
    callPolicy: a.callPolicy as AgentCallPolicy,
    allowedCallerAgentIds: a.allowedCallerAgentIds,
    outboundPolicy: a.outboundPolicy as AgentCallPolicy,
    allowedTargetAgentIds: a.allowedTargetAgentIds,
    introduceOnJoin: a.introduceOnJoin,
    runInSandbox: a.runInSandbox,
    lastModifiedAt: a.lastModifiedAt,
    lastModifiedBy: a.lastModifiedBy
      ? { userId: a.lastModifiedBy.id, displayName: a.lastModifiedBy.displayName, email: a.lastModifiedBy.email }
      : null,
    configRevision: a.configRevision
  }
}

export class PgAgentRepo implements AgentRepo {
  constructor(private readonly db: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction(fn)
    return fn(this.db as Prisma.TransactionClient)
  }

  async create(input: CreateAgentInput, opts?: AgentCreateOpts): Promise<AgentRecord> {
    const ws = input.workspace ?? { mode: 'scratch' }
    return this.transaction(async (tx) => {
      // Close organization deletion's no-agent-row enumeration window without
      // taking a parent-row lock in the reverse order of Hook CRUD.
      await lockHookReviewOrgProducerScope(tx, input.orgId)
      if (opts?.skillSources) {
        const visible = await enterSkillSourceFence(tx, opts.skillSources)
        // A not-yet-created agent holds nothing, and the fence scopes keep the
        // named sources' lifecycle still until this transaction commits.
        opts.skillSources.authorize([], visible)
      }
      // Organization-environment fence (organization-secrets-and-variables.md §5).
      // CREATE is the one agent-config path that must lock the ORG row rather than
      // the agent row: the row does not exist yet, so a concurrent `all`-audience
      // write's enrollment scan cannot see it. The org row makes the enrollment set
      // this agent joins below stable across that race.
      //
      // Taken AFTER the skill-source name scopes, never before. A skill-source
      // sharing write holds those scopes and then takes `FOR KEY SHARE` on this same
      // org row (`lockResourceWriteMemberships`); the reverse order here would put
      // the two writers in a cycle. Full order for every agent-config writer:
      // skill-source name scopes → org row (create only) → agent rows.
      await lockOrgForConfigWrite(tx, input.orgId)
      const bindId = externalConnectionIdOf(input.memory)[0]
      await fenceMemoryConnections(tx, input.orgId, externalConnectionIdOf(input.memory), bindId)
      const orgDefault =
        input.callPolicy === undefined || input.outboundPolicy === undefined
          ? await tx.org.findUnique({
              where: { id: input.orgId },
              select: { defaultAgentVisibility: true }
            })
          : null
      const defaultAgentVisibility = (orgDefault?.defaultAgentVisibility as AgentCallPolicy | undefined) ?? 'all'
      const callPolicy = input.callPolicy ?? defaultAgentVisibility
      const outboundPolicy = input.outboundPolicy ?? defaultAgentVisibility
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: input.orgId,
        visibility: input.visibility ?? 'org',
        actorUserId: input.createdByUserId,
        sharedWith: input.sharedWith
      })
      // Third write-time invariant (daemon-groups.md §2): a create places too, so it takes it.
      if (input.placementKind === 'set' && input.setId)
        await assertAgentMayUseSet(tx, { id: input.id, orgId: input.orgId }, input.setId)
      if (input.placementKind !== 'set' && input.daemonId) await assertDaemonNotInSet(tx, input.id, input.daemonId)
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
          ...placementCreateColumns(input),
          ...(input.managedSkills ? { managedSkills: input.managedSkills } : {}),
          ...(input.model ||
          input.reasoningEffort ||
          input.outputMode ||
          input.showFooter !== undefined ||
          input.showStatusBar !== undefined ||
          input.fastMode !== undefined ||
          input.permissionMode ||
          input.approvalsReviewer ||
          input.allowRuntimeChangesInChat !== undefined ||
          input.pause !== undefined ||
          input.env ||
          input.mcpServers ||
          input.skills ||
          input.memory
            ? {
                runtimeOverrides: {
                  ...(input.model ? { model: input.model } : {}),
                  ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
                  ...(input.outputMode ? { outputMode: input.outputMode } : {}),
                  ...(input.showFooter !== undefined ? { showFooter: input.showFooter } : {}),
                  ...(input.showStatusBar !== undefined ? { showStatusBar: input.showStatusBar } : {}),
                  ...(input.fastMode !== undefined ? { fastMode: input.fastMode } : {}),
                  ...(input.permissionMode ? { permissionMode: input.permissionMode } : {}),
                  ...(input.approvalsReviewer ? { approvalsReviewer: input.approvalsReviewer } : {}),
                  ...(input.allowRuntimeChangesInChat !== undefined
                    ? { allowRuntimeChangesInChat: input.allowRuntimeChangesInChat }
                    : {}),
                  ...(input.pause !== undefined ? { pause: input.pause } : {}),
                  ...(input.env ? { env: input.env } : {}),
                  ...(input.mcpServers ? { mcpServers: input.mcpServers } : {}),
                  ...(input.skills ? { skills: input.skills } : {}),
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
          workspaceIsolation: ws.mode !== 'scratch' ? (ws.isolation ?? 'session') : 'shared',
          gitRepo: ws.mode !== 'scratch' ? ws.gitRepo : null,
          gitBranch: ws.mode !== 'scratch' ? (ws.gitBranch ?? 'main') : null,
          agentDir: ws.mode !== 'scratch' ? (ws.agentDir ?? null) : null,
          installationId: ws.mode === 'github' ? (ws.installationId ?? null) : null,
          workspaceRepoId: ws.mode !== 'scratch' ? (input.workspaceRepoId ?? null) : null,
          ...((ws.mode === 'github' && ws.installationId) || ws.mode === 'gitlab'
            ? { gitAccess: ws.gitAccess ?? 'write' }
            : {}),
          capabilities: input.capabilities ?? [],
          // #536 self-introduce-on-join (dedicated column; absent ⇒ DB default false).
          ...(input.introduceOnJoin !== undefined ? { introduceOnJoin: input.introduceOnJoin } : {}),
          // #642 sandbox preference (dedicated column; absent ⇒ DB default false).
          ...(input.runInSandbox !== undefined ? { runInSandbox: input.runInSandbox } : {}),
          // Initial visibility (absent ⇒ DB default 'org'). sharedWith only bites
          // when restricted; a stray set under 'org' is inert (the predicate ignores it).
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(memberships.sharedWith ? { sharedWith: memberships.sharedWith } : {}),
          // Both directions inherit the organization's creation default unless
          // explicitly chosen. The database default matches the open product default
          // for writes outside this repository seam.
          callPolicy,
          allowedCallerAgentIds: callPolicy === 'selected' ? (input.allowedCallerAgentIds ?? []) : [],
          outboundPolicy,
          allowedTargetAgentIds: outboundPolicy === 'selected' ? (input.allowedTargetAgentIds ?? []) : []
        },
        include: withUsers
      })
      // A brand-new agent joins every current `all`-audience entry: the actor is
      // already authorized to edit this target, and the Console showed which
      // organization entries would apply. The secret rows land just after this (in
      // PgAgentConfigWriter's transaction), which re-runs the fence with the
      // complete definition.
      await fenceAgentLocalConfigWrite(tx, input.orgId, a.id, input.createdByUserId)
      return toRecord(a)
    })
  }

  async get(orgId: OrgId, agentId: AgentId): Promise<AgentRecord | null> {
    // The org filter rides the unique lookup (extended where): a cross-org id
    // is indistinguishable from a missing row (org-scoped-data-layer.md §3).
    const a = await this.db.agent.findUnique({ where: { id: agentId, orgId }, include: withUsers })
    return a ? toRecord(a) : null
  }

  async getUnscoped(agentId: AgentId): Promise<AgentRecord | null> {
    const a = await this.db.agent.findUnique({ where: { id: agentId }, include: withUsers })
    return a ? toRecord(a) : null
  }

  async update(orgId: OrgId, agentId: AgentId, patch: UpdateAgentInput, opts?: AgentUpdateOpts): Promise<AgentRecord> {
    return this.transaction(async (tx) => this.updateInTx(tx, orgId, agentId, patch, opts))
  }

  private async updateInTx(
    tx: Prisma.TransactionClient,
    orgId: OrgId,
    agentId: AgentId,
    patch: UpdateAgentInput,
    opts?: AgentUpdateOpts
  ): Promise<AgentRecord> {
    // Organization-environment fence (organization-secrets-and-variables.md §5).
    // A PATCH affects exactly ONE agent, and the admission budget is per-agent, so
    // the AGENT ROW — not the Org row — is the serialization point this path needs:
    //
    //  - two PATCHes to the same agent serialize on it (the row lock below);
    //  - a PATCH racing an organization-environment write serializes on it too,
    //    because every organization-environment writer locks the agent rows it
    //    affects. Whichever commits second re-reads the other's committed state and
    //    is refused, which is what makes the cross-kind rule enforceable from both
    //    write directions; and
    //  - two PATCHes to DIFFERENT agents are genuinely independent.
    //
    // Deliberately NOT the Org row here: taking it would serialize every agent edit
    // in the organization behind one another for no admission benefit, and would
    // invert lock order against the skill-source name scopes taken just below
    // (a create holding the org row while waiting on a name scope, against a PATCH
    // holding that name scope while waiting on the org row). `create` DOES take it,
    // because a not-yet-inserted row is invisible to a concurrent `all` enrollment
    // scan — see the comment there.
    // Tenancy fence (org-scoped-data-layer.md §3): the caller's org must own
    // the row. An agent's orgId is immutable, so this unlocked read cannot be
    // invalidated by a concurrent write — a row deleted after it just reaches
    // the update below and keeps its missing-row error semantics.
    const rowOrgId = await orgIdOfAgent(tx, agentId)
    if (rowOrgId !== orgId) throw new AgentMissing(agentId)
    // The skill-source fence opens BEFORE the agent row lock (its blocking
    // name scopes wrap the rest of this transaction, mirroring how the old
    // per-name chains wrapped the whole write); the visibility set it returns
    // feeds the authorize call below, after the committed bag read.
    const visibleSourceNames = opts?.skillSources ? await enterSkillSourceFence(tx, opts.skillSources) : undefined
    // model/reasoningEffort/env live in the runtimeOverrides JSON — merge key by
    // key so patching one never clobbers the others (null deletes its key).
    let overrides: RuntimeOverrides | typeof undefined
    if (
      patch.model !== undefined ||
      patch.reasoningEffort !== undefined ||
      patch.outputMode !== undefined ||
      patch.showFooter !== undefined ||
      patch.showStatusBar !== undefined ||
      patch.fastMode !== undefined ||
      patch.permissionMode !== undefined ||
      patch.approvalsReviewer !== undefined ||
      patch.allowRuntimeChangesInChat !== undefined ||
      patch.pause !== undefined ||
      patch.env !== undefined ||
      patch.mcpServers !== undefined ||
      patch.skills !== undefined ||
      patch.memory !== undefined
    ) {
      // Row-lock the read: overrides are ONE JsonB bag, so the read-merge-write
      // below replaces keys this patch OMITS with whatever it read. Unlocked,
      // two overlapping edits lose each other's keys — and an omitted
      // mcpServers/skills key could "restore" entries a concurrent edit removed,
      // resurrecting a reference the provider-delete guard already checked
      // (routes/mcp-providers.ts). FOR UPDATE holds the row until this
      // transaction commits, so concurrent bag writers fully serialize.
      const rows = await tx.$queryRaw<Array<{ runtimeOverrides: unknown; orgId: string }>>(
        Prisma.sql`SELECT "runtimeOverrides", "orgId" FROM "agent" WHERE "id" = ${agentId} FOR UPDATE`
      )
      const cur = (rows[0]?.runtimeOverrides ?? null) as RuntimeOverrides | null
      // External-memory fence: the committed binding plus the one this patch
      // binds share their connections' advisory mutation scopes with the
      // connection/grant mutations (and their delete's no-agent-bound scan).
      // Taken AFTER the row lock — try-locks never wait, so no deadlock.
      if (rows[0]) {
        await fenceMemoryConnections(
          tx,
          rows[0].orgId,
          [
            ...externalConnectionIdOf(cur?.memory),
            ...(patch.memory !== undefined ? externalConnectionIdOf(patch.memory) : [])
          ],
          patch.memory !== undefined ? externalConnectionIdOf(patch.memory)[0] : undefined
        )
      }
      // The enable-list authorization decisions happen HERE, against the row-locked
      // committed lists — a removal-only write (which joins no registry-name chain)
      // can no longer land between the hold check and the write it authorized. A
      // throw aborts the transaction before any merge is computed.
      opts?.authorizeMcpServers?.(cur?.mcpServers ?? [])
      opts?.skillSources?.authorize(cur?.skills ?? [], visibleSourceNames!)
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
      if (patch.showStatusBar !== undefined) next.showStatusBar = patch.showStatusBar
      if (patch.fastMode !== undefined) {
        if (patch.fastMode === null) delete next.fastMode
        else next.fastMode = patch.fastMode
      }
      if (patch.permissionMode !== undefined) {
        if (patch.permissionMode === null) delete next.permissionMode
        else next.permissionMode = patch.permissionMode
      }
      if (patch.approvalsReviewer !== undefined) {
        if (patch.approvalsReviewer === null) delete next.approvalsReviewer
        else next.approvalsReviewer = patch.approvalsReviewer
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
      if (patch.skills !== undefined) {
        if (patch.skills === null) delete next.skills
        else next.skills = patch.skills
      }
      if (patch.memory !== undefined) {
        if (patch.memory === null) delete next.memory
        else next.memory = patch.memory
      }
      overrides = next
    }
    const a = await tx.agent.update({
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
        ...(patch.runInSandbox !== undefined ? { runInSandbox: patch.runInSandbox } : {}),
        ...(patch.gitAccess !== undefined ? { gitAccess: patch.gitAccess } : {}),
        ...(patch.agentDir !== undefined ? { agentDir: patch.agentDir } : {}),
        ...(patch.managedSkills !== undefined ? { managedSkills: patch.managedSkills ?? [] } : {}),
        ...(overrides !== undefined ? { runtimeOverrides: overrides } : {}),
        // A PATCH is a human edit — advance the last-modified audit. The editor is
        // stamped when known (absent under devAuth ⇒ leave the prior editor as-is).
        lastModifiedAt: new Date(),
        ...(patch.lastModifiedByUserId ? { lastModifiedByUserId: patch.lastModifiedByUserId } : {}),
        // One ordering domain per agent: a PATCH may change env, secrets (through
        // the config writer's transaction), workspace, or any other CP-owned spec
        // field, so it always advances the revision the daemon fences on.
        configRevision: { increment: 1 }
      },
      include: withUsers
    })
    // Enroll into any `all`-audience entry added since this agent last changed,
    // then validate the COMPLETE resolved configuration under the locks held
    // above. This is also where an agent-local secret that would sit beneath an
    // assigned organization variable is refused — the write direction the design
    // rejects from both sides (§3.2).
    await fenceAgentLocalConfigWrite(tx, orgId, agentId, patch.lastModifiedByUserId)
    return toRecord(a)
  }

  async setWorkspace(
    orgId: OrgId,
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
        // Org fence rides the CAS read + write: a cross-org id misses exactly
        // like a stale expectation (org-scoped-data-layer.md §3).
        const current = await tx.agent.findUnique({
          where: { id: agentId, orgId },
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
          where: { id: agentId, orgId, workspaceMode: expectedMode, lastModifiedAt: expectedLastModifiedAt },
          data: {
            workspaceMode: workspace.mode,
            workspaceIsolation: workspace.mode !== 'scratch' ? (workspace.isolation ?? 'session') : 'shared',
            gitRepo: workspace.mode !== 'scratch' ? workspace.gitRepo : null,
            gitBranch: workspace.mode !== 'scratch' ? (workspace.gitBranch ?? 'main') : null,
            agentDir: workspace.mode !== 'scratch' ? (workspace.agentDir ?? null) : null,
            installationId: workspace.mode === 'github' ? (workspace.installationId ?? null) : null,
            workspaceRepoId: workspaceRepoId ?? null,
            gitAccess: workspace.mode !== 'scratch' ? (workspace.gitAccess ?? 'write') : 'write',
            lastModifiedAt: new Date(Math.max(Date.now(), expectedLastModifiedAt.getTime() + 1)),
            ...(byUserId ? { lastModifiedByUserId: byUserId } : {}),
            // `workspace` rides the AgentSpec, so this edit joins the same
            // ordering domain the daemon's revision fence compares.
            configRevision: { increment: 1 }
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
    orgId: OrgId,
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
            orgId,
            workspaceMode: expectedWorkspace.mode,
            workspaceRepoId: expectedWorkspaceRepoId ?? null,
            lastModifiedAt: expectedLastModifiedAt
          },
          data: {
            workspaceMode: workspace.mode,
            workspaceIsolation: workspace.mode !== 'scratch' ? (workspace.isolation ?? 'session') : 'shared',
            gitRepo: workspace.mode !== 'scratch' ? workspace.gitRepo : null,
            gitBranch: workspace.mode !== 'scratch' ? (workspace.gitBranch ?? 'main') : null,
            agentDir: workspace.mode !== 'scratch' ? (workspace.agentDir ?? null) : null,
            installationId: workspace.mode === 'github' ? (workspace.installationId ?? null) : null,
            workspaceRepoId: workspaceRepoId ?? null,
            gitAccess: workspace.mode !== 'scratch' ? (workspace.gitAccess ?? 'write') : 'write',
            lastModifiedAt: new Date(Math.max(Date.now(), expectedLastModifiedAt.getTime() + 1)),
            ...(byUserId ? { lastModifiedByUserId: byUserId } : {}),
            // `workspace` rides the AgentSpec, so this edit joins the same
            // ordering domain the daemon's revision fence compares.
            configRevision: { increment: 1 }
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

  async refreshGitlabProjectPath(orgId: OrgId, projectId: bigint, projectPath: string): Promise<AgentId[]> {
    // The path is a mutable display/transport hint keyed by the immutable project
    // id (§8.1). Both places that replicate it drift on a rename: a gitlab
    // workspace's clone URL, and every explicit authorization's display path,
    // which is what the daemon maps a NAMED project back to its numeric id with
    // (§13.1). Leaving a grant stale orphans the new path and makes an ask under
    // the old one fail the daemon's echo check against the binding's new path.
    // Both writes join the configRevision ordering domain the daemon fences on,
    // in one transaction, so a spec never carries one half of the rename.
    const cloneUrl = `https://gitlab.com/${projectPath}`
    return this.transaction(async (tx) => {
      const workspaces = await tx.agent.findMany({
        where: { orgId, workspaceMode: 'gitlab', workspaceRepoId: projectId, NOT: { gitRepo: cloneUrl } },
        select: { id: true }
      })
      const workspaceIds = workspaces.map((row: { id: string }) => row.id)
      if (workspaceIds.length > 0) {
        await tx.agent.updateMany({
          where: { id: { in: workspaceIds }, orgId, workspaceMode: 'gitlab', workspaceRepoId: projectId },
          data: { gitRepo: cloneUrl }
        })
      }
      const staleGrants = {
        provider: 'gitlab',
        repoId: projectId,
        agent: { orgId },
        repoFullName: { not: projectPath }
      }
      const grantAgentIds = (
        await tx.agentRepoAuthorization.findMany({ where: staleGrants, select: { agentId: true } })
      ).map((row: { agentId: string }) => row.agentId)
      if (grantAgentIds.length > 0) {
        await tx.agentRepoAuthorization.updateMany({ where: staleGrants, data: { repoFullName: projectPath } })
      }
      const ids = [...new Set([...workspaceIds, ...grantAgentIds])].sort()
      // One bump per agent, after both writes: an agent holding the workspace AND
      // a grant on the same project must not advance two revisions for one rename.
      await bumpAgentConfigRevisions(tx, ids)
      return ids.map((id: string) => AgentId(id))
    })
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
      // The repo identity feeds workspace credential resolution, so keep it in the
      // same ordering domain the daemon's revision fence compares.
      await tx.agent.update({
        where: { id: agentId },
        data: { workspaceRepoId: repoId, configRevision: { increment: 1 } }
      })
      // Only the github grant is redundant with a github workspace: a gitlab project
      // that happens to carry the same number is a different repository (§8.1).
      await tx.agentRepoAuthorization.deleteMany({ where: { agentId, provider: 'github', repoId } })
      return true
    })
  }

  async setSharing(
    orgId: OrgId,
    agentId: AgentId,
    sharing: { visibility: AgentRecord['visibility']; sharedWith: string[] },
    byUserId?: string
  ): Promise<AgentRecord> {
    return this.transaction(async (tx) => {
      // Org fence: a cross-org id throws the same P2025 as a missing row.
      const existing = await tx.agent.findUniqueOrThrow({
        where: { id: agentId, orgId },
        select: { orgId: true, visibility: true }
      })
      const memberships = await lockResourceWriteMemberships(tx, {
        orgId: existing.orgId,
        visibility: sharing.visibility,
        actorUserId: byUserId,
        sharedWith: sharing.sharedWith
      })
      // Everyone DMs may be On. Crossing into Restricted is a trust-boundary
      // change, so close every known direct row in the SAME transaction as the
      // visibility write. A persistence failure rolls the whole transition back;
      // route/spec convergence can never compile a restricted agent from
      // still-enabled rows. Do not repeat this for restricted share-set edits — an
      // editor may have deliberately re-enabled a DM after the initial transition.
      if (existing.visibility !== 'restricted' && sharing.visibility === 'restricted') {
        await tx.integrationChannel.updateMany({
          where: {
            integration: { agentId },
            kind: { in: ['im', 'mpim'] },
            trigger: { not: 'off' }
          },
          data: { trigger: 'off' }
        })
      }
      // A sharing change is a human edit — advance the last-modified audit
      // (editor stamped when known; absent under devAuth ⇒ leave it unchanged).
      const a = await tx.agent.update({
        where: { id: agentId },
        data: {
          visibility: sharing.visibility,
          sharedWith: memberships.sharedWith ?? [],
          lastModifiedAt: new Date(),
          ...(byUserId ? { lastModifiedByUserId: byUserId } : {})
        },
        include: withUsers
      })
      return toRecord(a)
    })
  }

  async setCallPolicy(
    orgId: OrgId,
    agentId: AgentId,
    policy: {
      callPolicy: AgentCallPolicy
      allowedCallerAgentIds: string[]
      outboundPolicy?: AgentCallPolicy
      allowedTargetAgentIds?: string[]
    },
    byUserId?: string
  ): Promise<AgentRecord> {
    // Org fence: a cross-org id throws the same P2025 as a missing row.
    const a = await this.db.agent.update({
      where: { id: agentId, orgId },
      data: {
        callPolicy: policy.callPolicy,
        allowedCallerAgentIds: policy.allowedCallerAgentIds,
        ...(policy.outboundPolicy !== undefined ? { outboundPolicy: policy.outboundPolicy } : {}),
        ...(policy.allowedTargetAgentIds !== undefined ? { allowedTargetAgentIds: policy.allowedTargetAgentIds } : {}),
        lastModifiedAt: new Date(),
        ...(byUserId ? { lastModifiedByUserId: byUserId } : {}),
        // Both call policies ride the AgentSpec (the daemon enforces them locally),
        // so this edit joins the agent's single ordering domain.
        configRevision: { increment: 1 }
      },
      include: withUsers
    })
    return toRecord(a)
  }

  async setPlacement(agentId: AgentId, target: PlacementTarget): Promise<void> {
    await this.transaction(async (tx) => {
      const current = await lockAgentPlacement(tx, agentId)
      if (!current) return
      // Third write-time invariant (daemon-groups.md §2), inside the transaction that writes it.
      if (target.kind === 'set') await assertAgentMayUseSet(tx, { id: agentId, orgId: current.orgId }, target.setId)
      if (target.kind === 'daemon') await assertDaemonNotInSet(tx, agentId, target.daemonId)
      const columns = placementColumns(target)
      await tx.agent.update({
        where: { id: agentId },
        // A placement change makes a different daemon the spec's recipient. Bumping
        // here means the new owner's first snapshot is never mistaken for an older
        // revision it already applied during a previous residency.
        data: {
          ...columns,
          status: target.kind === 'unplaced' ? 'inactive' : 'active',
          configRevision: { increment: 1 }
        }
      })
      if (target.kind !== 'unplaced') await settlePresetPlacement(tx, agentId)
      if (!samePlacement(placementTargetOf(current), target)) await settlePlacementChange(tx, agentId)
    })
  }

  async movePlacement(
    agentId: AgentId,
    expected: PlacementTarget,
    target: PlacementTarget,
    byUserId?: string
  ): Promise<AgentRecord | null> {
    // The explicit Agent lock serializes the compare-and-set read with all
    // placement writers. Keep the expected columns on the update as a defensive guard; a
    // missing/deleted row still resolves to null rather than overwriting state.
    const expectedColumns = placementColumns(expected)
    const columns = placementColumns(target)
    try {
      return await this.transaction(async (tx) => {
        const current = await lockAgentPlacement(tx, agentId)
        if (!current || !samePlacement(placementTargetOf(current), expected)) return null
        if (target.kind === 'set') await assertAgentMayUseSet(tx, { id: agentId, orgId: current.orgId }, target.setId)
        if (target.kind === 'daemon') await assertDaemonNotInSet(tx, agentId, target.daemonId)
        const a = await tx.agent.update({
          where: {
            id: agentId,
            daemonId: expectedColumns.daemonId,
            setId: expectedColumns.setId,
            placementKind: expectedColumns.placementKind
          },
          data: {
            ...columns,
            status: target.kind === 'unplaced' ? 'inactive' : 'active',
            lastModifiedAt: new Date(),
            ...(byUserId ? { lastModifiedByUserId: byUserId } : {}),
            // See setPlacement: a move re-targets who receives the spec, so the
            // revision must advance past anything the previous owner applied.
            configRevision: { increment: 1 }
          },
          include: withUsers
        })
        if (target.kind !== 'unplaced') await settlePresetPlacement(tx, agentId)
        if (!samePlacement(expected, target)) await settlePlacementChange(tx, agentId)
        return toRecord(a)
      })
    } catch (err) {
      // Avoid importing a second Prisma runtime just for the P2025 class guard:
      // generated known-request errors expose their stable code structurally.
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2025') return null
      throw err
    }
  }

  async delete(orgId: OrgId, agentId: AgentId): Promise<HookRecord[]> {
    return this.transaction(async (tx) => {
      // Keep the agent-owned hook set stable from enumeration through cleanup
      // and the cascading delete. Hook create/rebind/remove takes this same lock
      // before its per-hook lifecycle lock.
      await lockHookReviewAgentLifecycleScope(tx, agentId)
      // The lifecycle advisory is the documented outer scope. Take the Agent
      // row immediately after it so every relational lock below follows
      // Agent → hook/preset → cascade. A missing row still reaches the Prisma
      // delete below and preserves its existing not-found error semantics.
      await lockAgentPlacement(tx, agentId)
      // A delete removes the agent's external-memory binding, so it shares the
      // connection's advisory mutation scope with connection/grant mutations —
      // an in-flight one fail-fasts this delete to 409 rather than tearing down
      // an agent whose connection state is mid-change.
      // Org fence on the read AND the delete below: a cross-org id skips the
      // side-effects here and reaches the fenced Prisma delete, preserving the
      // missing-row error semantics the comment above documents.
      const row = await tx.agent.findUnique({
        where: { id: agentId, orgId },
        select: { orgId: true, runtimeOverrides: true }
      })
      if (row) {
        const memory = (row.runtimeOverrides as RuntimeOverrides | null)?.memory
        await fenceMemoryConnections(tx, row.orgId, externalConnectionIdOf(memory))
      }
      const hooks = new PgHookRepo(tx)
      const removedHooks = await hooks.listForAgent(agentId)
      await hooks.tombstoneReviewProjections(
        removedHooks.map((hook) => hook.id),
        new Date(),
        'failure'
      )
      // Deleting a preset is the explicit opt-out — settle BEFORE the delete
      // (the FK SetNull would orphan the row from this agentId lookup).
      await settlePresetPlacement(tx, agentId)
      await tx.agent.delete({ where: { id: agentId, orgId } })
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

  async listByIds(agentIds: readonly AgentId[]): Promise<AgentRecord[]> {
    if (agentIds.length === 0) return []
    const rows = await this.db.agent.findMany({
      where: { id: { in: [...agentIds] } },
      orderBy: { createdAt: 'asc' },
      include: withUsers
    })
    return rows.map(toRecord)
  }

  async configRevisions(agentIds: readonly AgentId[]): Promise<Map<string, bigint>> {
    if (agentIds.length === 0) return new Map()
    const rows = await this.db.agent.findMany({
      where: { id: { in: [...agentIds] } },
      select: { id: true, configRevision: true }
    })
    return new Map(rows.map((r) => [r.id, r.configRevision]))
  }

  // The placement relation read from the MEMBER's side, and deliberately the row-wise mirror of
  // `domain/placement.ts#placementTargets` read from the agent's side: `placementKind: 'daemon'`
  // is what makes "this daemon is the placement" mean the same thing in both directions. Without
  // it the two agree only by accident — because a `set` placement happens to store a null daemon
  // ref — and a later kind that stores one would be placed here and unplaced there.
  async listForDaemon(daemonId: DaemonId): Promise<AgentRecord[]> {
    const rows = await this.db.agent.findMany({
      where: { daemonId, placementKind: 'daemon' },
      orderBy: { createdAt: 'asc' },
      include: withUsers
    })
    return rows.map(toRecord)
  }

  // The org PEER directory (agent-collaboration §2.5/§6.1). A narrow `select` on the
  // agent table alone — no `withUsers` join (audit identities are console-only) and
  // deliberately NO `visibilityWhere`: ResourceVisibility gates human console access,
  // while peer discovery is gated ONLY by the directional call policy the caller
  // applies over these rows. Unlike `IntegrationRepo.agentsInChannel` there is no
  // integration join, so an agent with no IM integration is included — that is the
  // whole point of the flat directory.
  //
  // Excluding the UNPLACED is not an optimization: this one query feeds BOTH the
  // `channel/agents` roster a model discovers peers from AND the flat
  // `CollabRoutesSnapshot.agents[]` wakes are authorized against, and
  // `buildCollabSnapshot` drops daemonId-less rows there (no owning daemon ⇒ nothing to
  // route a wake to). Listing an unplaced agent would therefore advertise a peer that is
  // discoverable but not callable — the model gets a bare 'not_allowed' and retries — so
  // the exclusion belongs in the shared read, where the two surfaces cannot disagree.
  //
  // A `set` agent IS placed and carries no daemonId, so the filter is on the placement, not on
  // one column: each consumer fills the serving daemon in through the resolver, which is the only
  // thing that knows which member holds it right now.
  async orgDirectory(orgId: OrgId): Promise<OrgAgentRecord[]> {
    const rows = await this.db.agent.findMany({
      where: { orgId, OR: [{ daemonId: { not: null } }, { setId: { not: null } }] },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        displayName: true,
        description: true,
        status: true,
        placementKind: true,
        daemonId: true,
        setId: true,
        callPolicy: true,
        allowedCallerAgentIds: true,
        outboundPolicy: true,
        allowedTargetAgentIds: true
      }
    })
    return rows.map((row) => ({
      agentId: AgentId(row.id),
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      status: row.status as OrgAgentRecord['status'],
      placementKind: row.placementKind,
      daemonId: row.daemonId,
      setId: row.setId,
      callPolicy: row.callPolicy as AgentCallPolicy,
      allowedCallerAgentIds: row.allowedCallerAgentIds,
      outboundPolicy: row.outboundPolicy as AgentCallPolicy,
      allowedTargetAgentIds: row.allowedTargetAgentIds
    }))
  }
}
