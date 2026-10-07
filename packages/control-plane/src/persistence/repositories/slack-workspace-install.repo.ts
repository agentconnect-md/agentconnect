// Installation credentials stay deployment-scoped until an authorized user selects an organization.
import { randomUUID } from 'node:crypto'
import type { SlackWorkspaceInstall } from '../../generated/prisma/client.js'
import type { SlackWorkspaceInstallRecord, SlackWorkspaceInstallStore } from '../ports.js'
import { type PrismaLike, withAmbientTx } from '../prisma.js'
import { DEPLOYMENT_SCOPE, type SecretCipher } from '../../secrets/cipher.js'
import { BotId, IntegrationId } from '../../domain/ids.js'
import { BotWorkspaceClaimed } from '../errors.js'
import { PgBotRepo, PgBotSecretStore, PgIntegrationRepo } from './integration.repo.js'

export class PgSlackWorkspaceInstallStore implements SlackWorkspaceInstallStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly cipher: SecretCipher
  ) {}

  private async open(row: SlackWorkspaceInstall): Promise<SlackWorkspaceInstallRecord> {
    return { ...row, botToken: await this.cipher.open(row.botToken, DEPLOYMENT_SCOPE) }
  }

  async get(id: string): Promise<SlackWorkspaceInstallRecord | null> {
    const row = await this.db.slackWorkspaceInstall.findUnique({ where: { id } })
    return row ? this.open(row) : null
  }

  async list(): Promise<SlackWorkspaceInstallRecord[]> {
    return Promise.all((await this.db.slackWorkspaceInstall.findMany()).map((row) => this.open(row)))
  }

  async put(input: Parameters<SlackWorkspaceInstallStore['put']>[0]): Promise<SlackWorkspaceInstallRecord> {
    const botToken = await this.cipher.seal(input.botToken, DEPLOYMENT_SCOPE)
    const row = await withAmbientTx(this.db, async (tx) => {
      const key = `slack-workspace:${input.appId}:${input.teamId}`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
      const existing = await tx.bot.findUnique({
        where: {
          platform_externalAppId_externalTenantId: {
            platform: 'slack',
            externalAppId: input.appId,
            externalTenantId: input.teamId
          }
        }
      })
      if (existing) throw new BotWorkspaceClaimed('This Slack workspace is already connected.')
      return tx.slackWorkspaceInstall.upsert({
        where: { appId_teamId: { appId: input.appId, teamId: input.teamId } },
        create: { ...input, id: randomUUID(), botToken },
        update: { ...input, botToken, installedAt: new Date(), credentialRevision: { increment: 1 } }
      })
    })
    return this.open(row)
  }

  async claim(input: Parameters<SlackWorkspaceInstallStore['claim']>[0]): Promise<BotId | null> {
    return withAmbientTx(this.db, async (tx) => {
      const seen = await tx.slackWorkspaceInstall.findUnique({ where: { id: input.id } })
      if (!seen) return null
      const key = `slack-workspace:${seen.appId}:${seen.teamId}`
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`
      await tx.$queryRaw`SELECT id FROM slack_workspace_install WHERE id = ${input.id}::uuid FOR UPDATE`
      const row = await tx.slackWorkspaceInstall.findUnique({ where: { id: input.id } })
      if (!row || row.credentialRevision !== input.revision) return null
      const bots = new PgBotRepo(tx, () => ({ externalAppId: row.appId, externalTenantId: row.teamId }))
      if (await bots.workspaceClaimedElsewhere(input.orgId, 'slack', row.appId, row.teamId)) {
        throw new BotWorkspaceClaimed('This Slack workspace is already connected.')
      }
      const bot = await bots.create({
        id: BotId(row.id),
        orgId: input.orgId,
        platform: 'slack',
        name: row.teamName ? `AgentConnect (${row.teamName})` : 'AgentConnect',
        prebuilt: true,
        transport: 'http',
        shareable: false,
        slackAppId: row.appId,
        teamId: row.teamId,
        workspaceId: row.teamId,
        botUserId: row.botUserId,
        ...(row.teamName ? { workspaceName: row.teamName } : {}),
        grantedScopes: row.grantedScopes,
        createdByUserId: input.userId
      })
      await new PgBotSecretStore(tx, this.cipher).put(input.orgId, bot.id, {
        botToken: await this.cipher.open(row.botToken, DEPLOYMENT_SCOPE),
        appToken: null,
        signingSecret: input.signingSecret
      })
      await tx.bot.update({
        where: { id: bot.id },
        data: {
          credentialRevision: row.credentialRevision + 1,
          credentialInstalledAt: row.installedAt
        }
      })
      await new PgIntegrationRepo(tx).create({
        id: IntegrationId(randomUUID()),
        orgId: input.orgId,
        agentId: input.agentId,
        botId: bot.id,
        platform: 'slack',
        name: bot.name,
        createdByUserId: input.userId
      })
      await tx.slackWorkspaceInstall.delete({ where: { id: row.id } })
      return bot.id
    })
  }

  async revoke(id: string, fence: { revision?: number; eventAtMs?: number }): Promise<boolean> {
    const result = await this.db.slackWorkspaceInstall.deleteMany({
      where: {
        id,
        ...(fence.revision !== undefined ? { credentialRevision: fence.revision } : {}),
        ...(fence.eventAtMs !== undefined ? { installedAt: { lt: new Date(fence.eventAtMs) } } : {})
      }
    })
    return result.count > 0
  }
}
