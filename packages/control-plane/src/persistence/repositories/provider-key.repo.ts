import { ProviderKeyProvider } from '@agentconnect.md/protocol'
import type { OrgId } from '../../domain/ids.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import type { ProviderKeyMetadata, ProviderKeyStore } from '../ports.js'
import type { PrismaLike } from '../prisma.js'

const metadataSelect = { provider: true, updatedAt: true } as const

function metadata(row: { provider: string; updatedAt: Date }): ProviderKeyMetadata {
  return { provider: ProviderKeyProvider.parse(row.provider), updatedAt: row.updatedAt }
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

  async put(orgId: OrgId, provider: ProviderKeyProvider, apiKey: string): Promise<ProviderKeyMetadata> {
    // Seal before persistence; a failed replacement leaves the previous value intact.
    const value = await this.cipher.seal(apiKey, orgScope(orgId))
    const row = await this.db.providerKey.upsert({
      where: { orgId_provider: { orgId, provider } },
      create: { orgId, provider, value },
      update: { value },
      select: metadataSelect
    })
    return metadata(row)
  }

  // Internal credential delivery only: absence is null; decryption failure must never enable credit fallback.
  async get(orgId: OrgId, provider: ProviderKeyProvider): Promise<string | null> {
    const row = await this.db.providerKey.findUnique({
      where: { orgId_provider: { orgId, provider } },
      select: { value: true }
    })
    return row ? this.cipher.open(row.value, orgScope(orgId)) : null
  }

  async delete(orgId: OrgId, provider: ProviderKeyProvider): Promise<void> {
    await this.db.providerKey.deleteMany({ where: { orgId, provider } })
  }
}
