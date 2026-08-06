/**
 * PgApiKeyRepo — `ApiKeyRepo` over Prisma (design §3.3a; daemon-api-key-auth.md).
 *
 * The credential store: a key is found by its unique peppered `hash` (the verification
 * site on every `auth`), minted at onboarding/rotation, and killed by `revoke`. The
 * domain record NEVER carries the hash or any secret material.
 */
import type { ApiKey } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { ApiKeyRepo, ApiKeyRecord, UserApiKeyRecord, CreateApiKeyInput, PrincipalType } from '../ports.js'
import { DaemonId, OrgId } from '../../domain/ids.js'

function toRecord(k: ApiKey): ApiKeyRecord {
  return {
    id: k.id,
    principalType: k.principalType as PrincipalType,
    orgId: k.orgId ? OrgId(k.orgId) : null, // null iff principalType='relay'
    daemonId: k.daemonId ? DaemonId(k.daemonId) : null,
    userId: k.userId,
    displayTail: k.displayTail,
    name: k.name,
    scopes: k.scopes,
    oauthGrantId: k.oauthGrantId,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    expiresAt: k.expiresAt,
    revokedAt: k.revokedAt
  }
}

export class PgApiKeyRepo implements ApiKeyRepo {
  constructor(private readonly db: PrismaLike) {}

  async create(input: CreateApiKeyInput): Promise<ApiKeyRecord> {
    const row = await this.db.apiKey.create({
      data: {
        principalType: input.principalType,
        orgId: input.orgId, // null for relay keys (org-less infra credential)
        daemonId: input.daemonId ?? null,
        userId: input.userId ?? null,
        hash: input.hash,
        displayTail: input.displayTail,
        name: input.name ?? null,
        scopes: input.scopes ?? [],
        createdByUserId: input.createdByUserId ?? null,
        oauthGrantId: input.oauthGrantId ?? null,
        expiresAt: input.expiresAt ?? null
      }
    })
    return toRecord(row)
  }

  async findByHash(hash: string): Promise<ApiKeyRecord | null> {
    const row = await this.db.apiKey.findUnique({ where: { hash } })
    return row ? toRecord(row) : null
  }

  async touchLastUsed(id: string, at: Date): Promise<void> {
    await this.db.apiKey.update({ where: { id }, data: { lastUsedAt: at } })
  }

  async revoke(id: string, reason: string, at: Date): Promise<ApiKeyRecord> {
    const row = await this.db.apiKey.update({
      where: { id },
      data: { revokedAt: at, revokedReason: reason }
    })
    return toRecord(row)
  }

  async revokeByOAuthGrant(grantId: string, reason: string, at: Date): Promise<number> {
    const res = await this.db.apiKey.updateMany({
      where: { oauthGrantId: grantId, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason }
    })
    return res.count
  }

  async listForDaemon(orgId: OrgId, daemonId: DaemonId): Promise<ApiKeyRecord[]> {
    // Org fence on the key rows themselves (org-scoped-data-layer.md §3): a
    // daemon outside `orgId` yields nothing, so the revoke route's ownership
    // proof cannot admit a cross-tenant kill.
    const rows = await this.db.apiKey.findMany({
      where: { daemonId, orgId },
      orderBy: { createdAt: 'desc' }
    })
    return rows.map(toRecord)
  }

  async listForUser(userId: string, opts: { includeRevoked?: boolean } = {}): Promise<UserApiKeyRecord[]> {
    const rows = await this.db.apiKey.findMany({
      where: { userId, principalType: 'user', ...(opts.includeRevoked ? {} : { revokedAt: null }) },
      orderBy: { createdAt: 'desc' },
      include: { org: { select: { slug: true, name: true } } }
    })
    // User keys always carry an org (only relay keys are org-less); the join is
    // typed nullable since orgId became nullable, so skip a (impossible) bare row
    // defensively rather than fabricating a label.
    return rows.flatMap((r) =>
      r.org && r.orgId ? [{ ...toRecord(r), orgId: OrgId(r.orgId), orgSlug: r.org.slug, orgName: r.org.name }] : []
    )
  }
}
