// `integration/tenant`: record the tenant a daemon socket's traffic named on its bot, and name the bot's integrations after it (dingtalk-integration.md §2.2).
import type { BotRecord, BotRepo, BotSecretStore, IntegrationRepo } from '../persistence/ports.js'
import type { CpPlatformRegistry } from '../platforms/provider.js'
import type { SocketBotTenant } from '../ws/deps.js'

export interface SocketBotTenantDeps {
  bots: Pick<BotRepo, 'setWorkspaceMetadata'>
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
      if (bot.workspaceId && bot.workspaceName) return true
      const secrets = await deps.secrets.get(bot.orgId, bot.id)
      const named = secrets ? await tenant.name(bot, secrets, reported.tenantId) : null
      // The id is kept without a name too, so the next report retries only the lookup.
      await deps.bots.setWorkspaceMetadata(bot.orgId, bot.id, reported.tenantId, named?.workspaceName ?? null)
      if (named) {
        const { placeholder, name } = named.integrationName
        await deps.integrations.renameForBot(bot.orgId, bot.id, placeholder, name)
      }
      return true
    }
  }
}
