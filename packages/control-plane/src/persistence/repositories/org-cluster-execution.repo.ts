/**
 * PgOrgClusterExecutionRepo (docs/designs/agentconnect-org-operator.md §2).
 *
 * One row per organization holding the spec fields the control plane owns. The
 * row is desired state only — envelope status is read live from the
 * `AgentConnectOrg` resource, so nothing here can go stale against the cluster.
 * `resourceName` is written exactly once, by the create branch of
 * {@link PgOrgClusterExecutionRepo.upsert}: the CR name addresses a live
 * envelope, so a later rewrite could never be applied.
 */
import { Prisma, type OrgClusterExecution, type PrismaClient } from '../../generated/prisma/client.js'
import type {
  ClusterEgressPolicy,
  ClusterExecutionDefaults,
  ClusterExecutionPatch,
  ClusterExecutionSettings,
  ClusterRuntimeTier,
  OrgClusterExecutionRepo,
  PendingEnvelopeTeardown
} from '../ports.js'
import type { OrgId } from '../../domain/ids.js'
import { withTx } from '../prisma.js'

/** The stored tier array, defensively narrowed — the column is JSONB. */
function toTiers(value: unknown): ClusterRuntimeTier[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const tier = entry as { name?: unknown; warmReplicas?: unknown }
    if (typeof tier?.name !== 'string') return []
    return [{ name: tier.name, warmReplicas: typeof tier.warmReplicas === 'number' ? tier.warmReplicas : 0 }]
  })
}

function toRecord(row: OrgClusterExecution): ClusterExecutionSettings {
  return {
    orgId: row.orgId,
    enabled: row.enabled,
    specRevision: row.specRevision,
    resourceName: row.resourceName,
    suspend: row.suspend,
    daemonImage: row.daemonImage,
    daemonTier: row.daemonTier,
    ...(row.legacyKeyDaemonId ? { legacyKeyDaemonId: row.legacyKeyDaemonId } : {}),
    runtimeImage: row.runtimeImage,
    runtimeTiers: toTiers(row.runtimeTiers),
    quota: {
      maxAgents: row.quotaMaxAgents,
      cpu: row.quotaCpu,
      memory: row.quotaMemory,
      storage: row.quotaStorage
    },
    egressPolicy: row.egressPolicy as ClusterEgressPolicy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export class PgOrgClusterExecutionRepo implements OrgClusterExecutionRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async get(orgId: OrgId): Promise<ClusterExecutionSettings | null> {
    const row = await this.prisma.orgClusterExecution.findUnique({ where: { orgId } })
    return row ? toRecord(row) : null
  }

  async getByResourceName(resourceName: string): Promise<ClusterExecutionSettings | null> {
    const row = await this.prisma.orgClusterExecution.findUnique({ where: { resourceName } })
    return row ? toRecord(row) : null
  }

  /** Conditional on the image, then read back what the row actually holds — the caller
   *  settles a command on this answer, so it must be observed rather than assumed. */
  async restoreDaemonImage(orgId: OrgId, daemonImage: string, expectedImage: string): Promise<string | null> {
    await this.prisma.orgClusterExecution.updateMany({
      where: { orgId, daemonImage: expectedImage },
      data: { daemonImage, specRevision: { increment: 1 } }
    })
    const row = await this.prisma.orgClusterExecution.findUnique({
      where: { orgId },
      select: { daemonImage: true }
    })
    return row?.daemonImage ?? null
  }

  /** Stable `orgId` order so a sweep's log reads the same across boots. */
  async listEnabled(): Promise<ClusterExecutionSettings[]> {
    const rows = await this.prisma.orgClusterExecution.findMany({
      where: { enabled: true },
      orderBy: { orgId: 'asc' }
    })
    return rows.map(toRecord)
  }

  async listPendingTeardowns(limit: number): Promise<PendingEnvelopeTeardown[]> {
    return this.prisma.pendingEnvelopeTeardown.findMany({
      select: { orgId: true, resourceName: true },
      orderBy: { createdAt: 'asc' },
      take: limit
    })
  }

  /** The claim predicate is `beginTransition`'s, negated: an org someone owns
   *  right now is left to them, and an expired claim is swept like any other. */
  async listResyncableOrgIds(afterOrgId: string | null, limit: number, now: Date, leaseMs: number): Promise<string[]> {
    const rows = await this.prisma.orgClusterExecution.findMany({
      where: {
        enabled: true,
        ...(afterOrgId === null ? {} : { orgId: { gt: afterOrgId } }),
        OR: [
          { envelopeTransitionToken: null },
          { envelopeTransitionAt: null },
          { envelopeTransitionAt: { lt: new Date(now.getTime() - leaseMs) } }
        ]
      },
      select: { orgId: true },
      orderBy: { orgId: 'asc' },
      take: limit
    })
    return rows.map((row) => row.orgId)
  }

  async clearPendingTeardown(orgId: string): Promise<void> {
    await this.prisma.pendingEnvelopeTeardown.deleteMany({ where: { orgId } })
  }

  /** The claim is one conditional statement, so two callers cannot both hold it. */
  async beginTransition(
    orgId: OrgId,
    token: string,
    now: Date,
    leaseMs: number
  ): Promise<ClusterExecutionSettings | null> {
    return withTx(this.prisma, async (tx) => {
      const claimed = await tx.orgClusterExecution.updateMany({
        where: {
          orgId,
          OR: [
            { envelopeTransitionToken: null },
            { envelopeTransitionAt: null },
            { envelopeTransitionAt: { lt: new Date(now.getTime() - leaseMs) } }
          ]
        },
        data: { envelopeTransitionAt: now, envelopeTransitionToken: token }
      })
      if (claimed.count === 0) return null
      const row = await tx.orgClusterExecution.findUnique({ where: { orgId } })
      return row ? toRecord(row) : null
    })
  }

  async endTransition(orgId: OrgId, token: string): Promise<void> {
    // Token-conditional: an expired holder must not unlock its successor.
    await this.prisma.orgClusterExecution.updateMany({
      where: { orgId, envelopeTransitionToken: token },
      data: { envelopeTransitionAt: null, envelopeTransitionToken: null }
    })
  }

  async disableAndRecordTeardown(orgId: OrgId, token: string): Promise<boolean> {
    return withTx(this.prisma, async (tx) => {
      const current = await tx.orgClusterExecution.findUnique({ where: { orgId } })
      if (!current) return false
      const won = await tx.orgClusterExecution.updateMany({
        where: { orgId, envelopeTransitionToken: token },
        data: { specRevision: { increment: 1 }, enabled: false }
      })
      if (won.count === 0) return false
      // The resource must go too, and the cluster call can fail — so record the
      // intent here, where it is atomic with the row being switched off.
      await tx.pendingEnvelopeTeardown.createMany({
        data: [{ orgId, resourceName: current.resourceName }],
        skipDuplicates: true
      })
      return true
    })
  }

  /** `ON CONFLICT DO NOTHING`, deliberately — an upsert here would let the loser
   *  of a first-enable race rewrite the winner's freshly claimed row. */
  async createIfAbsent(orgId: OrgId, defaults: ClusterExecutionDefaults): Promise<void> {
    await this.prisma.orgClusterExecution.createMany({
      data: [
        {
          orgId,
          enabled: false,
          resourceName: defaults.resourceName,
          daemonImage: defaults.daemonImage,
          daemonTier: defaults.daemonTier,
          runtimeImage: defaults.runtimeImage,
          runtimeTiers: defaults.runtimeTiers as unknown as Prisma.InputJsonValue,
          quotaMaxAgents: defaults.quota.maxAgents,
          quotaCpu: defaults.quota.cpu,
          quotaMemory: defaults.quota.memory,
          quotaStorage: defaults.quota.storage,
          egressPolicy: defaults.egressPolicy
        }
      ],
      skipDuplicates: true
    })
  }

  async upsert(
    orgId: OrgId,
    defaults: ClusterExecutionDefaults,
    patch: ClusterExecutionPatch
  ): Promise<ClusterExecutionSettings> {
    const quota = patch.quota ?? {}
    const tiers = (patch.runtimeTiers ?? defaults.runtimeTiers) as unknown as Prisma.InputJsonValue
    const row = await this.prisma.orgClusterExecution.upsert({
      where: { orgId },
      create: {
        orgId,
        enabled: patch.enabled ?? false,
        resourceName: defaults.resourceName,
        suspend: patch.suspend ?? false,
        daemonImage: patch.daemonImage ?? defaults.daemonImage,
        daemonTier: patch.daemonTier ?? defaults.daemonTier,
        runtimeImage: patch.runtimeImage ?? defaults.runtimeImage,
        runtimeTiers: tiers,
        quotaMaxAgents: quota.maxAgents ?? defaults.quota.maxAgents,
        quotaCpu: quota.cpu ?? defaults.quota.cpu,
        quotaMemory: quota.memory ?? defaults.quota.memory,
        quotaStorage: quota.storage ?? defaults.quota.storage,
        egressPolicy: patch.egressPolicy ?? defaults.egressPolicy
      },
      update: {
        // Unconditional, and NOT `@updatedAt`: Prisma skips the timestamp when
        // a patch changes nothing, and the provisioner's fence needs every write
        // to be observable by the writer that raced it.
        specRevision: { increment: 1 },
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.suspend !== undefined ? { suspend: patch.suspend } : {}),
        ...(patch.daemonImage !== undefined ? { daemonImage: patch.daemonImage } : {}),
        ...(patch.daemonTier !== undefined ? { daemonTier: patch.daemonTier } : {}),
        ...(patch.runtimeImage !== undefined ? { runtimeImage: patch.runtimeImage } : {}),
        ...(patch.runtimeTiers !== undefined ? { runtimeTiers: tiers } : {}),
        ...(quota.maxAgents !== undefined ? { quotaMaxAgents: quota.maxAgents } : {}),
        ...(quota.cpu !== undefined ? { quotaCpu: quota.cpu } : {}),
        ...(quota.memory !== undefined ? { quotaMemory: quota.memory } : {}),
        ...(quota.storage !== undefined ? { quotaStorage: quota.storage } : {}),
        ...(patch.egressPolicy !== undefined ? { egressPolicy: patch.egressPolicy } : {})
      }
    })
    return toRecord(row)
  }
}
