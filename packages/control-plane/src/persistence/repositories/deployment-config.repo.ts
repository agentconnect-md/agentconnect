/**
 * PostgreSQL persistence for the deployment-wide singleton configuration.
 *
 * Admin reads deliberately omit `deployment_secret.value`; the separate
 * runtime read is the only query in this repository that selects ciphertext.
 * Replacement locks one deployment-global advisory key and commits the typed
 * JSON document, monotonic revision, and secret patch in one transaction.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { withTx } from '../prisma.js'
import {
  DeploymentConfigConflictError,
  DeploymentConfigGitlabBaseUrlLockedError,
  DeploymentConfigMissingSecretsError,
  DeploymentConfigSecretRefreshRequiredError,
  DeploymentConfigService,
  deploymentSecretsRequiringRefresh,
  effectiveGitlabBaseUrl,
  parseDeploymentConfigValues,
  type DeploymentConfigPersistence,
  type DeploymentSecretKey,
  type PreparedDeploymentConfigReplace,
  type StoredDeploymentConfigAdmin,
  type StoredDeploymentConfigRuntime
} from '../deployment-config.js'

const DEPLOYMENT_CONFIG_ID = 1
const DEPLOYMENT_CONFIG_LOCK_KEY = 'agentconnect:deployment-config'

const adminSelect = {
  schemaVersion: true,
  revision: true,
  values: true,
  adminClaimedFor: true,
  updatedAt: true,
  secrets: {
    select: { key: true, fingerprint: true, updatedAt: true },
    orderBy: { key: 'asc' }
  }
} as const satisfies Prisma.DeploymentConfigSelect

const runtimeSelect = {
  schemaVersion: true,
  revision: true,
  values: true,
  updatedAt: true,
  secrets: {
    select: { key: true, value: true, fingerprint: true, updatedAt: true },
    orderBy: { key: 'asc' }
  }
} as const satisfies Prisma.DeploymentConfigSelect

type AdminRow = Prisma.DeploymentConfigGetPayload<{ select: typeof adminSelect }>
type RuntimeRow = Prisma.DeploymentConfigGetPayload<{ select: typeof runtimeSelect }>

function toAdmin(row: AdminRow): StoredDeploymentConfigAdmin {
  return {
    schemaVersion: row.schemaVersion,
    revision: row.revision,
    values: row.values,
    adminClaimedFor: row.adminClaimedFor,
    secrets: row.secrets,
    updatedAt: row.updatedAt
  }
}

function toRuntime(row: RuntimeRow): StoredDeploymentConfigRuntime {
  return {
    schemaVersion: row.schemaVersion,
    revision: row.revision,
    values: row.values,
    secrets: row.secrets.map(({ value, ...metadata }) => ({ ...metadata, sealedValue: value })),
    updatedAt: row.updatedAt
  }
}

/** Does any GitLab state still bind this deployment to its instance (§24.1)? A
 *  `disconnected` connection is credential-free history and does not; a binding
 *  (`cleanup_pending` included), an account, a hook, or a claim carrying a
 *  tombstone or an unfinished cleanup obligation does. */
async function gitlabStateExists(tx: Prisma.TransactionClient): Promise<boolean> {
  const [connections, bindings, accounts, hooks, claims] = await Promise.all([
    tx.gitlabConnection.count({ where: { NOT: { state: 'disconnected' } } }),
    tx.gitlabProjectBinding.count(),
    tx.gitlabAgentAccount.count(),
    tx.hookDef.count({ where: { kind: 'gitlab' } }),
    tx.codeHostRepositoryClaim.count({ where: { provider: 'gitlab' } })
  ])
  return connections + bindings + accounts + hooks + claims > 0
}

export class PgDeploymentConfigRepository implements DeploymentConfigPersistence {
  constructor(private readonly prisma: PrismaClient) {}

  async readAdmin(): Promise<StoredDeploymentConfigAdmin | null> {
    const row = await this.prisma.deploymentConfig.findUnique({
      where: { id: DEPLOYMENT_CONFIG_ID },
      select: adminSelect
    })
    return row ? toAdmin(row) : null
  }

  async readRuntime(): Promise<StoredDeploymentConfigRuntime | null> {
    const row = await this.prisma.deploymentConfig.findUnique({
      where: { id: DEPLOYMENT_CONFIG_ID },
      select: runtimeSelect
    })
    return row ? toRuntime(row) : null
  }

  async replace(input: PreparedDeploymentConfigReplace): Promise<StoredDeploymentConfigAdmin> {
    return withTx(this.prisma, async (tx) => {
      // A row lock cannot serialize the first write because the singleton row
      // does not exist yet. One stable advisory key covers both create and update.
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${DEPLOYMENT_CONFIG_LOCK_KEY}, 0)) IS NULL AS "locked"`
      )

      const current = await tx.deploymentConfig.findUnique({
        where: { id: DEPLOYMENT_CONFIG_ID },
        select: { revision: true, schemaVersion: true, values: true }
      })
      const actualRevision = current?.revision ?? 0
      if (actualRevision !== input.expectedRevision) {
        throw new DeploymentConfigConflictError(input.expectedRevision, actualRevision)
      }

      const previousValues = current ? parseDeploymentConfigValues(current.schemaVersion, current.values) : null
      if (previousValues) {
        // §24.1: inside the same advisory lock as the revision check, so a
        // concurrent connect cannot slip past a retarget it should have blocked.
        const previousBaseUrl = effectiveGitlabBaseUrl(previousValues)
        const nextBaseUrl = effectiveGitlabBaseUrl(input.values)
        if (previousBaseUrl !== nextBaseUrl && (await gitlabStateExists(tx))) {
          throw new DeploymentConfigGitlabBaseUrlLockedError(previousBaseUrl, nextBaseUrl)
        }
      }
      const refreshKeys = previousValues ? deploymentSecretsRequiringRefresh(previousValues, input.values) : []
      const missingRefresh = refreshKeys.filter((key) => !input.secrets[key])
      if (missingRefresh.length > 0) {
        throw new DeploymentConfigSecretRefreshRequiredError(missingRefresh)
      }

      const currentSecrets = await tx.deploymentSecret.findMany({
        where: { deploymentConfigId: DEPLOYMENT_CONFIG_ID },
        select: { key: true }
      })
      const effective = new Set(currentSecrets.map(({ key }) => key))
      for (const [key, prepared] of Object.entries(input.secrets)) {
        if (prepared === null) effective.delete(key)
        else effective.add(key)
      }
      const missing = input.requiredSecretKeys.filter((key) => !effective.has(key))
      if (missing.length > 0) throw new DeploymentConfigMissingSecretsError(missing)

      await tx.deploymentConfig.upsert({
        where: { id: DEPLOYMENT_CONFIG_ID },
        create: {
          id: DEPLOYMENT_CONFIG_ID,
          schemaVersion: input.schemaVersion,
          values: input.values as Prisma.InputJsonValue,
          revision: 1
        },
        update: {
          schemaVersion: input.schemaVersion,
          values: input.values as Prisma.InputJsonValue,
          revision: { increment: 1 }
        }
      })

      for (const [rawKey, prepared] of Object.entries(input.secrets)) {
        const key = rawKey as DeploymentSecretKey
        if (prepared === null) {
          await tx.deploymentSecret.deleteMany({ where: { deploymentConfigId: DEPLOYMENT_CONFIG_ID, key } })
          continue
        }
        await tx.deploymentSecret.upsert({
          where: { deploymentConfigId_key: { deploymentConfigId: DEPLOYMENT_CONFIG_ID, key } },
          create: {
            deploymentConfigId: DEPLOYMENT_CONFIG_ID,
            key,
            value: prepared.sealedValue,
            fingerprint: prepared.fingerprint
          },
          update: { value: prepared.sealedValue, fingerprint: prepared.fingerprint }
        })
      }

      const row = await tx.deploymentConfig.findUniqueOrThrow({
        where: { id: DEPLOYMENT_CONFIG_ID },
        select: adminSelect
      })
      return toAdmin(row)
    })
  }

  async markAdminClaimed(expectedRevision: number, claimedFor: string): Promise<void> {
    const updated = await this.prisma.deploymentConfig.updateMany({
      where: { id: DEPLOYMENT_CONFIG_ID, revision: expectedRevision },
      data: { adminClaimedFor: claimedFor }
    })
    if (updated.count === 1) return
    const current = await this.prisma.deploymentConfig.findUnique({
      where: { id: DEPLOYMENT_CONFIG_ID },
      select: { revision: true }
    })
    throw new DeploymentConfigConflictError(expectedRevision, current?.revision ?? 0)
  }
}

/** Composition convenience used by the CP container and tests. */
export class PgDeploymentConfigStore extends DeploymentConfigService {
  constructor(prisma: PrismaClient, cipher: SecretCipher) {
    super(new PgDeploymentConfigRepository(prisma), cipher)
  }
}
