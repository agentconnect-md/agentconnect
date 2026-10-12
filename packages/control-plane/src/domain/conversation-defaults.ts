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

/** An ungated install's Off that nobody chose on a place still marked external (§14.9): a closed door with a sign, not an operator's silence. */
export function pendingExternalConversation(c: {
  trigger: ChannelTrigger
  triggerChosen: boolean
  externalReason?: PlaceExternalReason | null
}): boolean {
  return c.trigger === 'off' && !c.triggerChosen && !!c.externalReason
}
