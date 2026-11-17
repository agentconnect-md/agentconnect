/** `integration/room-grant` (resource-visibility.md §14.10): the room an agent's own turn makes goes to that agent, and opens to it where its conversations start closed and the turn's own conversation is enabled. */
import { isFrame } from '@agentconnect.md/protocol'
import { AgentId, DaemonId, OrgId } from '../../domain/ids.js'
import { autoConversationKinds } from '../../domain/conversation-defaults.js'
import { isGatedAgent } from '../../orchestrator/placement.js'
import { activeForServedAgents } from './integration-channels.js'
import type { Handler } from './index.js'

export const handleIntegrationRoomGrant: Handler = async (frame, conn, deps) => {
  if (!isFrame('integration/room-grant')(frame)) return
  const p = frame.payload
  const reply = (open: boolean): void => conn.replyTo(frame, 'integration/room-grant/ok', { open })
  try {
    // The same scope a channel report is held to: an integration of an agent this daemon serves.
    const owned = await activeForServedAgents(DaemonId(conn.daemonId), deps)
    const integration = owned.find((i) => i.id === p.integrationId)
    const owner = integration ? await deps.agent.get(OrgId(integration.orgId), AgentId(integration.agentId)) : null
    const bot = integration ? await deps.bot?.get(OrgId(integration.orgId), integration.botId) : null
    if (!integration || !owner || !bot) return reply(false)
    const gated = isGatedAgent(owner)
    const relayed = bot.transport === 'http' ? deps.httpBotRooms : undefined
    // A gated install has a closed default to open; any other has only its room's owner to settle, on a bot it shares.
    if (!gated && !relayed) return reply(false)
    if (p.phase === 'abandoned') {
      await relayed?.abandoned(bot.id)
      return reply(false)
    }
    if (gated) {
      // An opened room inherits its turn's conversation and nothing wider. On a shared bot a row's trigger is replicated across siblings, so the compiled grant decides there; a bot of its own has only its own rows.
      const enabled = relayed
        ? await relayed.granted(bot.id, integration.id, p.origin)
        : (await deps.integrationChannel.listForIntegration(integration.id)).some(
            (row) => row.channelId === p.origin && row.trigger !== 'off'
          )
      if (!enabled) return reply(false)
    }
    if (p.phase === 'opening') return reply(relayed ? await relayed.opening(bot.id, integration.id) : true)
    if (!p.channel) return reply(false)
    if (relayed) return reply(await relayed.open(bot.id, integration.id, p.channel))
    const release = deps.agentMutations.tryBeginMutation(integration.agentId)
    if (!release) return reply(false) // a placement move owns this agent; its bundle carries whatever the rows say
    let open = false
    try {
      // Only a room: an id with no row yet, or one the platform reports as a code session, never an existing channel or DM.
      const rows = await deps.integrationChannel.listForIntegration(integration.id)
      if (rows.some((row) => row.channelId === p.channel && !row.isCodeSession)) return reply(false)
      const mode = owner.newConversationMode ?? null
      const features = deps.connReg.get(conn.daemonId)?.capabilities?.features
      const autoKinds = autoConversationKinds(integration.platform, features, mode, owner.coordinatorDisabled)
      // Created open, or opened where a membership report already made it at the Off default; a trigger a person chose stands.
      await deps.integrationChannel.upsertConversation(
        integration.id,
        { id: p.channel, kind: 'channel' },
        { defaultTrigger: 'mention', ...(autoKinds.length ? { autoKinds } : {}), newConversationMode: mode }
      )
      open = await deps.integrationChannel.openDefaulted(integration.id, p.channel, 'mention')
    } finally {
      release()
    }
    // The daemon's rules predate the row, and it replies only after they are on their way.
    if (open) await deps.integrationConverge?.(owner)
    reply(open)
  } catch (err) {
    deps.log.warn?.({ err, daemonId: conn.daemonId }, 'integration/room-grant: failed')
    conn.sendError(frame.id, 'INTERNAL', 'room grant failed', true)
  }
}
