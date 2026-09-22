import { ProviderKeyProvider, type SetProviderKeyInput } from '@agentconnect.md/protocol'
import type { OrgId } from '../../domain/ids.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import type { ProviderCredentials, ProviderKeyMetadata, ProviderKeyStore } from '../ports.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'

const metadataSelect = {
  provider: true,
  endpoint: true,
  updatedAt: true,
  headers: { select: { name: true }, orderBy: { name: 'asc' } }
} as const

function metadata(row: {
  provider: string
  endpoint: string | null
  updatedAt: Date
  headers: { name: string }[]
}): ProviderKeyMetadata {
  return {
    provider: ProviderKeyProvider.parse(row.provider),
    endpoint: row.endpoint,
    headerNames: row.headers.map((header) => header.name),
    updatedAt: row.updatedAt
  }
}

export class PgProviderKeyStore implements ProviderKeyStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async list(orgId: OrgId): Promise<ProviderKeyMetadata[]> {
    const rows = await this.db.providerKey.findMany({ where: { orgId }, select: metadataSelect })
    return rows.map(metadata)
  }

  async put(
    orgId: OrgId,
    provider: ProviderKeyProvider,
    input: SetProviderKeyInput
  ): Promise<ProviderKeyMetadata | null> {
    // Seal before the transaction; omitted secrets remain stored without being decrypted.
    const scope = orgScope(orgId)
    const value = input.apiKey === undefined ? undefined : await this.cipher.seal(input.apiKey, scope)
    const headers = await Promise.all(
      Object.entries(input.headers ?? {}).map(async ([name, value]) => ({
        name,
        value: value === null ? null : await this.cipher.seal(value, scope)
      }))
    )
    return withAmbientTx(this.db, async (tx) => {
      const data = { updatedAt: new Date(), ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}) }
      const where = { orgId_provider: { orgId, provider } }
      // The parent write locks this connection until its key, endpoint, and header patch all commit.
      if (value === undefined) {
        if ((await tx.providerKey.updateMany({ where: { orgId, provider }, data })).count === 0) return null
      } else {
        await tx.providerKey.upsert({
          where,
          create: { orgId, provider, value, ...data },
          update: { value, ...data },
          select: { provider: true }
        })
      }
      for (const header of headers) {
        if (header.value === null)
          await tx.providerKeyHeader.deleteMany({ where: { orgId, provider, name: header.name } })
        else
          await tx.providerKeyHeader.upsert({
            where: { orgId_provider_name: { orgId, provider, name: header.name } },
            create: { orgId, provider, name: header.name, value: header.value },
            update: { value: header.value },
            select: { name: true }
          })
      }
      return metadata(await tx.providerKey.findUniqueOrThrow({ where, select: metadataSelect }))
    })
  }

  // Internal credential delivery only: absence is null; decryption failure must never enable credit fallback.
  async get(orgId: OrgId, provider: ProviderKeyProvider): Promise<ProviderCredentials | null> {
    // Read the complete connection in one snapshot so a concurrent save cannot mix credential generations.
    const [row] = await this.db.$queryRaw<
      Array<{ value: string; endpoint: string | null; headers: Array<{ name: string; value: string }> }>
    >`
      SELECT p."value", p."endpoint", COALESCE(
        (SELECT json_agg(json_build_object('name', h."name", 'value', h."value"))
         FROM "provider_key_header" h WHERE h."orgId" = p."orgId" AND h."provider" = p."provider"),
        '[]'::json
      ) AS headers
      FROM "provider_key" p WHERE p."orgId" = ${orgId} AND p."provider" = ${provider}
    `
    if (!row) return null
    const scope = orgScope(orgId)
    return {
      apiKey: await this.cipher.open(row.value, scope),
      endpoint: row.endpoint,
      headers: Object.fromEntries(
        await Promise.all(row.headers.map(async (header) => [header.name, await this.cipher.open(header.value, scope)]))
      )
    }
  }

  async delete(orgId: OrgId, provider: ProviderKeyProvider): Promise<void> {
    await this.db.providerKey.deleteMany({ where: { orgId, provider } })
  }
}
