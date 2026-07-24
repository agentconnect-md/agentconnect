/**
 * PgOAuthRepo — `OAuthRepo` over Prisma (agent-assistant.md §7).
 *
 * The embedded OAuth AS's protocol state: dynamically-registered clients, single-use
 * authorization codes (hash-only, consumed atomically), and refresh-token grants
 * (rotated via compare-and-swap on the current hash). Access tokens live in `api_key`
 * (principalType='oauth'), NOT here.
 */
import type { OAuthClient, OAuthCode, OAuthGrant } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  OAuthRepo,
  OAuthClientRecord,
  OAuthCodeRecord,
  OAuthGrantRecord,
  CreateOAuthClientInput,
  CreateOAuthCodeInput,
  CreateOAuthGrantInput
} from '../ports.js'

function toClient(c: OAuthClient): OAuthClientRecord {
  return {
    clientId: c.clientId,
    clientName: c.clientName,
    redirectUris: c.redirectUris,
    grantTypes: c.grantTypes,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt
  }
}

function toCode(c: OAuthCode): OAuthCodeRecord {
  return {
    codeHash: c.codeHash,
    clientId: c.clientId,
    redirectUri: c.redirectUri,
    userId: c.userId,
    orgId: c.orgId,
    scopes: c.scopes,
    codeChallenge: c.codeChallenge,
    codeChallengeMethod: c.codeChallengeMethod,
    resource: c.resource,
    expiresAt: c.expiresAt,
    consumedAt: c.consumedAt
  }
}

function toGrant(g: OAuthGrant): OAuthGrantRecord {
  return {
    id: g.id,
    userId: g.userId,
    orgId: g.orgId,
    clientId: g.clientId,
    scopes: g.scopes,
    resource: g.resource,
    rtHash: g.rtHash,
    prevRtHash: g.prevRtHash,
    rtExpiresAt: g.rtExpiresAt,
    createdAt: g.createdAt,
    lastUsedAt: g.lastUsedAt,
    revokedAt: g.revokedAt
  }
}

export class PgOAuthRepo implements OAuthRepo {
  constructor(private readonly db: PrismaLike) {}

  async createClient(input: CreateOAuthClientInput): Promise<OAuthClientRecord> {
    const row = await this.db.oAuthClient.create({
      data: {
        clientId: input.clientId,
        clientName: input.clientName ?? null,
        redirectUris: input.redirectUris,
        grantTypes: input.grantTypes,
        expiresAt: input.expiresAt
      }
    })
    return toClient(row)
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | null> {
    const row = await this.db.oAuthClient.findUnique({ where: { clientId } })
    return row ? toClient(row) : null
  }

  async createCode(input: CreateOAuthCodeInput): Promise<void> {
    await this.db.oAuthCode.create({
      data: {
        codeHash: input.codeHash,
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        userId: input.userId,
        orgId: input.orgId,
        scopes: input.scopes,
        codeChallenge: input.codeChallenge,
        codeChallengeMethod: input.codeChallengeMethod,
        resource: input.resource ?? null,
        expiresAt: input.expiresAt
      }
    })
  }

  async getCode(codeHash: string): Promise<OAuthCodeRecord | null> {
    const row = await this.db.oAuthCode.findUnique({ where: { codeHash } })
    return row ? toCode(row) : null
  }

  async consumeCode(codeHash: string, now: Date): Promise<OAuthCodeRecord | null> {
    // Single-use, atomic: only the caller whose UPDATE flips consumedAt (guarded on
    // still-null + unexpired) wins; a replay/concurrent exchange updates 0 rows.
    const res = await this.db.oAuthCode.updateMany({
      where: { codeHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now }
    })
    if (res.count !== 1) return null
    const row = await this.db.oAuthCode.findUnique({ where: { codeHash } })
    return row ? toCode(row) : null
  }

  async createGrant(input: CreateOAuthGrantInput): Promise<OAuthGrantRecord> {
    const row = await this.db.oAuthGrant.create({
      data: {
        userId: input.userId,
        orgId: input.orgId,
        clientId: input.clientId,
        scopes: input.scopes,
        resource: input.resource ?? null,
        rtHash: input.rtHash,
        rtExpiresAt: input.rtExpiresAt
      }
    })
    return toGrant(row)
  }

  async findGrantByRefreshHash(rtHash: string): Promise<OAuthGrantRecord | null> {
    const row = await this.db.oAuthGrant.findFirst({
      where: { OR: [{ rtHash }, { prevRtHash: rtHash }], revokedAt: null }
    })
    return row ? toGrant(row) : null
  }

  async rotateGrant(
    id: string,
    expectedCurrentRtHash: string | null,
    next: { rtHash: string; prevRtHash: string | null; rtExpiresAt: Date; lastUsedAt: Date }
  ): Promise<OAuthGrantRecord | null> {
    const res = await this.db.oAuthGrant.updateMany({
      where: { id, rtHash: expectedCurrentRtHash, revokedAt: null },
      data: {
        rtHash: next.rtHash,
        prevRtHash: next.prevRtHash,
        rtExpiresAt: next.rtExpiresAt,
        lastUsedAt: next.lastUsedAt
      }
    })
    if (res.count !== 1) return null
    const row = await this.db.oAuthGrant.findUnique({ where: { id } })
    return row ? toGrant(row) : null
  }

  async getGrant(id: string): Promise<OAuthGrantRecord | null> {
    const row = await this.db.oAuthGrant.findUnique({ where: { id } })
    return row ? toGrant(row) : null
  }

  async listGrantsForUser(userId: string): Promise<OAuthGrantRecord[]> {
    const rows = await this.db.oAuthGrant.findMany({
      where: { userId, revokedAt: null },
      orderBy: { createdAt: 'desc' }
    })
    return rows.map(toGrant)
  }

  async revokeGrant(id: string, at: Date): Promise<OAuthGrantRecord | null> {
    const res = await this.db.oAuthGrant.updateMany({ where: { id }, data: { revokedAt: at } })
    if (res.count !== 1) return null
    const row = await this.db.oAuthGrant.findUnique({ where: { id } })
    return row ? toGrant(row) : null
  }
}
