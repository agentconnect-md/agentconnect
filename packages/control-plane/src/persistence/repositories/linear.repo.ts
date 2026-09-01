/**
 * The two Linear provider-owned stores (docs/designs/linear-integration.md §7.2).
 *
 * `PgLinearTokenStore` is the ONLY read/write path for a connected workspace's OAuth grant. It is
 * keyed by the CONNECTION identity `(orgId, clientId, organizationId)` — never by the Bot row id —
 * so the callback can write the grant before the create tail mints the Bot, and member churn never
 * touches it (§4.4). Both token values pass through the injected `SecretCipher` under the org scope,
 * the same discipline as `bot_secret`; neither is ever returned in a DTO or logged.
 *
 * `PgLinearInstallStateStore` holds the connect funnel's one-shot OAuth `state` nonce plus the
 * terminal outcome the console polls for, and carries no secret material, so it needs no cipher.
 */
import type { LinearInstallState, LinearToken } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  LinearConnectionIdentity,
  LinearInstallStateRecord,
  LinearInstallStateStore,
  LinearOrphanTokenRow,
  LinearTokenMaterial,
  LinearTokenRecord,
  LinearTokenStore
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { AgentId, BotId, OrgId } from '../../domain/ids.js'

export class PgLinearTokenStore implements LinearTokenStore {
  constructor(
    private readonly prisma: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  // The scope comes from the CALLER's identity, never from `r.orgId`: the fence has to be something
  // the caller asserted, not something the row claims.
  private async toRecord(identity: LinearConnectionIdentity, r: LinearToken): Promise<LinearTokenRecord> {
    const scope = orgScope(identity.orgId)
    return {
      orgId: OrgId(r.orgId),
      clientId: r.clientId,
      organizationId: r.organizationId,
      accessToken: await this.cipher.open(r.accessToken, scope),
      // A grant issued without one has nothing to rotate with; re-connecting is the only repair.
      refreshToken: r.refreshToken ? await this.cipher.open(r.refreshToken, scope) : null,
      expiresAt: r.expiresAt,
      updatedAt: r.updatedAt
    }
  }

  private static key(identity: LinearConnectionIdentity) {
    return {
      orgId_clientId_organizationId: {
        orgId: identity.orgId,
        clientId: identity.clientId,
        organizationId: identity.organizationId
      }
    }
  }

  async get(identity: LinearConnectionIdentity): Promise<LinearTokenRecord | null> {
    const row = await this.prisma.linearToken.findUnique({ where: PgLinearTokenStore.key(identity) })
    return row ? this.toRecord(identity, row) : null
  }

  async put(identity: LinearConnectionIdentity, material: LinearTokenMaterial): Promise<void> {
    const scope = orgScope(identity.orgId)
    const tokens = {
      accessToken: await this.cipher.seal(material.accessToken, scope),
      refreshToken: material.refreshToken ? await this.cipher.seal(material.refreshToken, scope) : null,
      expiresAt: material.expiresAt
    }
    await this.prisma.linearToken.upsert({
      where: PgLinearTokenStore.key(identity),
      create: {
        orgId: identity.orgId,
        clientId: identity.clientId,
        organizationId: identity.organizationId,
        ...tokens
      },
      update: tokens
    })
  }

  async delete(identity: LinearConnectionIdentity): Promise<void> {
    // deleteMany so a disconnect of an already-swept identity is a no-op, not a throw.
    await this.prisma.linearToken.deleteMany({
      where: { orgId: identity.orgId, clientId: identity.clientId, organizationId: identity.organizationId }
    })
  }

  /**
   * The sweep's candidates, as ONE statement whose LIMIT counts orphans rather than scanned rows.
   *
   * The exclusion has to be inside the query, not a filter over its result: the deployment's oldest
   * stale rows are overwhelmingly HEALTHY installs (a workspace that has not needed a token refresh
   * in over an hour), so taking the oldest N and filtering afterwards lets those N occupy every
   * pass and starves the orphans behind them forever.
   *
   * The two scopes the design separates are the two subqueries. `NOT EXISTS … AND b."orgId" = …`
   * is the ORG-SCOPED selection — a row whose own organization still holds the identity is a live
   * install and is not a candidate. `EXISTS …` without the org predicate is the GLOBAL question,
   * and because the org-scoped arm already excluded same-org owners it can only mean another
   * organization's Bot: the cross-org fence loser, whose winner an upstream revoke would kill.
   */
  async listOrphans(clientId: string, staleBefore: Date, limit: number): Promise<LinearOrphanTokenRow[]> {
    const rows = await this.prisma.$queryRaw<
      { orgId: string; organizationId: string; updatedAt: Date; claimedElsewhere: boolean }[]
    >`
      SELECT t."orgId", t."organizationId", t."updatedAt",
             EXISTS (
               SELECT 1 FROM "bot" b
                WHERE b."platform" = 'linear'
                  AND b."externalAppId" = t."clientId"
                  AND b."externalTenantId" = t."organizationId"
             ) AS "claimedElsewhere"
        FROM "linear_token" t
       WHERE t."clientId" = ${clientId}
         AND t."updatedAt" < ${staleBefore}
         AND NOT EXISTS (
               SELECT 1 FROM "bot" b
                WHERE b."platform" = 'linear'
                  AND b."externalAppId" = t."clientId"
                  AND b."externalTenantId" = t."organizationId"
                  AND b."orgId" = t."orgId"
             )
       ORDER BY t."updatedAt" ASC
       LIMIT ${limit}
    `
    return rows.map((r) => ({
      identity: { orgId: OrgId(r.orgId), clientId, organizationId: r.organizationId },
      claimedElsewhere: r.claimedElsewhere,
      updatedAt: r.updatedAt
    }))
  }

  /**
   * The sweep's claim: delete the row only while it still carries the `updatedAt` the snapshot saw,
   * and hand back what was removed. One statement, so a concurrent `put` — a retried connect
   * re-granting the same workspace — serializes on the row: either this DELETE goes first and the
   * re-grant re-creates the row (which the next sweep re-evaluates from scratch), or the re-grant
   * goes first and this matches nothing.
   *
   * That is why the upstream revoke reads its token from HERE rather than from a prior `get`: the
   * returned material is provably the row that was collected, never a fresher grant that landed
   * between the snapshot and the act.
   */
  async deleteIfUnchanged(identity: LinearConnectionIdentity, updatedAt: Date): Promise<LinearTokenMaterial | null> {
    const removed = await this.prisma.$queryRaw<
      { accessToken: string; refreshToken: string | null; expiresAt: Date }[]
    >`
      DELETE FROM "linear_token"
       WHERE "orgId" = ${identity.orgId}
         AND "clientId" = ${identity.clientId}
         AND "organizationId" = ${identity.organizationId}
         AND "updatedAt" = ${updatedAt}
      RETURNING "accessToken", "refreshToken", "expiresAt"
    `
    const row = removed[0]
    if (!row) return null
    const scope = orgScope(identity.orgId)
    return {
      accessToken: await this.cipher.open(row.accessToken, scope),
      refreshToken: row.refreshToken ? await this.cipher.open(row.refreshToken, scope) : null,
      expiresAt: row.expiresAt
    }
  }
}

function toInstallStateRecord(r: LinearInstallState): LinearInstallStateRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    defaultAgentId: r.defaultAgentId ? AgentId(r.defaultAgentId) : null,
    status: r.status,
    failureReason: r.failureReason,
    botId: r.botId,
    expectedBotId: r.expectedBotId,
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt,
    claimedAt: r.claimedAt,
    settledAt: r.settledAt
  }
}

export class PgLinearInstallStateStore implements LinearInstallStateStore {
  constructor(private readonly prisma: PrismaLike) {}

  async create(input: {
    id: string
    orgId: OrgId
    defaultAgentId?: AgentId
    expectedBotId?: BotId
    createdByUserId?: string
  }): Promise<LinearInstallStateRecord> {
    const row = await this.prisma.linearInstallState.create({
      data: {
        id: input.id,
        orgId: input.orgId,
        ...(input.defaultAgentId !== undefined ? { defaultAgentId: input.defaultAgentId } : {}),
        ...(input.expectedBotId !== undefined ? { expectedBotId: input.expectedBotId } : {}),
        ...(input.createdByUserId !== undefined ? { createdByUserId: input.createdByUserId } : {})
      }
    })
    return toInstallStateRecord(row)
  }

  /**
   * One-shot redemption as a single compare-and-set. Prisma's `update` returns the row it wrote and
   * raises P2025 when the statement matched nothing, which is exactly the loser's answer under
   * concurrency: the second statement blocks on the winner's row lock, re-evaluates against a row
   * whose `claimedAt` is no longer null, and matches nothing. A read followed by a write would
   * instead let both callers see the same live nonce and both proceed to mint a workspace.
   *
   * It CLAIMS rather than deletes so the row survives to carry the outcome the console polls for —
   * a tail refusal after §7.1's step 1 has no other channel back to the operator.
   */
  async consume(id: string): Promise<LinearInstallStateRecord | null> {
    try {
      return toInstallStateRecord(
        await this.prisma.linearInstallState.update({ where: { id, claimedAt: null }, data: { claimedAt: new Date() } })
      )
    } catch (err) {
      if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2025') return null
      throw err
    }
  }

  async settle(
    id: string,
    outcome: { status: 'completed'; botId: string } | { status: 'failed'; failureReason: string }
  ): Promise<void> {
    // `status: 'pending'` in the WHERE keeps the FIRST outcome. updateMany so a settle against a
    // reaped row is a no-op, not a throw.
    await this.prisma.linearInstallState.updateMany({
      where: { id, status: 'pending' },
      data: {
        status: outcome.status,
        settledAt: new Date(),
        ...(outcome.status === 'completed' ? { botId: outcome.botId } : { failureReason: outcome.failureReason })
      }
    })
  }

  /** STRICTLY READ-ONLY — the console's status poll. NEVER a redemption gate: reading a row and
   *  then acting on it is the race {@link PgLinearInstallStateStore.consume} exists to close. */
  async peek(id: string): Promise<LinearInstallStateRecord | null> {
    const row = await this.prisma.linearInstallState.findUnique({ where: { id } })
    return row ? toInstallStateRecord(row) : null
  }

  async reapExpired(staleBefore: Date): Promise<number> {
    const res = await this.prisma.linearInstallState.deleteMany({ where: { createdAt: { lt: staleBefore } } })
    return res.count
  }
}
