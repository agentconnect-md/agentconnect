/**
 * Real-DB fixtures (design §5.4 `fixtures/seed.ts`).
 *
 * Helpers that create FK-anchored rows (daemon, agent) against the shared
 * Testcontainers Postgres, so repo tests for the routing table, launches,
 * sessions, leases, and crons have valid foreign keys to hang off. All default
 * to the seeded `DEFAULT_ORG_ID`.
 */
import type { PrismaClient } from '../../src/generated/prisma/client.js'
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
    gitAccess?: 'read' | 'write'
  } = {}
): Promise<AgentId> {
  await prisma.agent.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      name: opts.name ?? `agent-${id.slice(0, 4)}`,
      runtime: opts.runtime ?? 'claude',
      daemonId: opts.daemonId,
      ...(opts.visibility ? { visibility: opts.visibility } : {}),
      ...(opts.sharedWith ? { sharedWith: opts.sharedWith } : {}),
      ...(opts.createdByUserId ? { createdByUserId: opts.createdByUserId } : {}),
      ...(opts.gitRepo ? { workspaceMode: 'github' as const, gitRepo: opts.gitRepo } : {}),
      ...(opts.installationId ? { installationId: opts.installationId } : {}),
      ...(opts.gitAccess ? { gitAccess: opts.gitAccess } : {})
    }
  })
  return AgentId(id)
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
