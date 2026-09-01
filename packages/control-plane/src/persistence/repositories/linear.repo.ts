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
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import {
  LINEAR_IDENTITY_LOCK_MAX_HOLD_MS,
  LINEAR_IDENTITY_LOCK_MAX_WAIT_MS,
  LINEAR_IDENTITY_LOCK_WAIT_BUDGET_MS,
  lockLinearIdentity
} from '../linear-identity-lock.js'
import type {
  LinearConnectionIdentity,
  LinearInstallStateRecord,
  LinearIdentitySection,
  LinearInstallStateStore,
  LinearOrphanTokenRow,
  LinearTokenMaterial,
  LinearTokenRecord,
  LinearTokenRotation,
  LinearTokenStore
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { AgentId, BotId, OrgId } from '../../domain/ids.js'

/** The HOLDER's budget — bounds how long anyone else can be kept waiting for this identity. */
const IDENTITY_LOCK_TX = {
  timeout: LINEAR_IDENTITY_LOCK_MAX_HOLD_MS,
  maxWait: LINEAR_IDENTITY_LOCK_MAX_WAIT_MS
}
/** A WAITER's budget. `pg_advisory_xact_lock` blocks INSIDE the transaction, so the ceiling that
 *  matters is `timeout`, not `maxWait` — and it must exceed the holder's above, or a `put` queued
 *  behind a sweep expires having already spent its authorization code. */
const IDENTITY_WAIT_TX = {
  timeout: LINEAR_IDENTITY_LOCK_WAIT_BUDGET_MS,
  maxWait: LINEAR_IDENTITY_LOCK_MAX_WAIT_MS
}

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

  /**
   * §7.1's step-1 write, under the identity's advisory lock.
   *
   * The lock is what makes this write the serialization point for the whole identity: it is the
   * FIRST durable trace of an organization laying claim to one, it provably precedes that
   * organization's Bot (the create tail runs after it, by §7.1's ordering), and it is a single
   * upsert — so the critical section holds no I/O and stays open for microseconds. The orphan
   * sweeper takes the same lock to decide whether an upstream revoke is safe, and cannot therefore
   * observe a half-made claim.
   *
   * Sealing happens OUTSIDE the transaction: cipher calls may be remote (Vault Transit), and
   * holding a lock across that round trip would be the thing this is careful not to do.
   */
  async put(identity: LinearConnectionIdentity, material: LinearTokenMaterial): Promise<void> {
    const scope = orgScope(identity.orgId)
    const tokens = {
      accessToken: await this.cipher.seal(material.accessToken, scope),
      refreshToken: material.refreshToken ? await this.cipher.seal(material.refreshToken, scope) : null,
      expiresAt: material.expiresAt
    }
    await withAmbientTx(
      this.prisma,
      async (tx) => {
        await lockLinearIdentity(tx, identity.clientId, identity.organizationId)
        await tx.linearToken.upsert({
          where: PgLinearTokenStore.key(identity),
          create: {
            orgId: identity.orgId,
            clientId: identity.clientId,
            organizationId: identity.organizationId,
            ...tokens
          },
          update: tokens
        })
      },
      IDENTITY_WAIT_TX
    )
  }

  /**
   * The refresh path's compare-and-set (§7.3), under the same lock and the same waiter budget as
   * {@link PgLinearTokenStore.put} — it is one short write that may queue behind a sweep, not a
   * holder that keeps others waiting.
   *
   * `updateMany`, deliberately NOT `upsert`: an UPDATE cannot create a row, so this is safe against
   * a disconnect that completed while the rotation was in flight EVEN IF that remover never took
   * the lock. The lock still matters — it makes the "what is there instead?" read below part of the
   * same decision rather than a second, already-stale question — but the no-resurrection property
   * does not depend on it.
   *
   * Cipher work stays outside the transaction on both sides (seal before, open after), for the
   * reason {@link PgLinearTokenStore.put} spells out: the cipher may be a remote round trip.
   */
  async rotate(
    identity: LinearConnectionIdentity,
    expectedUpdatedAt: Date,
    material: LinearTokenMaterial
  ): Promise<LinearTokenRotation> {
    const scope = orgScope(identity.orgId)
    const tokens = {
      accessToken: await this.cipher.seal(material.accessToken, scope),
      refreshToken: material.refreshToken ? await this.cipher.seal(material.refreshToken, scope) : null,
      expiresAt: material.expiresAt
    }
    const found = await withAmbientTx(
      this.prisma,
      async (tx) => {
        await lockLinearIdentity(tx, identity.clientId, identity.organizationId)
        const applied = await tx.linearToken.updateMany({
          where: {
            orgId: identity.orgId,
            clientId: identity.clientId,
            organizationId: identity.organizationId,
            updatedAt: expectedUpdatedAt
          },
          data: tokens
        })
        if (applied.count > 0) return 'rotated' as const
        return tx.linearToken.findUnique({ where: PgLinearTokenStore.key(identity) })
      },
      IDENTITY_WAIT_TX
    )
    if (found === 'rotated') return { outcome: 'rotated' }
    if (!found) return { outcome: 'gone' }
    return { outcome: 'superseded', current: await this.toRecord(identity, found) }
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
   * This answers only the ORG-SCOPED question — "does this row's own organization still hold the
   * identity?" — and deliberately returns no global one. Whether an upstream revoke is safe is a
   * question about OTHER organizations, and any answer computed here can be falsified before the
   * sweeper acts on it by a connect that touches none of these rows; it belongs to
   * {@link PgLinearTokenStore.withIdentityLock}, under the lock, at the moment of acting.
   */
  async listOrphans(clientId: string, staleBefore: Date, limit: number): Promise<LinearOrphanTokenRow[]> {
    const rows = await this.prisma.$queryRaw<{ orgId: string; organizationId: string; updatedAt: Date }[]>`
      SELECT t."orgId", t."organizationId", t."updatedAt"
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
      updatedAt: r.updatedAt
    }))
  }

  /**
   * ONE uninterrupted hold of the identity's advisory lock, exposing the two operations that are
   * only sound while it is held. Both live here, rather than as separate store methods, because the
   * hold has to be uninterrupted: with the claim outside the lock a same-org retry could re-grant
   * in the gap, and the ownership query — which excludes the caller's own organization so that a
   * disconnect does not count the row it is removing — would read "unowned" and revoke the
   * authorization backing that brand-new grant.
   *
   * The transaction carries an explicit budget because `act` is the sweeper's upstream revoke, held
   * inside the lock on purpose (releasing first would only narrow the window). See
   * `linear-identity-lock.ts` for the ordering that keeps the API timeout under this ceiling and a
   * waiting `put` above it.
   */
  withIdentityLock<T>(
    identity: LinearConnectionIdentity,
    act: (section: LinearIdentitySection) => Promise<T>
  ): Promise<T> {
    return withAmbientTx(
      this.prisma,
      async (tx) => {
        await lockLinearIdentity(tx, identity.clientId, identity.organizationId)
        return act({
          claim: async (updatedAt) => {
            const removed = await tx.$queryRaw<{ accessToken: string; refreshToken: string | null; expiresAt: Date }[]>`
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
          },
          // deleteMany, not delete: an identity whose row a sweep already collected is a no-op here,
          // not a throw — the disconnect edge is best-effort by contract.
          remove: async () => {
            await tx.linearToken.deleteMany({
              where: {
                orgId: identity.orgId,
                clientId: identity.clientId,
                organizationId: identity.organizationId
              }
            })
          },
          owned: async () => {
            const answer = await tx.$queryRaw<{ owned: boolean }[]>`
              SELECT (
                EXISTS (
                  SELECT 1 FROM "bot" b
                   WHERE b."platform" = 'linear'
                     AND b."externalAppId" = ${identity.clientId}
                     AND b."externalTenantId" = ${identity.organizationId}
                )
                OR EXISTS (
                  SELECT 1 FROM "linear_token" t
                   WHERE t."clientId" = ${identity.clientId}
                     AND t."organizationId" = ${identity.organizationId}
                     AND t."orgId" <> ${identity.orgId}
                )
              ) AS "owned"
            `
            // Fail CLOSED on an answer that did not come back: "unknown" never authorizes a revoke.
            return answer[0]?.owned ?? true
          }
        })
      },
      IDENTITY_LOCK_TX
    )
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
