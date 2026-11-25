// `integration/bot-sender`: a direct integration saw another bot post in a conversation, which the console names a blocked or blockable sender by.
import { isFrame } from '@agentconnect.md/protocol'
import { DaemonId } from '../../domain/ids.js'
import { activeForServedAgents } from './integration-channels.js'
import type { Handler } from './index.js'

export const handleIntegrationBotSender: Handler = async (frame, conn, deps) => {
  if (!isFrame('integration/bot-sender')(frame)) return
  const p = frame.payload
  try {
    // Same scope as a channel report: only an integration of an agent this daemon serves.
    const owned = await activeForServedAgents(DaemonId(conn.daemonId), deps)
    const integration = owned.find((i) => i.id === p.integrationId)
    if (!integration) return
    await deps.integrationChannel.recordBotSender(integration.botId, p.channel, {
      id: p.sender.id,
      name: p.sender.name ?? null,
      avatarUrl: p.sender.avatarUrl ?? null
    })
  } catch (err) {
    // Fire-and-forget: the bot's next post reports again.
    deps.log.warn?.({ err, daemonId: conn.daemonId }, 'integration/bot-sender: not recorded')
  }
}
