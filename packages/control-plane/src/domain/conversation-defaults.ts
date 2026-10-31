import { manifestFor, type PlaceExternalReason } from '@agentconnect.md/protocol'
import type { ChannelSessionMode, ConversationKind, SeedTrigger } from '../persistence/ports.js'
import { autoSessionModeSupported } from './decision-trigger-features.js'

/** What a new conversation of an ungated install starts at: Off where the platform marks it external (resource-visibility.md §14.9), else On for a 1:1 DM and Mention for a room. */
export function openConversationTrigger(c: {
  kind?: ConversationKind
  externalReason?: PlaceExternalReason | null
}): SeedTrigger {
  if (c.externalReason) return 'off'
  return c.kind === 'im' ? 'any' : 'mention'
}

/** The kinds a new conversation starts on Auto in (auto-session-mode.md §3.2): rooms and group DMs its platform keys one session for, once the bot's daemon reads Auto. */
export function autoConversationKinds(
  platform: string,
  features: readonly string[] | undefined
): readonly ConversationKind[] {
  if (!autoSessionModeSupported(features)) return []
  return manifestFor(platform).appendKinds.filter((kind) => kind !== 'im')
}

/** A new conversation's session mode: Auto where {@link autoConversationKinds} holds its kind, else Per thread. */
export function openConversationSessionMode(
  c: { kind?: ConversationKind },
  autoKinds: readonly ConversationKind[] | undefined
): ChannelSessionMode {
  return autoKinds?.includes(c.kind ?? 'channel') ? 'auto' : 'createNew'
}
