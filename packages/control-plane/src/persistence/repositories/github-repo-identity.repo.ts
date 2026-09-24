import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { GithubRepoIdentityRecord, GithubRepoIdentityStateRecord, GithubRepoIdentityStore } from '../ports.js'

export class PgGithubRepoIdentityStore implements GithubRepoIdentityStore {
  constructor(private readonly prisma: PrismaClient) {}

  findBySubject(sub: string): Promise<GithubRepoIdentityRecord | null> {
    return this.prisma.githubRepoIdentity.findFirst({ where: { user: { oidcSubject: sub } } })
  }

  async clearBySubject(sub: string): Promise<void> {
    const where = { user: { oidcSubject: sub } }
    await this.prisma.$transaction([
      this.prisma.githubRepoIdentityState.deleteMany({ where }),
      this.prisma.githubRepoIdentity.deleteMany({ where })
    ])
  }

  async createState(state: GithubRepoIdentityStateRecord, now: Date): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.githubRepoIdentityState.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.prisma.githubRepoIdentityState.upsert({ where: { userId: state.userId }, create: state, update: state })
    ])
  }

  findState(userId: string, nonce: string, now: Date): Promise<GithubRepoIdentityStateRecord | null> {
    return this.prisma.githubRepoIdentityState.findFirst({ where: { userId, nonce, expiresAt: { gt: now } } })
  }

  completeState(nonce: string, identity: GithubRepoIdentityRecord, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ nonce: string }>>(Prisma.sql`
        DELETE FROM github_repo_identity_state
        WHERE "userId" = ${identity.userId} AND nonce = ${nonce} AND "expiresAt" > ${now}
        RETURNING nonce
      `)
      if (!rows.length) return false
      await tx.githubRepoIdentity.create({ data: identity })
      return true
    })
  }
}
