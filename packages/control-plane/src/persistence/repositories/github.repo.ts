/**
 * PgGithubInstallationRepo + PgGithubInstallStateStore
 * (docs/designs/github-app-git-credentials.md §Configuration and Data Model).
 *
 * Installations are metadata-only (the App's PRIVATE KEY never touches PG —
 * it lives in env, see github/config.ts). Rows are marked `revokedAt`, never
 * deleted: agents hold provenance pointers, and mint-time resolution goes by
 * account login against LIVE rows only, which is what makes uninstall→reinstall
 * (a brand-new GitHub installation id) self-heal.
 */
import type { GithubInstallation, Prisma, PrismaClient } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type {
  GithubInstallationFacts,
  GithubInstallationRecord,
  GithubInstallationRepo,
  GithubInstallStateStore
} from '../ports.js'
import { OrgId } from '../../domain/ids.js'
import { GithubInstallationClaimConflict } from '../errors.js'

function toRecord(r: GithubInstallation): GithubInstallationRecord {
  return {
    id: r.id,
    orgId: OrgId(r.orgId),
    installationId: r.installationId,
    accountLogin: r.accountLogin,
    accountType: r.accountType,
    repositorySelection: r.repositorySelection,
    permissions: (r.permissions as Record<string, string> | null) ?? {},
    suspendedAt: r.suspendedAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt
  }
}

export class PgGithubInstallationRepo implements GithubInstallationRepo {
  constructor(private readonly prisma: PrismaLike) {}

  private transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.prisma) return (this.prisma as PrismaClient).$transaction(fn)
    return fn(this.prisma as Prisma.TransactionClient)
  }

  async upsertFromGithub(orgId: OrgId, facts: GithubInstallationFacts): Promise<GithubInstallationRecord> {
    const mutable = {
      accountLogin: facts.accountLogin,
      accountType: facts.accountType,
      repositorySelection: facts.repositorySelection,
      suspendedAt: facts.suspendedAt,
      ...(facts.permissions !== undefined ? { permissions: facts.permissions } : {}),
      revokedAt: null // seeing it on GitHub again ⇒ it is alive, whatever sync thought
    }
    return this.transaction(async (tx) => {
      const row = await tx.githubInstallation.upsert({
        where: { installationId: facts.installationId },
        create: { installationId: facts.installationId, orgId, permissions: facts.permissions ?? {}, ...mutable },
        // Deliberately exclude orgId. The post-upsert check also closes the
        // concurrent-create race: throwing rolls this transaction back.
        update: mutable
      })
      if (row.orgId !== orgId) {
        throw new GithubInstallationClaimConflict(facts.installationId, row.orgId, orgId)
      }
      return toRecord(row)
    })
  }

  async get(id: string): Promise<GithubInstallationRecord | null> {
    const row = await this.prisma.githubInstallation.findUnique({ where: { id } })
    return row ? toRecord(row) : null
  }

  async listForOrg(orgId: OrgId): Promise<GithubInstallationRecord[]> {
    const rows = await this.prisma.githubInstallation.findMany({
      where: { orgId, revokedAt: null },
      orderBy: { accountLogin: 'asc' }
    })
    return rows.map(toRecord)
  }

  async liveByOrgAndAccount(orgId: OrgId, accountLogin: string): Promise<GithubInstallationRecord | null> {
    const row = await this.prisma.githubInstallation.findFirst({
      // GitHub logins are case-insensitive; stored as reported, matched loosely.
      where: { orgId, revokedAt: null, accountLogin: { equals: accountLogin, mode: 'insensitive' } }
    })
    return row ? toRecord(row) : null
  }

  async getByInstallationId(installationId: bigint): Promise<GithubInstallationRecord | null> {
    // Revoked rows included: the doorbell needs the org claim even for a row a
    // stale sync marked revoked (the pull decides the current truth).
    const row = await this.prisma.githubInstallation.findUnique({ where: { installationId } })
    return row ? toRecord(row) : null
  }

  async markRevokedByInstallationId(installationId: bigint): Promise<void> {
    await this.prisma.githubInstallation.updateMany({
      where: { installationId, revokedAt: null },
      data: { revokedAt: new Date() }
    })
  }

  async markRevokedExcept(orgId: OrgId, liveInstallationIds: bigint[]): Promise<void> {
    await this.prisma.githubInstallation.updateMany({
      where: { orgId, revokedAt: null, installationId: { notIn: liveInstallationIds } },
      data: { revokedAt: new Date() }
    })
  }
}

export class PgGithubInstallStateStore implements GithubInstallStateStore {
  constructor(private readonly prisma: PrismaLike) {}

  async put(nonce: string, orgId: OrgId, expiresAt: Date): Promise<void> {
    await this.prisma.githubInstallState.create({ data: { nonce, orgId, expiresAt } })
  }

  async consume(nonce: string): Promise<boolean> {
    // deleteMany (not delete) so an unknown/replayed nonce is a count of 0, not a throw.
    const res = await this.prisma.githubInstallState.deleteMany({ where: { nonce } })
    return res.count === 1
  }
}
