/**
 * PgMcpProviderOauthRepo + PgMcpProviderOauthSecretStore + PgMcpProviderOauthStateStore
 * (docs/designs/mcp-provider-oauth.md).
 *
 * The GitlabConnection precedent, applied to an MCP provider's upstream grant. Two
 * properties carry the whole design and both are enforced here rather than above:
 *
 *  - EVERY write that publishes a token pair commits it in the SAME transaction as the
 *    `tokenVersion` it was minted against. No reader can observe a `connected` row whose
 *    side-table pair is missing, older, or from a superseded client identity.
 *  - EVERY write that changes user intent — prepare, connect, disconnect — ADVANCES the
 *    version, so a refresh already in flight loses its CAS instead of resurrecting a grant
 *    the operator just replaced or revoked.
 *
 * The repo owns those transactions; the secret store is read-only, exactly like
 * `GitlabConnectionSecretStore`, so no read path above it can reach sealed material.
 *
 * SECURITY: client secrets, access tokens, refresh tokens and PKCE verifiers all pass
 * through `SecretCipher` here (`none` stores plaintext, an encrypting provider stores
 * ciphertext). NEVER log a value read or written by this file.
 */
import type { PrismaLike } from '../prisma.js'
import type {
  McpOauthClientSource,
  McpProviderOauthRecord,
  McpProviderOauthRepo,
  McpProviderOauthSecretStore,
  McpProviderOauthStateRecord,
  McpProviderOauthStateStore,
  McpProviderOauthStatus,
  McpSealedTokenPair,
  PrepareMcpProviderOauthInput
} from '../ports.js'
import type { McpProviderOauth, McpProviderOauthState } from '../../generated/prisma/client.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { OrgId } from '../../domain/ids.js'

function toRecord(row: McpProviderOauth): McpProviderOauthRecord {
  return {
    mcpProviderId: row.mcpProviderId,
    resource: row.resource,
    issuer: row.issuer,
    authorizationEndpoint: row.authorizationEndpoint,
    tokenEndpoint: row.tokenEndpoint,
    registrationEndpoint: row.registrationEndpoint,
    scopes: row.scopes,
    clientId: row.clientId,
    clientSource: row.clientSource as McpOauthClientSource,
    status: row.status as McpProviderOauthStatus,
    connectedByUserId: row.connectedByUserId,
    accessExpiresAt: row.accessExpiresAt,
    tokenVersion: row.tokenVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

function toStateRecord(row: McpProviderOauthState): McpProviderOauthStateRecord {
  return {
    nonce: row.nonce,
    mcpProviderId: row.mcpProviderId,
    orgId: row.orgId,
    userId: row.userId,
    browserHash: row.browserHash,
    returnPath: row.returnPath,
    verifier: row.verifier,
    expectedIssuer: row.expectedIssuer,
    expiresAt: row.expiresAt
  }
}

export class PgMcpProviderOauthRepo implements McpProviderOauthRepo {
  constructor(private readonly prisma: PrismaLike) {}

  /** Fence through the parent: a provider id from another org must read as absent (§3.6). */
  private async inOrg(orgId: OrgId, providerId: string): Promise<boolean> {
    const owner = await this.prisma.mcpProvider.findFirst({ where: { id: providerId, orgId }, select: { id: true } })
    return owner !== null
  }

  async prepare(
    orgId: OrgId,
    providerId: string,
    input: PrepareMcpProviderOauthInput
  ): Promise<McpProviderOauthRecord> {
    if (!(await this.inOrg(orgId, providerId))) throw new Error('mcp provider not found in org')
    const facts = {
      resource: input.resource,
      issuer: input.issuer,
      authorizationEndpoint: input.authorizationEndpoint,
      tokenEndpoint: input.tokenEndpoint,
      registrationEndpoint: input.registrationEndpoint ?? null,
      scopes: input.scopes,
      clientId: input.clientId,
      clientSource: input.clientSource
    }
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.mcpProviderOauth.upsert({
        where: { mcpProviderId: providerId },
        create: { mcpProviderId: providerId, ...facts, status: 'pending' },
        // Re-running the funnel replaces the client identity, so any pair minted against
        // the old one is void: status back to pending, version advanced, tokens dropped below.
        update: { ...facts, status: 'pending', accessExpiresAt: null, tokenVersion: { increment: 1n } }
      })
      await tx.mcpProviderOauthSecret.upsert({
        where: { mcpProviderId: providerId },
        create: { mcpProviderId: providerId, clientSecret: input.sealedClientSecret ?? null },
        update: { clientSecret: input.sealedClientSecret ?? null, accessToken: null, refreshToken: null }
      })
      return toRecord(row)
    })
  }

  async get(orgId: OrgId, providerId: string): Promise<McpProviderOauthRecord | null> {
    const row = await this.prisma.mcpProviderOauth.findFirst({
      where: { mcpProviderId: providerId, provider: { orgId } }
    })
    return row ? toRecord(row) : null
  }

  async connect(
    orgId: OrgId,
    providerId: string,
    input: { accessExpiresAt: Date | null; connectedByUserId: string | null; sealedPair: McpSealedTokenPair }
  ): Promise<McpProviderOauthRecord> {
    if (!(await this.inOrg(orgId, providerId))) throw new Error('mcp provider not found in org')
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.mcpProviderOauth.update({
        where: { mcpProviderId: providerId },
        data: {
          status: 'connected',
          accessExpiresAt: input.accessExpiresAt,
          connectedByUserId: input.connectedByUserId,
          tokenVersion: { increment: 1n },
          refreshLeaseOwner: null,
          refreshLeaseUntil: null
        }
      })
      await tx.mcpProviderOauthSecret.update({
        where: { mcpProviderId: providerId },
        data: { accessToken: input.sealedPair.accessToken, refreshToken: input.sealedPair.refreshToken }
      })
      return toRecord(row)
    })
  }

  async claimRefreshLease(providerId: string, owner: string, until: Date, now: Date): Promise<boolean> {
    const res = await this.prisma.mcpProviderOauth.updateMany({
      where: {
        mcpProviderId: providerId,
        OR: [
          { refreshLeaseOwner: null },
          { refreshLeaseOwner: owner },
          { refreshLeaseUntil: { lt: now } } // an expired lease is claimable (crash recovery)
        ]
      },
      data: { refreshLeaseOwner: owner, refreshLeaseUntil: until }
    })
    return res.count === 1
  }

  async releaseRefreshLease(providerId: string, owner: string): Promise<void> {
    await this.prisma.mcpProviderOauth.updateMany({
      where: { mcpProviderId: providerId, refreshLeaseOwner: owner },
      data: { refreshLeaseOwner: null, refreshLeaseUntil: null }
    })
  }

  async commitRefresh(
    providerId: string,
    expectedVersion: bigint,
    accessExpiresAt: Date | null,
    sealedPair: McpSealedTokenPair
  ): Promise<boolean> {
    // The CAS and the sealed pair commit together or not at all, so success is only ever
    // published with the matching tokens already in place.
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.mcpProviderOauth.updateMany({
        where: { mcpProviderId: providerId, tokenVersion: expectedVersion, status: 'connected' },
        data: { tokenVersion: { increment: 1n }, accessExpiresAt }
      })
      if (res.count !== 1) return false
      await tx.mcpProviderOauthSecret.update({
        where: { mcpProviderId: providerId },
        data: { accessToken: sealedPair.accessToken, refreshToken: sealedPair.refreshToken }
      })
      return true
    })
  }

  async markReauthRequired(providerId: string, expectedVersion: bigint): Promise<boolean> {
    const res = await this.prisma.mcpProviderOauth.updateMany({
      where: { mcpProviderId: providerId, tokenVersion: expectedVersion },
      data: { status: 'reauth_required', refreshLeaseOwner: null, refreshLeaseUntil: null }
    })
    return res.count === 1
  }

  async disconnect(orgId: OrgId, providerId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const owner = await tx.mcpProvider.findFirst({ where: { id: providerId, orgId }, select: { id: true } })
      if (owner === null) return false
      const res = await tx.mcpProviderOauth.updateMany({
        where: { mcpProviderId: providerId },
        // The version bump defeats any in-flight refresh CAS, so a raced refresh cannot
        // resurrect the pair this transaction deletes.
        data: {
          status: 'pending',
          accessExpiresAt: null,
          connectedByUserId: null,
          tokenVersion: { increment: 1n },
          refreshLeaseOwner: null,
          refreshLeaseUntil: null
        }
      })
      if (res.count !== 1) return false
      await tx.mcpProviderOauthSecret.updateMany({
        where: { mcpProviderId: providerId },
        data: { accessToken: null, refreshToken: null }
      })
      return true
    })
  }

  async dueForRefresh(
    due: Date,
    limit: number
  ): Promise<Array<{ orgId: OrgId; mcpProviderId: string; providerName: string }>> {
    const rows = await this.prisma.mcpProviderOauth.findMany({
      where: { status: 'connected', accessExpiresAt: { not: null, lte: due } },
      orderBy: { accessExpiresAt: 'asc' },
      take: limit,
      select: { mcpProviderId: true, provider: { select: { orgId: true, name: true } } }
    })
    return rows.map((r) => ({
      orgId: OrgId(r.provider.orgId),
      mcpProviderId: r.mcpProviderId,
      providerName: r.provider.name
    }))
  }
}

export class PgMcpProviderOauthSecretStore implements McpProviderOauthSecretStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async get(
    orgId: OrgId,
    providerId: string
  ): Promise<{ clientSecret: string | null; accessToken: string | null; refreshToken: string | null } | null> {
    const row = await this.prisma.mcpProviderOauthSecret.findFirst({
      where: { mcpProviderId: providerId, oauth: { provider: { orgId } } }
    })
    if (!row) return null
    const scope = orgScope(orgId)
    const open = async (sealed: string | null): Promise<string | null> =>
      sealed === null ? null : this.cipher.open(sealed, scope)
    return {
      clientSecret: await open(row.clientSecret),
      accessToken: await open(row.accessToken),
      refreshToken: await open(row.refreshToken)
    }
  }
}

export class PgMcpProviderOauthStateStore implements McpProviderOauthStateStore {
  constructor(private readonly prisma: PrismaLike) {}

  async put(row: Omit<McpProviderOauthStateRecord, 'browserHash'>): Promise<void> {
    await this.prisma.mcpProviderOauthState.create({ data: { ...row } })
  }

  async bindBrowser(nonce: string, browserHash: string, now: Date): Promise<McpProviderOauthStateRecord | null> {
    // `browserHash: null` in the predicate is what makes this once-only: a replayed begin
    // link matches nothing and is indistinguishable from an unknown or expired nonce.
    const res = await this.prisma.mcpProviderOauthState.updateMany({
      where: { nonce, browserHash: null, expiresAt: { gt: now } },
      data: { browserHash }
    })
    if (res.count !== 1) return null
    const row = await this.prisma.mcpProviderOauthState.findUnique({ where: { nonce } })
    return row ? toStateRecord(row) : null
  }

  async consume(nonce: string, now: Date): Promise<McpProviderOauthStateRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.mcpProviderOauthState.findUnique({ where: { nonce } })
      if (!row) return null
      const res = await tx.mcpProviderOauthState.deleteMany({ where: { nonce } })
      if (res.count !== 1) return null // a peer consumed it first
      return row.expiresAt > now ? toStateRecord(row) : null
    })
  }

  async reapExpired(now: Date): Promise<number> {
    const res = await this.prisma.mcpProviderOauthState.deleteMany({ where: { expiresAt: { lt: now } } })
    return res.count
  }
}
