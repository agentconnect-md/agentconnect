/**
 * Real-DB fixtures (design §5.4 `fixtures/seed.ts`).
 *
 * Helpers that create FK-anchored rows (daemon, agent) against the shared
 * Testcontainers Postgres, so repo tests for the routing table, launches,
 * sessions, leases, and crons have valid foreign keys to hang off. All default
 * to the seeded `DEFAULT_ORG_ID`.
 */
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { AgentId, DaemonId, OrgId, type Epoch } from '../../src/domain/ids.js'

export const DEF_ORG = OrgId(DEFAULT_ORG_ID)
const DEFAULT_DAEMON_CAPABILITIES = {
  platforms: ['slack', 'telegram', 'discord'],
  runtimes: ['claude'],
  acp: true,
  features: []
}

export async function seedDaemon(
  prisma: PrismaClient,
  id: string,
  opts: {
    sessionEpoch?: bigint
    maxAgents?: number
    capabilities?: { platforms: string[]; runtimes: string[]; acp: boolean; features: string[] }
    visibility?: 'org' | 'restricted'
    sharedWith?: string[]
    createdByUserId?: string
  } = {}
): Promise<DaemonId> {
  await prisma.daemon.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      sessionEpoch: opts.sessionEpoch ?? 1n,
      maxAgents: opts.maxAgents ?? 4,
      status: 'ready',
      // A `ready` fixture represents a registered stock daemon. Tests that need a
      // narrower adapter set pass `capabilities` explicitly.
      capabilities: opts.capabilities ?? DEFAULT_DAEMON_CAPABILITIES,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      ...(opts.sharedWith ? { sharedWith: opts.sharedWith } : {}),
      ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {})
    }
  })
  return DaemonId(id)
}

export async function seedAgent(
  prisma: PrismaClient,
  id: string,
  opts: {
    runtime?: string
    daemonId?: string
    name?: string
    visibility?: 'org' | 'restricted'
    sharedWith?: string[]
    createdByUserId?: string
    /** Full cloneable address (storage invariant) ⇒ a github-mode workspace. */
    gitRepo?: string
    /** GithubInstallation row-id provenance hint ⇒ github-APP credential mode. */
    installationId?: string
    /** Numeric GitLab project id ⇒ a gitlab-mode workspace on that managed binding. */
    gitlabProjectId?: bigint
    gitAccess?: 'read' | 'write'
    /** `runtimeOverrides` JSON — where the MCP enable-list and memory binding live. */
    runtimeOverrides?: Record<string, unknown>
    /** A `set` placement: placed, but naming no machine — which member serves it is the ledger's. */
    setId?: string
    /** Owning organization; defaults to the seeded one (multi-org tests pass their own). */
    orgId?: string
  } = {}
): Promise<AgentId> {
  await prisma.agent.create({
    data: {
      id,
      orgId: opts.orgId ?? DEFAULT_ORG_ID,
      name: opts.name ?? `agent-${id.slice(0, 4)}`,
      runtime: opts.runtime ?? 'claude',
      daemonId: opts.daemonId,
      ...(opts.setId ? { placementKind: 'set' as const, setId: opts.setId } : {}),
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      ...(opts.sharedWith ? { sharedWith: opts.sharedWith } : {}),
      ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
      ...(opts.gitRepo ? { workspaceMode: 'github' as const, gitRepo: opts.gitRepo } : {}),
      ...(opts.gitlabProjectId !== undefined
        ? {
            workspaceMode: 'gitlab' as const,
            workspaceRepoId: opts.gitlabProjectId,
            gitRepo: opts.gitRepo ?? 'https://gitlab.com/example-group/example-project'
          }
        : {}),
      ...(opts.installationId ? { installationId: opts.installationId } : {}),
      ...(opts.gitAccess ? { gitAccess: opts.gitAccess } : {}),
      ...(opts.runtimeOverrides ? { runtimeOverrides: opts.runtimeOverrides as Prisma.InputJsonValue } : {})
    }
  })
  return AgentId(id)
}

/** A held duty group covering `agentIds`. The lease is live by default — an
 *  expired one is how a test states "this member no longer serves it".
 *  `confirmed` is the hold the member reported in its digest: unconfirmed (the default) is a
 *  lease, not a route, so only a confirmed one makes the agent addressable. */
export async function seedDutyGroup(
  prisma: PrismaClient,
  groupId: string,
  holder: string,
  agentIds: string[],
  opts: { expiresAt?: Date; term?: bigint; orgId?: string; confirmed?: boolean } = {}
): Promise<void> {
  const orgId = opts.orgId ?? DEFAULT_ORG_ID
  const term = opts.term ?? 1n
  await prisma.dutyGroup.create({
    data: {
      id: groupId,
      orgId,
      holder,
      term,
      ...(opts.confirmed ? { confirmedTerm: term, confirmedHolder: holder } : {}),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 120_000)
    }
  })
  await prisma.dutyGroupMember.createMany({
    data: agentIds.map((refId) => ({ kind: 'agent' as const, refId, groupId, orgId }))
  })
}

/** A converged session milestone row. `visibility`/`ownerIdentity` default to
 *  what ingest records for a channel session (session-visibility.md §4.2). */
export async function seedSessionMeta(
  prisma: PrismaClient,
  id: string,
  agentId: string,
  opts: {
    visibility?: 'org' | 'private'
    ownerIdentity?: string
    daemonId?: string
    /** The shared-store set the rows went to (a pool-recorded session); absent ⇒ private store. */
    contentSetId?: string
    platform?: string
    channel?: string
    parentSessionId?: string
    lastActivityAt?: Date
    /** When the session BEGAN; defaults to now. What the per-org session-rate windows read. */
    startedAt?: Date
    phase?: 'plan' | 'start' | 'end' | 'problem'
    workspaceIsolation?: 'shared' | 'session'
    model?: string
    /** Owning organization; defaults to the seeded one (multi-org tests pass their own). */
    orgId?: string
  } = {}
): Promise<string> {
  await prisma.sessionMeta.create({
    data: {
      id,
      agentId,
      orgId: opts.orgId ?? DEFAULT_ORG_ID,
      platform: opts.platform ?? 'slack',
      channel: opts.channel ?? '#general',
      phase: opts.phase ?? 'start',
      lastActivityAt: opts.lastActivityAt ?? new Date(),
      ...(opts.startedAt ? { startedAt: opts.startedAt } : {}),
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      ...(opts.ownerIdentity ? { ownerIdentity: opts.ownerIdentity } : {}),
      ...(opts.daemonId ? { daemonId: opts.daemonId } : {}),
      ...(opts.contentSetId ? { contentSetId: opts.contentSetId } : {}),
      ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
      ...(opts.workspaceIsolation ? { workspaceIsolation: opts.workspaceIsolation } : {}),
      ...(opts.model ? { model: opts.model } : {})
    }
  })
  return id
}

export async function seedLaunch(
  prisma: PrismaClient,
  id: string,
  agentId: string,
  daemonId: string,
  opts: { epoch?: bigint; runtime?: string } = {}
): Promise<string> {
  await prisma.agentLaunch.create({
    data: {
      id,
      agentId,
      daemonId,
      runtime: opts.runtime ?? 'claude',
      launchEpoch: opts.epoch ?? 1n,
      status: 'running'
    }
  })
  return id
}

/** A handy epoch literal for tests. */
export const E = (n: bigint): Epoch => n as Epoch
