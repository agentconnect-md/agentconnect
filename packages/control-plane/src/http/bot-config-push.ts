// Re-deliver every active integration of one bot after a bot-level change the daemon reads (a setting or a new credential).
import type { HttpDeps } from './deps.js'
import type { BotRecord } from '../persistence/ports.js'
import { integrationToSpec, isGatedAgent } from '../orchestrator/placement.js'
import { NoConnection } from '../orchestrator/outbound.js'

// An http bot's send-only specs ride `syncBot` (with its relay assignment); a socket bot's specs go to each owner's daemons.
export async function pushBotConfig(
  deps: HttpDeps,
  log: { debug(obj: unknown, msg?: string): void },
  bot: BotRecord
): Promise<void> {
  if (bot.transport === 'http') {
    await deps.httpBot.syncBot(bot.id)
    return
  }
  const [secret, integrations] = await Promise.all([
    deps.repos.botSecret.get(bot.orgId, bot.id),
    deps.repos.integration.listForBot(bot.id)
  ])
  if (!secret) return
  for (const integration of integrations) {
    const [channels, owner] = await Promise.all([
      deps.repos.integrationChannel.listForIntegration(integration.id),
      deps.repos.agent.get(bot.orgId, integration.agentId)
    ])
    if (!owner) continue
    const spec = await integrationToSpec(deps.platforms, integration, bot, secret, channels, isGatedAgent(owner))
    if (!spec) continue
    await deps.agentDelivery.integrationUpsert(owner, spec, (err, target) => {
      if (!(err instanceof NoConnection)) throw err
      log.debug({ integrationId: integration.id, daemonId: target }, 'integration/upsert skipped: daemon offline')
    })
  }
}
