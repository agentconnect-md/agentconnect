/**
 * Purpose-specific external-memory installation/connection persistence.
 * Metadata repos never select secret/grant values; the two side-table stores
 * are the only decrypting seams.
 */
import { Prisma } from '../../generated/prisma/client.js'
import type {
  ExternalMemoryConnection,
  ExternalMemoryGrant,
  MemoryPluginInstallation
} from '../../generated/prisma/client.js'
import { mintGrantKey } from '../../orchestrator/mcpProvider.js'
import { DaemonId, OrgId } from '../../domain/ids.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import type { PrismaLike } from '../prisma.js'
import type {
  ExternalMemoryConnectionRecord,
  ExternalMemoryConnectionRepo,
  ExternalMemoryConnectionSecretStore,
  ExternalMemoryConnectionStatus,
  ExternalMemoryGrantRecord,
  ExternalMemoryGrantRepo,
  MemoryPluginInstallationRecord,
  MemoryPluginInstallationRepo,
  MemoryPluginSecretHeader,
  MemoryPluginTransport
} from '../ports.js'

const toTransport = (value: string): MemoryPluginTransport => (value === 'stdio' ? 'stdio' : 'streamable-http')
const fromTransport = (value: MemoryPluginTransport): 'stdio' | 'streamable_http' =>
  value === 'stdio' ? 'stdio' : 'streamable_http'

function toInstallation(row: MemoryPluginInstallation): MemoryPluginInstallationRecord {
  return {
    id: row.id,
    orgId: OrgId(row.orgId),
    pluginId: row.pluginId,
    transport: toTransport(row.transport),
    endpoint: row.endpoint,
    commandRef: row.commandRef,
    pinnedProfileMajor: 1,
    expectedManifestDigest: row.expectedManifestDigest,
    secretHeaders: row.secretHeaders as unknown as MemoryPluginSecretHeader[],
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export class PgMemoryPluginInstallationRepo implements MemoryPluginInstallationRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(input: Parameters<MemoryPluginInstallationRepo['create']>[0]): Promise<MemoryPluginInstallationRecord> {
    const row = await this.db.memoryPluginInstallation.create({
      data: {
        orgId: input.orgId,
        pluginId: input.pluginId,
        transport: fromTransport(input.transport),
        endpoint: input.endpoint ?? null,
        commandRef: input.commandRef ?? null,
        pinnedProfileMajor: input.pinnedProfileMajor,
        expectedManifestDigest: input.expectedManifestDigest ?? null,
        secretHeaders: input.secretHeaders as unknown as Prisma.InputJsonValue,
        createdByUserId: input.createdByUserId ?? null
      }
    })
    return toInstallation(row)
  }

  async get(id: string): Promise<MemoryPluginInstallationRecord | null> {
    const row = await this.db.memoryPluginInstallation.findUnique({ where: { id } })
    return row ? toInstallation(row) : null
  }

  async listForOrg(orgId: OrgId): Promise<MemoryPluginInstallationRecord[]> {
    return (await this.db.memoryPluginInstallation.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })).map(
      toInstallation
    )
  }

  async delete(id: string): Promise<void> {
    await this.db.memoryPluginInstallation.delete({ where: { id } })
  }
}

function toConnection(row: ExternalMemoryConnection): ExternalMemoryConnectionRecord {
  return {
    id: row.id,
    orgId: OrgId(row.orgId),
    installationId: row.installationId,
    config: row.config as Record<string, unknown>,
    status: row.status as ExternalMemoryConnectionStatus,
    revision: row.revision,
    probedRevision: row.probedRevision,
    pluginVersion: row.pluginVersion,
    profile: row.profile,
    manifestDigest: row.manifestDigest,
    capabilities: row.capabilities as Record<string, unknown> | null,
    declaredEgressHosts: row.declaredEgressHosts,
    reasonCode: row.reasonCode,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export class PgExternalMemoryConnectionRepo implements ExternalMemoryConnectionRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(input: Parameters<ExternalMemoryConnectionRepo['create']>[0]): Promise<ExternalMemoryConnectionRecord> {
    return toConnection(
      await this.db.externalMemoryConnection.create({
        data: {
          ...(input.id ? { id: input.id } : {}),
          orgId: input.orgId,
          installationId: input.installationId,
          config: input.config as Prisma.InputJsonValue,
          createdByUserId: input.createdByUserId ?? null
        }
      })
    )
  }

  async get(id: string): Promise<ExternalMemoryConnectionRecord | null> {
    const row = await this.db.externalMemoryConnection.findUnique({ where: { id } })
    return row ? toConnection(row) : null
  }

  async listForOrg(orgId: OrgId): Promise<ExternalMemoryConnectionRecord[]> {
    return (await this.db.externalMemoryConnection.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } })).map(
      toConnection
    )
  }

  async listAll(): Promise<ExternalMemoryConnectionRecord[]> {
    return (await this.db.externalMemoryConnection.findMany({ orderBy: { createdAt: 'asc' } })).map(toConnection)
  }

  async update(
    id: string,
    patch: Parameters<ExternalMemoryConnectionRepo['update']>[1]
  ): Promise<ExternalMemoryConnectionRecord> {
    return toConnection(
      await this.db.externalMemoryConnection.update({
        where: { id },
        data: {
          ...(patch.config !== undefined ? { config: patch.config as Prisma.InputJsonValue } : {}),
          revision: { increment: 1 },
          status: 'probing',
          probedRevision: null,
          pluginVersion: null,
          profile: null,
          manifestDigest: null,
          capabilities: Prisma.DbNull,
          declaredEgressHosts: [],
          reasonCode: null
        }
      })
    )
  }

  async delete(id: string): Promise<void> {
    await this.db.externalMemoryConnection.delete({ where: { id } })
  }

  async activeForDaemon(daemonId: DaemonId): Promise<ExternalMemoryConnectionRecord[]> {
    const agents = await this.db.agent.findMany({ where: { daemonId }, select: { runtimeOverrides: true } })
    const ids = new Set<string>()
    for (const agent of agents) {
      const memory = (agent.runtimeOverrides as { memory?: { provider?: string; connectionId?: string } } | null)
        ?.memory
      if (memory?.provider === 'external' && memory.connectionId) ids.add(memory.connectionId)
    }
    if (ids.size === 0) return []
    return (await this.db.externalMemoryConnection.findMany({ where: { id: { in: [...ids] } } })).map(toConnection)
  }

  async updateProbeFact(
    id: string,
    revision: number,
    fact: Parameters<ExternalMemoryConnectionRepo['updateProbeFact']>[2]
  ): Promise<boolean> {
    const result = await this.db.externalMemoryConnection.updateMany({
      where: { id, revision },
      data: {
        status: fact.status,
        probedRevision: revision,
        ...(fact.pluginVersion !== undefined ? { pluginVersion: fact.pluginVersion } : {}),
        ...(fact.profile !== undefined ? { profile: fact.profile } : {}),
        ...(fact.manifestDigest !== undefined ? { manifestDigest: fact.manifestDigest } : {}),
        ...(fact.capabilities !== undefined
          ? { capabilities: fact.capabilities as unknown as Prisma.InputJsonValue }
          : {}),
        ...(fact.declaredEgressHosts !== undefined ? { declaredEgressHosts: fact.declaredEgressHosts } : {}),
        reasonCode: fact.reasonCode ?? null
      }
    })
    return result.count === 1
  }
}

export class PgExternalMemoryConnectionSecretStore implements ExternalMemoryConnectionSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(connectionId: string, values: Record<string, string>): Promise<void> {
    const sealed = Object.fromEntries(
      await Promise.all(
        Object.entries(values).map(async ([name, value]) => [name, await this.cipher.seal(value)] as const)
      )
    )
    await this.db.externalMemoryConnectionSecret.upsert({
      where: { connectionId },
      create: { connectionId, values: sealed as Prisma.InputJsonValue },
      update: { values: sealed as Prisma.InputJsonValue }
    })
  }

  async get(connectionId: string): Promise<Record<string, string> | null> {
    const row = await this.db.externalMemoryConnectionSecret.findUnique({ where: { connectionId } })
    if (!row) return null
    return Object.fromEntries(
      await Promise.all(
        Object.entries(row.values as Record<string, string>).map(
          async ([name, value]) => [name, await this.cipher.open(value)] as const
        )
      )
    )
  }

  async keys(connectionId: string): Promise<string[]> {
    const row = await this.db.externalMemoryConnectionSecret.findUnique({
      where: { connectionId },
      select: { values: true }
    })
    return row ? Object.keys(row.values as Record<string, string>).sort() : []
  }

  async delete(connectionId: string): Promise<void> {
    await this.db.externalMemoryConnectionSecret.deleteMany({ where: { connectionId } })
  }
}

function toGrant(row: ExternalMemoryGrant): ExternalMemoryGrantRecord {
  return {
    id: row.id,
    connectionId: row.connectionId,
    key: row.key,
    status: row.status as ExternalMemoryGrantRecord['status'],
    createdAt: row.createdAt
  }
}

export class PgExternalMemoryGrantRepo implements ExternalMemoryGrantRepo {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async mintFor(connectionId: string): Promise<ExternalMemoryGrantRecord> {
    const key = mintGrantKey()
    const row = await this.db.externalMemoryGrant.create({
      data: { connectionId, key: await this.cipher.seal(key) }
    })
    return { ...toGrant(row), key }
  }

  async activeForConnection(connectionId: string): Promise<ExternalMemoryGrantRecord[]> {
    const rows = await this.db.externalMemoryGrant.findMany({
      where: { connectionId, status: 'active' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    })
    return Promise.all(rows.map(async (row) => ({ ...toGrant(row), key: await this.cipher.open(row.key) })))
  }

  async revoke(grantId: string): Promise<void> {
    await this.db.externalMemoryGrant.updateMany({ where: { id: grantId }, data: { status: 'revoked' } })
  }
}
