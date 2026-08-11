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
  PendingDaemonKeyRevocation,
  PendingEnvelopeTeardown
} from '../ports.js'
import type { OrgId } from '../../domain/ids.js'
import { withTx, type PrismaLike } from '../prisma.js'

/** The stored tier array, defensively narrowed — the column is JSONB. */
function toTiers(value: unknown): ClusterRuntimeTier[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const tier = entry as { name?: unknown; warmReplicas?: unknown }
    if (typeof tier?.name !== 'string') return []
    return [{ name: tier.name, warmReplicas: typeof tier.warmReplicas === 'number' ? tier.warmReplicas : 0 }]
  })
}

/** Record a revocation intent inside the caller's transaction. Idempotent on the key id. */
async function enqueueRevocation(tx: PrismaLike, orgId: string, apiKeyId: string, reason: string): Promise<void> {
  await tx.pendingDaemonKeyRevocation.createMany({ data: [{ apiKeyId, orgId, reason }], skipDuplicates: true })
}

function toRecord(row: OrgClusterExecution): ClusterExecutionSettings {
  return {
    orgId: row.orgId,
    enabled: row.enabled,
    specRevision: row.specRevision,
    credentialRotationSeq: row.credentialRotationSeq,
    targetNamespace: row.targetNamespace,
    suspend: row.suspend,
    daemonImage: row.daemonImage,
    daemonTier: row.daemonTier,
    credentialSecretName: row.credentialSecretName,
    ...(row.credentialRevision ? { credentialRevision: row.credentialRevision } : {}),
    ...(row.credentialDaemonId ? { credentialDaemonId: row.credentialDaemonId } : {}),
    ...(row.credentialApiKeyId ? { credentialApiKeyId: row.credentialApiKeyId } : {}),
    ...(row.credentialStagedApiKeyId ? { credentialStagedApiKeyId: row.credentialStagedApiKeyId } : {}),
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

  /**
   * The claim is one conditional statement plus, on takeover, the adoption of
   * whatever the dead holder left staged. Both live in one transaction: a
   * takeover that forgot the staged key would strand a live, non-expiring
   * credential with nothing naming it.
   */
  async beginCredentialRotation(
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
            { credentialRotationToken: null },
            { credentialRotationAt: null },
            { credentialRotationAt: { lt: new Date(now.getTime() - leaseMs) } }
          ]
        },
        data: { credentialRotationAt: now, credentialRotationToken: token, credentialRotationSeq: { increment: 1 } }
      })
      if (claimed.count === 0) return null
      const row = await tx.orgClusterExecution.findUnique({ where: { orgId } })
      if (!row) return null
      if (row.credentialStagedApiKeyId) {
        await enqueueRevocation(tx, orgId, row.credentialStagedApiKeyId, 'cluster credential rotation abandoned')
        await tx.orgClusterExecution.update({ where: { orgId }, data: { credentialStagedApiKeyId: null } })
        return toRecord({ ...row, credentialStagedApiKeyId: null })
      }
      return toRecord(row)
    })
  }

  async endCredentialRotation(orgId: OrgId, token: string): Promise<void> {
    // Token-conditional: an expired holder must not unlock its successor.
    await this.prisma.orgClusterExecution.updateMany({
      where: { orgId, credentialRotationToken: token },
      data: { credentialRotationAt: null, credentialRotationToken: null }
    })
  }

  async stageCredentialDaemon(orgId: OrgId, token: string, daemonId: string): Promise<boolean> {
    const held = await this.prisma.orgClusterExecution.updateMany({
      where: { orgId, credentialRotationToken: token },
      data: { credentialDaemonId: daemonId }
    })
    return held.count > 0
  }

  async stageCredentialKey(orgId: OrgId, token: string, apiKeyId: string): Promise<boolean> {
    const held = await this.prisma.orgClusterExecution.updateMany({
      where: { orgId, credentialRotationToken: token },
      data: { credentialStagedApiKeyId: apiKeyId }
    })
    return held.count > 0
  }

  async commitCredential(
    orgId: OrgId,
    token: string,
    credential: { daemonId: string; apiKeyId: string; revision: string },
    reason: string
  ): Promise<boolean> {
    return withTx(this.prisma, async (tx) => {
      // The predicate IS the write: a `findUnique` check followed by an
      // unconditional update leaves a window in which a successor takes the
      // claim over, and Prisma's default isolation would let the stale write
      // land anyway. `enabled` is part of it too — a rotation must never commit
      // a live key onto an envelope that disable has already retired.
      const superseded = (await tx.orgClusterExecution.findUnique({ where: { orgId } }))?.credentialApiKeyId
      const won = await tx.orgClusterExecution.updateMany({
        where: { orgId, credentialRotationToken: token, enabled: true },
        data: {
          // A credential change IS a spec change (`credentialRevision` is what
          // forces the pod Recreate), so it rides the same fence as every other write.
          specRevision: { increment: 1 },
          credentialDaemonId: credential.daemonId,
          credentialApiKeyId: credential.apiKeyId,
          credentialRevision: credential.revision,
          credentialStagedApiKeyId: null
        }
      })
      if (won.count === 0) return false
      // Same transaction as the overwrite: queueing the predecessor separately
      // would lose it whenever the process stopped in between.
      if (superseded && superseded !== credential.apiKeyId) {
        await enqueueRevocation(tx, orgId, superseded, reason)
      }
      return true
    })
  }

  async abandonStagedCredential(orgId: OrgId, token: string, reason: string): Promise<void> {
    await withTx(this.prisma, async (tx) => {
      const staged = (await tx.orgClusterExecution.findUnique({ where: { orgId } }))?.credentialStagedApiKeyId
      if (!staged) return
      const won = await tx.orgClusterExecution.updateMany({
        where: { orgId, credentialRotationToken: token, credentialStagedApiKeyId: staged },
        data: { credentialStagedApiKeyId: null }
      })
      if (won.count === 0) return
      await enqueueRevocation(tx, orgId, staged, reason)
    })
  }

  async retireCredential(orgId: OrgId, token: string, reason: string): Promise<boolean> {
    return withTx(this.prisma, async (tx) => {
      const current = await tx.orgClusterExecution.findUnique({ where: { orgId } })
      if (!current) return false
      const won = await tx.orgClusterExecution.updateMany({
        where: { orgId, credentialRotationToken: token },
        data: {
          specRevision: { increment: 1 },
          enabled: false,
          credentialApiKeyId: null,
          credentialRevision: null,
          credentialStagedApiKeyId: null
        }
      })
      if (won.count === 0) return false
      for (const apiKeyId of [current.credentialApiKeyId, current.credentialStagedApiKeyId]) {
        if (apiKeyId) await enqueueRevocation(tx, orgId, apiKeyId, reason)
      }
      // The resource must go too, and the cluster call can fail — so record the
      // intent here, where it is atomic with the credential being dropped.
      await tx.pendingEnvelopeTeardown.createMany({
        data: [{ orgId, targetNamespace: current.targetNamespace }],
        skipDuplicates: true
      })
      return true
    })
  }

  async enqueueKeyRevocation(orgId: string, apiKeyId: string, reason: string): Promise<void> {
    await enqueueRevocation(this.prisma, orgId, apiKeyId, reason)
  }

  async listPendingKeyRevocations(limit: number): Promise<PendingDaemonKeyRevocation[]> {
    return this.prisma.pendingDaemonKeyRevocation.findMany({
      select: { apiKeyId: true, orgId: true, reason: true },
      orderBy: { createdAt: 'asc' },
      take: limit
    })
  }

  async clearKeyRevocation(apiKeyId: string): Promise<void> {
    await this.prisma.pendingDaemonKeyRevocation.deleteMany({ where: { apiKeyId } })
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
