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
import type {
  GitlabConnectionRecord,
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
  }): Promise<GitlabConnectionRecord> {
    const facts = {
      userId: input.userId,
      gitlabUsername: input.gitlabUsername,
      scopes: input.scopes,
      accessExpiresAt: input.accessExpiresAt,
      state: 'connected',
      lastSyncAt: new Date()
    }
    const row = await this.prisma.gitlabConnection.upsert({
      where: { orgId_gitlabUserId: { orgId: input.orgId, gitlabUserId: input.gitlabUserId } },
      create: { orgId: input.orgId, gitlabUserId: input.gitlabUserId, ...facts },
      // Reconnect rotates the pair (caller re-seals it), so the version advances.
      update: { ...facts, tokenVersion: { increment: 1n } }
    })
    return toRecord(row)
  }

  async get(orgId: string, connectionId: string): Promise<GitlabConnectionRecord | null> {
    const row = await this.prisma.gitlabConnection.findFirst({ where: { id: connectionId, orgId } })
    return row ? toRecord(row) : null
  }

  async listForOrg(orgId: string): Promise<GitlabConnectionRecord[]> {
    const rows = await this.prisma.gitlabConnection.findMany({ orderBy: { createdAt: 'asc' }, where: { orgId } })
    return rows.map(toRecord)
  }

  async setState(orgId: string, connectionId: string, state: GitlabConnectionState): Promise<boolean> {
    const res = await this.prisma.gitlabConnection.updateMany({ where: { id: connectionId, orgId }, data: { state } })
    return res.count === 1
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

  async advanceTokenVersion(connectionId: string, expected: bigint, accessExpiresAt: Date | null): Promise<boolean> {
    const res = await this.prisma.gitlabConnection.updateMany({
      where: { id: connectionId, tokenVersion: expected },
      data: { tokenVersion: { increment: 1n }, accessExpiresAt, state: 'connected' }
    })
    return res.count === 1
  }
}

export class PgGitlabConnectionSecretStore implements GitlabConnectionSecretStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  async put(orgId: string, connectionId: string, pair: { accessToken: string; refreshToken: string }): Promise<void> {
    // Keyed by connectionId alone — check the parent's org once (HookSecret pattern).
    if ((await this.db.gitlabConnection.count({ where: { id: connectionId, orgId } })) === 0) {
      throw new Error('gitlab connection secret write outside its organization')
    }
    const scope = orgScope(OrgId(orgId))
    const sealed = {
      accessToken: await this.cipher.seal(pair.accessToken, scope),
      refreshToken: await this.cipher.seal(pair.refreshToken, scope)
    }
    await this.db.gitlabConnectionSecret.upsert({
      where: { connectionId },
      create: { connectionId, ...sealed },
      update: sealed
    })
  }

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

  async delete(orgId: string, connectionId: string): Promise<void> {
    await this.db.gitlabConnectionSecret.deleteMany({ where: { connectionId, connection: { orgId } } })
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
