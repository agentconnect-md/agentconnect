import { Prisma, type PrismaClient } from '../../generated/prisma/client.js'
import type { BotIdentityProjector, GoogleChatBindingMutations, OrgMemberRole, Shareable } from '../ports.js'
import { canEdit } from '../../authorization/policy.js'
import { PgBotRepo, PgIntegrationRepo } from './integration.repo.js'
import { PgAuditRepo } from './audit.repo.js'
import { googleChatRecoverySnapshot, recoveryExpired } from '../../platforms/googlechat/recovery.js'

// Serialize customer/domain claims and recovery across CP replicas; nested repository writes use their own transactions.
export class PgGoogleChatBindingMutations implements GoogleChatBindingMutations {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly projectIdentity: BotIdentityProjector
  ) {}

  // Reserve the replacement in the same commit that releases old identities; failure preserves the old binding.
  replace(
    input: Parameters<GoogleChatBindingMutations['replace']>[0]
  ): ReturnType<GoogleChatBindingMutations['replace']> {
    return this.prisma.$transaction(async (tx) => {
      const { replacement, held } = input
      if (!held.length) throw recoveryExpired()
      const members = await tx.$queryRaw<
        { role: OrgMemberRole }[]
      >`SELECT role FROM membership WHERE "orgId" = ${replacement.orgId} AND "userId" = ${input.userId} FOR SHARE`
      const users = await tx.$queryRaw<
        { googleAccountId: string | null }[]
      >`SELECT "googleAccountId" FROM app_user WHERE id = ${input.userId} FOR SHARE`
      if (!members[0] || members[0].role === 'viewer' || users[0]?.googleAccountId !== input.accountId)
        throw recoveryExpired()
      const agents = await tx.$queryRaw<
        Shareable[]
      >`SELECT visibility, "sharedWith" FROM agent WHERE id = ${input.agentId}::uuid AND "orgId" = ${replacement.orgId} FOR SHARE`
      if (!agents[0] || !canEdit(agents[0], { userId: input.userId, role: members[0].role })) throw recoveryExpired()
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM bot WHERE id IN (${Prisma.join(held.map((row) => row.id))}) ORDER BY id FOR UPDATE`
      )
      const bots = new PgBotRepo(tx, this.projectIdentity)
      const integrations = new PgIntegrationRepo(tx)
      const current = await Promise.all(held.map((row) => bots.get(row.orgId, row.id)))
      if (
        current.some((row) => !row) ||
        googleChatRecoverySnapshot(current.filter((row) => row !== null)) !== googleChatRecoverySnapshot(held)
      )
        throw recoveryExpired()
      const removed = (await Promise.all(held.map((row) => integrations.listForBot(row.id)))).flat()
      for (const row of held) {
        await tx.integration.deleteMany({ where: { botId: row.id, orgId: row.orgId } })
        await bots.delete(row.orgId, row.id)
        await new PgAuditRepo(tx).append({
          kind: 'integration_recovery',
          orgId: row.orgId,
          actorUserId: input.userId,
          message: 'Google Chat connection released by a verified Workspace administrator',
          details: { botId: row.id, action: 'released' }
        })
      }
      const bot = await bots.create(replacement)
      await new PgAuditRepo(tx).append({
        kind: 'integration_recovery',
        orgId: replacement.orgId,
        actorUserId: input.userId,
        message: 'Google Chat connection recovered by a verified Workspace administrator',
        details: { botId: bot.id, action: 'recovered' }
      })
      return { bot, removed }
    })
  }

  runExclusive<T>(appId: string, mutation: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const key = `googlechat-binding:${appId}`
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS locked`
        return mutation()
      },
      { timeout: 60_000 }
    )
  }
}
