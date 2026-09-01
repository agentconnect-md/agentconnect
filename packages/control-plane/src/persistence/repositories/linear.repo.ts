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
import { AgentId, OrgId } from '../../domain/ids.js'

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
   * Two reads, not a join: the stale candidates of this deployment app, then who — if anyone — owns
   * each of their identities. The D6 composite unique is GLOBAL, so at most one Bot answers per
   * `(clientId, organizationId)` and one map decides both questions the sweeper asks: a row whose
   * owner is its own organization is a live install and never yielded, and everything else is an
   * orphan whose `claimedElsewhere` says whether an upstream revoke would kill someone's install.
   */
  async listOrphans(clientId: string, staleBefore: Date, limit: number): Promise<LinearOrphanTokenRow[]> {
    const rows = await this.prisma.linearToken.findMany({
      where: { clientId, updatedAt: { lt: staleBefore } },
      orderBy: { updatedAt: 'asc' },
      take: limit
    })
    if (rows.length === 0) return []
    const owners = await this.prisma.bot.findMany({
      where: {
        platform: 'linear',
        externalAppId: clientId,
        externalTenantId: { in: [...new Set(rows.map((r) => r.organizationId))] }
      },
      select: { orgId: true, externalTenantId: true }
    })
    const ownerOf = new Map(owners.map((b) => [b.externalTenantId!, b.orgId]))
    return rows
      .filter((r) => ownerOf.get(r.organizationId) !== r.orgId)
      .map((r) => ({
        identity: { orgId: OrgId(r.orgId), clientId: r.clientId, organizationId: r.organizationId },
        claimedElsewhere: ownerOf.has(r.organizationId)
      }))
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
    createdByUserId?: string
  }): Promise<LinearInstallStateRecord> {
    const row = await this.prisma.linearInstallState.create({
      data: {
        id: input.id,
        orgId: input.orgId,
        ...(input.defaultAgentId !== undefined ? { defaultAgentId: input.defaultAgentId } : {}),
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
