// `integration/tenant`: record the tenant a daemon socket's traffic named on its bot, and name the bot's integrations after it (dingtalk-integration.md §2.2).
import type { BotRecord, BotRepo, BotSecretMaterial, BotSecretStore, IntegrationRepo } from '../persistence/ports.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import type { SocketBotTenant } from '../ws/deps.js'

export interface SocketBotTenantDeps {
  bots: Pick<BotRepo, 'setWorkspaceMetadata' | 'renameFrom'>
  secrets: Pick<BotSecretStore, 'get'>
  integrations: Pick<IntegrationRepo, 'renameForBot'>
  platforms: CpPlatformRegistry
  log: { warn(o: Record<string, unknown>, m: string): void }
}

export function createSocketBotTenant(deps: SocketBotTenantDeps): SocketBotTenant {
  return {
    async record(bot: BotRecord, reported): Promise<boolean> {
      const tenant = deps.platforms.get(bot.platform)?.socketTenant
      if (!tenant?.matches(bot, reported.botUserId)) return false
      // An app belongs to one tenant, so a different one is a report about some other app's traffic.
      if (bot.workspaceId && bot.workspaceId !== reported.tenantId) {
        deps.log.warn({ botId: bot.id }, 'integration/tenant: reported tenant differs from the recorded one')
        return false
      }
      let secrets: BotSecretMaterial | null | undefined
      const secretsOf = async () =>
        secrets === undefined ? (secrets = await deps.secrets.get(bot.orgId, bot.id)) : secrets
      // A bot still named by its placeholder reads its own name again, so a permission granted later takes effect.
      const placeholders = tenant.botName?.placeholders(bot) ?? []
      if (tenant.botName && placeholders.includes(bot.name)) {
        const material = await secretsOf()
        const name = material ? await tenant.botName.read(bot, material) : bot.name
        if (name !== bot.name) await deps.bots.renameFrom(bot.orgId, bot.id, placeholders, name)
      }
      if (bot.workspaceId && bot.workspaceName) return true
      const material = await secretsOf()
      const named = material ? await tenant.name(bot, material, reported.tenantId) : { unnamed: 'no stored credential' }
      // The id is kept without a name too, so the next report retries only the lookup.
      if ('unnamed' in named) {
        deps.log.warn({ botId: bot.id, reason: named.unnamed }, 'integration/tenant: tenant not named')
        await deps.bots.setWorkspaceMetadata(bot.orgId, bot.id, reported.tenantId, null)
        return true
      }
      await deps.bots.setWorkspaceMetadata(bot.orgId, bot.id, reported.tenantId, named.workspaceName)
      const { placeholder, name } = named.integrationName
      await deps.integrations.renameForBot(bot.orgId, bot.id, placeholder, name)
      return true
    }
  }
}
