import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type {
  AzureDevOpsUserIdentityRecord,
  AzureDevOpsUserIdentityState,
  AzureDevOpsUserIdentityStore
} from '../ports.js'

export class PgAzureDevOpsUserIdentityStore implements AzureDevOpsUserIdentityStore {
  constructor(private readonly prisma: PrismaClient) {}

  find(userId: string, tenantId: string): Promise<AzureDevOpsUserIdentityRecord | null> {
    return this.prisma.azureDevOpsUserIdentity.findUnique({ where: { userId_tenantId: { userId, tenantId } } })
  }

  async clearBySubject(sub: string): Promise<void> {
    const where = { user: { oidcSubject: sub } }
    await this.prisma.$transaction([
      this.prisma.azureDevOpsUserIdentityState.deleteMany({ where }),
      this.prisma.azureDevOpsUserIdentity.deleteMany({ where })
    ])
  }

  async createState(state: AzureDevOpsUserIdentityState, now: Date): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.azureDevOpsUserIdentityState.deleteMany({ where: { expiresAt: { lte: now } } }),
      this.prisma.azureDevOpsUserIdentityState.upsert({ where: { userId: state.userId }, create: state, update: state })
    ])
  }

  findState(userId: string, nonce: string, now: Date): Promise<AzureDevOpsUserIdentityState | null> {
    return this.prisma.azureDevOpsUserIdentityState.findFirst({ where: { userId, nonce, expiresAt: { gt: now } } })
  }

  completeState(nonce: string, identity: AzureDevOpsUserIdentityRecord, now: Date): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ nonce: string }>>(Prisma.sql`
        DELETE FROM azure_devops_user_identity_state
        WHERE "userId" = ${identity.userId} AND nonce = ${nonce} AND "expiresAt" > ${now}
        RETURNING nonce
      `)
      if (!rows.length) return false
      await tx.azureDevOpsUserIdentity.upsert({
        where: { userId_tenantId: { userId: identity.userId, tenantId: identity.tenantId } },
        create: identity,
        update: identity
      })
      return true
    })
  }

  async refresh(previous: AzureDevOpsUserIdentityRecord, sealedToken: string): Promise<boolean> {
    const result = await this.prisma.azureDevOpsUserIdentity.updateMany({
      where: previous,
      data: { refreshToken: sealedToken }
    })
    return result.count === 1
  }
}
