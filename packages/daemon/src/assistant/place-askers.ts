// Who may approve a proposal in its own place (assistant-mode.md §5.10): whoever's own message there would start a turn of the agent.
import { routeRules, type ActivationMessageFacts } from '../router/routing-table.js'
import type { RoutingRule } from '../router/routing-rule.js'

/** Where a person would write: the agent, the integration it is reached through, and the conversation. */
export interface AskerPlace {
  agentId: string
  integrationId: string
  platform: string
  channel: string
  isDm: boolean
}

/** Whether a person's message in this conversation would activate the agent through the routing ladder: a mention of its bot, a plain message, or one with its keyword; a decision's verdict never counts. */
export function personCouldActivate(rules: readonly RoutingRule[], place: AskerPlace): boolean {
  const own = rules.filter((r) => r.agentId === place.agentId && r.integrationId === place.integrationId)
  const base = { platform: place.platform, channel: place.channel, isDm: place.isDm, sender: { isBot: false } }
  const bots = [...new Set(own.map((r) => r.botUserId).filter((bot) => bot !== ''))]
  const texts = ['', ...own.flatMap((r) => (r.match.kind === 'keyword' ? [r.match.value] : []))]
  const messages: ActivationMessageFacts[] = [
    ...bots.map((bot) => ({ ...base, text: '', mentionedBots: [bot] })),
    ...texts.map((text) => ({ ...base, text, mentionedBots: [] }))
  ]
  return messages.some((msg) => {
    const routed = routeRules(msg, own, () => null)
    return routed?.agentId === place.agentId && routed.via !== 'decision'
  })
}
