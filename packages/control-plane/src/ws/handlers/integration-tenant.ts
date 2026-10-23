// `integration/tenant`: a daemon-held socket reports the tenant its own traffic named (a DingTalk app's organization), which names the integration.
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId, IntegrationId, type BotId } from '../../domain/ids.js'
import { PLACEMENT_ONLY } from '../../orchestrator/placementResolver.js'
import type { BotRecord } from '../../persistence/ports.js'
import { frameOrgId } from './frame-org.js'
import type { Handler } from './index.js'

export const handleIntegrationTenant: Handler = async (frame, conn, deps) => {
  if (!isFrame('integration/tenant')(frame)) return
  const tenant = deps.socketBotTenant
  const orgId = frameOrgId(frame, conn)
  if (!tenant || !orgId) return
  const p = frame.payload
  const reporter = DaemonId(conn.daemonId)
  try {
    const bots = new Map<BotId, BotRecord>()
    for (const integrationId of new Set(p.integrationIds)) {
      const integration = await deps.integration.get(orgId, IntegrationId(integrationId))
      const agent = integration ? await deps.agent.get(orgId, integration.agentId) : null
      if (!integration || !agent || !(await (deps.placementResolver ?? PLACEMENT_ONLY).mayAct(agent, reporter)))
        continue
      const bot = await deps.bot?.get(orgId, integration.botId)
      if (bot?.transport === 'socket') bots.set(bot.id, bot)
    }
    for (const bot of bots.values()) {
      if (!(await tenant.record(bot, p)))
        deps.log.warn?.({ botId: bot.id, daemonId: reporter }, 'integration/tenant: refused')
    }
  } catch (err) {
    // Fire-and-forget: the daemon reports again within the hour.
    deps.log.warn?.({ err, daemonId: reporter }, 'integration/tenant: not recorded')
  }
}
