/**
 * GitLab.com OAuth connection persistence (gitlab-com-integration.md §8.2, §9).
 *
 * Three stores: connection metadata, the sealed token pair (SecretCipher,
 * per-org scope — BotSecret discipline), and the one-shot OAuth state whose
 * consume is an atomic delete-returning read. Refresh coordination is data
 * here, policy in the service: a short lease row claim plus a tokenVersion CAS.
 */
import type { GitlabConnection, PrismaClient } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import { GitlabMembershipGone } from '../errors.js'
import type {
  GitlabConnectionRecord,
  GitlabSealedTokenPair,
  GitlabConnectionRepo,
  GitlabConnectionSecretStore,
  GitlabConnectionState,
  GitlabOauthStateRecord,
  GitlabOauthStateStore
} from '../ports.js'
import type { SecretCipher } from '../../secrets/cipher.js'
import { orgScope } from '../../secrets/scope.js'
import { OrgId } from '../../domain/ids.js'

const CONNECTION_STATES: readonly GitlabConnectionState[] = ['connected', 'reauth_required', 'disconnected']

function toState(value: string): GitlabConnectionState {
  // Fail closed on an unknown persisted state: administration stops until repaired.
  return (CONNECTION_STATES as readonly string[]).includes(value) ? (value as GitlabConnectionState) : 'reauth_required'
}

function toRecord(r: GitlabConnection): GitlabConnectionRecord {
  return {
    id: r.id,
    orgId: r.orgId,
    userId: r.userId,
    gitlabUserId: r.gitlabUserId,
    gitlabUsername: r.gitlabUsername,
    scopes: r.scopes,
    accessExpiresAt: r.accessExpiresAt,
    state: toState(r.state),
    tokenVersion: r.tokenVersion,
    lastSyncAt: r.lastSyncAt,
    createdAt: r.createdAt
  }
}

export class PgGitlabConnectionRepo implements GitlabConnectionRepo {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertOnCallback(input: {
    orgId: string
    userId: string
    gitlabUserId: bigint
    gitlabUsername: string
    scopes: string[]
    accessExpiresAt: Date | null
    sealedPair: GitlabSealedTokenPair
  }): Promise<GitlabConnectionRecord> {
    const facts = {
      userId: input.userId,
      gitlabUsername: input.gitlabUsername,
      scopes: input.scopes,
      accessExpiresAt: input.accessExpiresAt,
      state: 'connected',
      lastSyncAt: new Date()
    }
    // Metadata and the sealed pair land in ONE transaction: no reader can see a
    // connected row whose side-table pair is absent or stale.
    return this.prisma.$transaction(async (tx) => {
      // §9.4, serialized: FOR SHARE pins the membership row for the length of
      // this transaction, so a concurrent removal either waits for this commit
      // (and its trigger then disconnects the fresh row) or wins first (and
      // this locked read finds nothing) — a deterministic winner either way.
      const membership = await tx.$queryRaw<{ userId: string }[]>`
        SELECT "userId" FROM "membership"
         WHERE "orgId" = ${input.orgId} AND "userId" = ${input.userId} FOR SHARE`
      if (membership.length === 0) throw new GitlabMembershipGone()
      const row = await tx.gitlabConnection.upsert({
        where: { orgId_gitlabUserId: { orgId: input.orgId, gitlabUserId: input.gitlabUserId } },
        create: { orgId: input.orgId, gitlabUserId: input.gitlabUserId, ...facts },
        // Reconnect rotates the pair, so the version advances and any in-flight
        // refresh CAS on the old version loses.
        update: { ...facts, tokenVersion: { increment: 1n } }
      })
      await tx.gitlabConnectionSecret.upsert({
        where: { connectionId: row.id },
        create: { connectionId: row.id, ...input.sealedPair },
        update: input.sealedPair
      })
      return toRecord(row)
    })
  }

  async get(orgId: string, connectionId: string): Promise<GitlabConnectionRecord | null> {
    const row = await this.prisma.gitlabConnection.findFirst({ where: { id: connectionId, orgId } })
    return row ? toRecord(row) : null
  }

  async listForOrg(orgId: string): Promise<GitlabConnectionRecord[]> {
    const rows = await this.prisma.gitlabConnection.findMany({ orderBy: { createdAt: 'asc' }, where: { orgId } })
    return rows.map(toRecord)
  }

  async markReauthRequired(connectionId: string, expectedVersion: bigint): Promise<boolean> {
    const res = await this.prisma.gitlabConnection.updateMany({
      where: { id: connectionId, tokenVersion: expectedVersion },
      data: { state: 'reauth_required' }
    })
    return res.count === 1
  }

  async disconnect(orgId: string, connectionId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.gitlabConnection.updateMany({
        where: { id: connectionId, orgId },
        // The version bump defeats any in-flight refresh CAS, so a raced refresh
        // cannot resurrect the pair this transaction deletes.
        data: { state: 'disconnected', tokenVersion: { increment: 1n } }
      })
      if (res.count !== 1) return false
      await tx.gitlabConnectionSecret.deleteMany({ where: { connectionId } })
      return true
    })
  }

  async claimRefreshLease(connectionId: string, owner: string, until: Date, now: Date): Promise<boolean> {
    const res = await this.prisma.gitlabConnection.updateMany({
      where: {
        id: connectionId,
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

  async releaseRefreshLease(connectionId: string, owner: string): Promise<void> {
    await this.prisma.gitlabConnection.updateMany({
      where: { id: connectionId, refreshLeaseOwner: owner },
      data: { refreshLeaseOwner: null, refreshLeaseUntil: null }
    })
  }

  async commitRefresh(
    connectionId: string,
    expectedVersion: bigint,
    accessExpiresAt: Date | null,
    sealedPair: GitlabSealedTokenPair
  ): Promise<boolean> {
    // CAS and the sealed pair commit together or not at all: success is only
    // ever published with the matching tokens already in place.
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.gitlabConnection.updateMany({
        where: { id: connectionId, tokenVersion: expectedVersion, state: 'connected' },
        data: { tokenVersion: { increment: 1n }, accessExpiresAt, state: 'connected' }
      })
      if (res.count !== 1) return false
      await tx.gitlabConnectionSecret.upsert({
        where: { connectionId },
        create: { connectionId, ...sealedPair },
        update: sealedPair
      })
      return true
    })
  }
}

export class PgGitlabConnectionSecretStore implements GitlabConnectionSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async get(orgId: string, connectionId: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    const row = await this.db.gitlabConnectionSecret.findFirst({
      where: { connectionId, connection: { orgId } }
    })
    if (!row) return null
    const scope = orgScope(OrgId(orgId))
    return {
      accessToken: await this.cipher.open(row.accessToken, scope),
      refreshToken: await this.cipher.open(row.refreshToken, scope)
    }
  }
}

export class PgGitlabOauthStateStore implements GitlabOauthStateStore {
  constructor(private readonly prisma: PrismaClient) {}

  async put(input: Omit<GitlabOauthStateRecord, 'browserHash'>): Promise<void> {
    await this.prisma.gitlabOauthState.create({
      data: {
        nonce: input.nonce,
        orgId: input.orgId,
        userId: input.userId,
        returnPath: input.returnPath,
        verifier: input.verifier,
        expiresAt: input.expiresAt
      }
    })
  }

  async bindBrowser(nonce: string, browserHash: string, now: Date): Promise<GitlabOauthStateRecord | null> {
    // Exactly-once stamp: a second begin hop (or a replayed link) finds the hash
    // set and gets nothing — the flow must be restarted, never re-bound.
    const res = await this.prisma.gitlabOauthState.updateMany({
      where: { nonce, browserHash: null, expiresAt: { gt: now } },
      data: { browserHash }
    })
    if (res.count !== 1) return null
    return this.prisma.gitlabOauthState.findUnique({ where: { nonce } })
  }

  async consume(nonce: string, now: Date): Promise<GitlabOauthStateRecord | null> {
    // Atomic single-use: the delete IS the consumption; a raced second callback
    // deletes nothing and returns null.
    try {
      const row = await this.prisma.gitlabOauthState.delete({ where: { nonce } })
      return row.expiresAt > now ? row : null
    } catch {
      return null
    }
  }
}
