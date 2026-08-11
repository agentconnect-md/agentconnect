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

/** Record a revocation intent inside the caller's transaction. Idempotent on the
 *  key id — and never re-holds a key already released, since the insert is skipped. */
async function enqueueRevocation(
  tx: PrismaLike,
  orgId: string,
  apiKeyId: string,
  reason: string,
  held = false
): Promise<void> {
  await tx.pendingDaemonKeyRevocation.createMany({ data: [{ apiKeyId, orgId, reason, held }], skipDuplicates: true })
}

/** Release every key held against this org: a higher-sequence Secret has landed,
 *  so nothing older can still be the credential the pod is about to mount. */
async function releaseHeldRevocations(tx: PrismaLike, orgId: string): Promise<void> {
  await tx.pendingDaemonKeyRevocation.updateMany({ where: { orgId, held: true }, data: { held: false } })
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
   * The claim is one conditional statement. A key a dead holder left STAGED is
   * deliberately left alone here: it may already be published, so it stays the
   * pod's working credential until the successor's own publish has definitely
   * replaced it — `commitCredential` is what retires it, atomically with that.
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
      return row ? toRecord(row) : null
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
    return withTx(this.prisma, async (tx) => {
      const displaced = (await tx.orgClusterExecution.findUnique({ where: { orgId } }))?.credentialStagedApiKeyId
      const held = await tx.orgClusterExecution.updateMany({
        where: { orgId, credentialRotationToken: token },
        data: { credentialStagedApiKeyId: apiKeyId }
      })
      if (held.count === 0) return false
      // The slot holds one key, so a key it displaces would otherwise lose its
      // only handle. Queue it HELD in the same transaction: the displaced key may
      // already sit in the Secret, and this successor has not published yet, so
      // it must be named now but stay unrevocable until a commit supersedes it.
      if (displaced && displaced !== apiKeyId) {
        await enqueueRevocation(tx, orgId, displaced, 'cluster credential rotation abandoned', true)
      }
      return true
    })
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
      const before = await tx.orgClusterExecution.findUnique({ where: { orgId } })
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
      for (const superseded of [before?.credentialApiKeyId, before?.credentialStagedApiKeyId]) {
        if (superseded && superseded !== credential.apiKeyId) {
          await enqueueRevocation(tx, orgId, superseded, reason)
        }
      }
      // This commit is the higher-sequence publish every held key was waiting on:
      // the Secret now carries `credential.apiKeyId` and the rollout is asked for
      // by the `specRevision` bump above, so the older keys become revocable.
      await releaseHeldRevocations(tx, orgId)
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
      // The envelope is being destroyed, so no Secret it owns can still matter:
      // a key held against a pod that is going away has nothing left to protect.
      await releaseHeldRevocations(tx, orgId)
      // The resource must go too, and the cluster call can fail — so record the
      // intent here, where it is atomic with the credential being dropped.
      await tx.pendingEnvelopeTeardown.createMany({
        data: [{ orgId, targetNamespace: current.targetNamespace }],
        skipDuplicates: true
      })
      return true
    })
  }

  async enqueueKeyRevocation(orgId: string, apiKeyId: string, reason: string, held = false): Promise<void> {
    await enqueueRevocation(this.prisma, orgId, apiKeyId, reason, held)
  }

  async listPendingKeyRevocations(limit: number): Promise<PendingDaemonKeyRevocation[]> {
    return this.prisma.pendingDaemonKeyRevocation.findMany({
      where: { held: false },
      select: { apiKeyId: true, orgId: true, reason: true },
      orderBy: { createdAt: 'asc' },
      take: limit
    })
  }

  async clearKeyRevocation(apiKeyId: string): Promise<void> {
    await this.prisma.pendingDaemonKeyRevocation.deleteMany({ where: { apiKeyId } })
  }

  /** `ON CONFLICT DO NOTHING`, deliberately — an upsert here would let the loser
   *  of a first-enable race rewrite the winner's freshly claimed row. */
  async createIfAbsent(orgId: OrgId, defaults: ClusterExecutionDefaults): Promise<void> {
    await this.prisma.orgClusterExecution.createMany({
      data: [
        {
          orgId,
          enabled: false,
          targetNamespace: defaults.targetNamespace,
          daemonImage: defaults.daemonImage,
          daemonTier: defaults.daemonTier,
          credentialSecretName: defaults.credentialSecretName,
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
