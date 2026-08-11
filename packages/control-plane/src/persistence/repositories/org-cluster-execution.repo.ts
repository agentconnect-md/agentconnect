/**
 * PgOrgClusterExecutionRepo (docs/designs/agentconnect-org-operator.md §2).
 *
 * One row per organization holding the spec fields the control plane owns. The
 * row is desired state only — envelope status is read live from the
 * `AgentConnectOrg` resource, so nothing here can go stale against the cluster.
 * `targetNamespace` and `credentialSecretName` are written exactly once, by the
 * create branch of {@link PgOrgClusterExecutionRepo.upsert}: the CRD marks both
 * immutable, so a later rewrite could never be applied.
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
    targetNamespace: row.targetNamespace,
    suspend: row.suspend,
    daemonImage: row.daemonImage,
    daemonTier: row.daemonTier,
    credentialSecretName: row.credentialSecretName,
    ...(row.credentialRevision ? { credentialRevision: row.credentialRevision } : {}),
    ...(row.credentialDaemonId ? { credentialDaemonId: row.credentialDaemonId } : {}),
    ...(row.credentialApiKeyId ? { credentialApiKeyId: row.credentialApiKeyId } : {}),
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

  async listPendingTeardowns(limit: number): Promise<PendingEnvelopeTeardown[]> {
    return this.prisma.pendingEnvelopeTeardown.findMany({
      select: { orgId: true, targetNamespace: true },
      orderBy: { createdAt: 'asc' },
      take: limit
    })
  }

  async clearPendingTeardown(orgId: string): Promise<void> {
    await this.prisma.pendingEnvelopeTeardown.deleteMany({ where: { orgId } })
  }

  async setCredential(
    orgId: OrgId,
    credential: { daemonId: string; apiKeyId: string; revision: string } | null
  ): Promise<ClusterExecutionSettings> {
    const row = await this.prisma.orgClusterExecution.update({
      where: { orgId },
      data: {
        // A credential change IS a spec change (`credentialRevision` is what
        // forces the pod Recreate), so it rides the same fence as every other write.
        specRevision: { increment: 1 },
        credentialDaemonId: credential?.daemonId ?? null,
        credentialApiKeyId: credential?.apiKeyId ?? null,
        credentialRevision: credential?.revision ?? null
      }
    })
    return toRecord(row)
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
        targetNamespace: defaults.targetNamespace,
        suspend: patch.suspend ?? false,
        daemonImage: patch.daemonImage ?? defaults.daemonImage,
        daemonTier: patch.daemonTier ?? defaults.daemonTier,
        credentialSecretName: defaults.credentialSecretName,
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
