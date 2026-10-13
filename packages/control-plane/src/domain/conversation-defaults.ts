import type { PlaceExternalReason } from '@agentconnect.md/protocol'
import type { ChannelTrigger, ConversationKind, SeedTrigger } from '../persistence/ports.js'

/** What a new conversation of an ungated install starts at: Off where the platform marks it external (resource-visibility.md §14.9), else On for a 1:1 DM and Mention for a room. */
export function openConversationTrigger(c: {
  kind?: ConversationKind
  externalReason?: PlaceExternalReason | null
}): SeedTrigger {
  if (c.externalReason) return 'off'
  return c.kind === 'im' ? 'any' : 'mention'
}

/** An Off nobody chose, for every agent and every place (§14.9): a closed door with a sign, not an operator's silence. */
export function pendingConversation(c: { trigger: ChannelTrigger; triggerChosen: boolean }): boolean {
  return c.trigger === 'off' && !c.triggerChosen
}
