// Teams' first-run welcome (teams-integration.md §4.7): core's welcome as one Adaptive Card, mentioning who added the bot outside a 1:1 chat.
import { WireMsTeamsBotAdded, type RdMsgPlatformAction } from '@agentconnect.md/protocol'
import type { BotAdded, RelayBotAdds, Welcome } from '../contract.js'
import { adaptiveCard, plainText, type AdaptiveElement } from './card.js'
import type { MsTeamsRelayIngressHost } from './relay-ingress.js'

/** The welcome card; a group or channel welcome mentions the person who added the bot, as the Teams Store asks. */
export function msTeamsWelcomeCard(welcome: Welcome, addedBy?: { id: string; name?: string }): Record<string, unknown> {
  const name = addedBy?.name?.replace(/[<>]/g, '').trim()
  const mention = addedBy && name ? `<at>${name}</at>` : undefined
  const body: AdaptiveElement[] = [
    { type: 'TextBlock', text: welcome.title, weight: 'Bolder', size: 'Medium', wrap: true },
    ...(mention ? [{ type: 'TextBlock', text: `Thanks for adding me, ${mention}.`, wrap: true }] : []),
    ...welcome.lines.flatMap((line) => plainText(line)),
    { type: 'ActionSet', actions: welcome.links.map(({ title, url }) => ({ type: 'Action.OpenUrl', title, url })) }
  ]
  const card = adaptiveCard(body)
  if (!mention || !addedBy) return card
  return {
    ...card,
    msteams: {
      ...(card.msteams as Record<string, unknown>),
      entities: [{ type: 'mention', text: mention, mentioned: { id: addedBy.id, name } }]
    }
  }
}

/** The bot's own installs, welcomed through the integration's live connection; none while it is unbound. */
export function msTeamsBotAdds(host: MsTeamsRelayIngressHost): RelayBotAdds {
  return {
    decode: (msg: RdMsgPlatformAction): BotAdded | null => {
      const parsed = WireMsTeamsBotAdded.safeParse(msg.payload)
      if (!parsed.success) return null
      const added = parsed.data
      return {
        channel: added.conversationId,
        isDm: added.scope === 'personal',
        ...(added.botName ? { botName: added.botName } : {}),
        post: async (welcome) => {
          const conn = host.connection(msg.integrationId)
          if (!conn) throw new Error('msteams: the integration has no live connection')
          const target = { serviceUrl: added.serviceUrl, conversationId: added.conversationId }
          const addedBy = added.scope === 'personal' ? undefined : added.addedBy
          await conn.postCard(target, msTeamsWelcomeCard(welcome, addedBy), welcome.title)
        }
      }
    }
  }
}
