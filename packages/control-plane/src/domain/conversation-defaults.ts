// A bot's conversation defaults: what a conversation nobody has configured starts as, by kind.
import {
  resolveConversationDefaults,
  type BotConversationDefaults,
  type ChannelSessionMode
} from '@agentconnect.md/protocol'
import type { BotRecord, ConversationKind, SeedTrigger } from '../persistence/ports.js'

/** The bot's defaults (`PATCH /bots/:id` `conversationDefaults`), read from the generic
 *  `platformConfig` bag; absent ⇒ the platform's, which is what every bot had before. */
export function botConversationDefaults(bot: Pick<BotRecord, 'platformConfig'>): BotConversationDefaults {
  return resolveConversationDefaults(bot.platformConfig?.conversationDefaults)
}

/** What a NEW row of this kind is seeded with. A group DM is addressed like a room, so it takes the channel default. */
export function conversationSeed(
  defaults: BotConversationDefaults,
  kind: ConversationKind | undefined
): { trigger: SeedTrigger; sessionMode: ChannelSessionMode } {
  return kind === 'im' ? defaults.dm : defaults.channel
}

/** The relay's fence for conversations no row has reached yet (`rc/bot-assign.offByDefault`). */
export function offByDefaultOf(defaults: BotConversationDefaults): { channel: boolean; dm: boolean } {
  return { channel: defaults.channel.trigger === 'off', dm: defaults.dm.trigger === 'off' }
}
