import type { PrismaClient } from '../../generated/prisma/client.js'
import type { BotIdentityProjector, MsTeamsBindingMutations, OrgMemberRole, Shareable } from '../ports.js'
import { canEdit } from '../../authorization/policy.js'
import { PgBotRepo, PgIntegrationRepo } from './integration.repo.js'
import { PgAuditRepo } from './audit.repo.js'
import {
  msTeamsRecoveryChanged,
  msTeamsRecoveryRows,
  msTeamsRecoverySnapshot
} from '../../platforms/msteams/recovery.js'

export class PgMsTeamsBindingMutations implements MsTeamsBindingMutations {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly projectIdentity: BotIdentityProjector
  ) {}

  // Serialize binding writes and relay/daemon notices; OAuth, Graph checks and package publication finish first.
  runExclusive<T>(tenantId: string, mutation: () => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const key = `msteams-binding:${tenantId}`
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS locked`
        return mutation()
      },
      { timeout: 60_000 }
    )
  }

  replace(input: Parameters<MsTeamsBindingMutations['replace']>[0]): ReturnType<MsTeamsBindingMutations['replace']> {
    return this.prisma.$transaction(async (tx) => {
      const { replacement, held } = input
      const tenantId = replacement.platformConfig?.tenantId
      const appId = replacement.externalAppId
      if (typeof tenantId !== 'string' || !tenantId || !appId || !held.length) throw msTeamsRecoveryChanged()
      const members = await tx.$queryRaw<{ role: OrgMemberRole }[]>`
        SELECT role FROM membership WHERE "orgId" = ${replacement.orgId} AND "userId" = ${input.userId} FOR SHARE`
      if (!members[0] || members[0].role === 'viewer') throw msTeamsRecoveryChanged()
      const agents = await tx.$queryRaw<Shareable[]>`
        SELECT visibility, "sharedWith" FROM agent WHERE id = ${input.agentId}::uuid AND "orgId" = ${replacement.orgId} FOR SHARE`
      if (!agents[0] || !canEdit(agents[0], { userId: input.userId, role: members[0].role }))
        throw msTeamsRecoveryChanged()
      await tx.$queryRaw`SELECT id FROM bot WHERE platform = 'msteams' AND "externalTenantId" = ${tenantId} ORDER BY id FOR UPDATE`
      const bots = new PgBotRepo(tx, this.projectIdentity)
      const integrations = new PgIntegrationRepo(tx)
      const current = msTeamsRecoveryRows(await bots.listForPlatform('msteams'), appId, tenantId)
      if (
        !current.some((row) => row.orgId !== replacement.orgId) ||
        msTeamsRecoverySnapshot(current) !== msTeamsRecoverySnapshot(held)
      )
        throw msTeamsRecoveryChanged()
      const removed = (await Promise.all(current.map((row) => integrations.listForBot(row.id)))).flat()
      for (const row of current) {
        await tx.integration.deleteMany({ where: { botId: row.id, orgId: row.orgId } })
        await bots.delete(row.orgId, row.id)
        await new PgAuditRepo(tx).append({
          kind: 'integration_recovery',
          orgId: row.orgId,
          actorUserId: input.userId,
          message: 'Microsoft Teams connection released by a verified tenant administrator',
          details: { botId: row.id, action: 'released' }
        })
      }
      // The previous organization's waiting requests end with its binding, and their sealed member tokens with them.
      await tx.msTeamsAgentBotRequest.deleteMany({ where: { tenantId, orgId: { not: replacement.orgId } } })
      const bot = await bots.create(replacement)
      await new PgAuditRepo(tx).append({
        kind: 'integration_recovery',
        orgId: replacement.orgId,
        actorUserId: input.userId,
        message: 'Microsoft Teams connection recovered by a verified tenant administrator',
        details: { botId: bot.id, action: 'recovered' }
      })
      return { bot, removed }
    })
  }
}
