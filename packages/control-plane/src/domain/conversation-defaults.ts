import { manifestFor, type PlaceExternalReason } from '@agentconnect.md/protocol'
import type { ChannelSessionMode, ConversationKind, NewConversationMode, SeedTrigger } from '../persistence/ports.js'
import { autoSessionModeSupported } from './decision-trigger-features.js'

/** What a new conversation of an ungated install starts at: Off where the platform marks it external (resource-visibility.md §14.9), else On for a 1:1 DM and, for a room or group DM, Off where its bot starts new rooms Off, else Mention. */
export function openConversationTrigger(
  c: {
    kind?: ConversationKind
    externalReason?: PlaceExternalReason | null
  },
  mode?: NewConversationMode | null
): SeedTrigger {
  if (c.externalReason) return 'off'
  if (c.kind === 'im') return 'any'
  return mode === 'off' ? 'off' : 'mention'
}

/** The kinds a new conversation starts on Auto in (auto-session-mode.md §3.2): rooms and group DMs its platform keys one session for, once the bot's daemon reads Auto, unless its bot starts new rooms on Mention or Off. */
export function autoConversationKinds(
  platform: string,
  features: readonly string[] | undefined,
  mode?: NewConversationMode | null
): readonly ConversationKind[] {
  if (mode === 'mention' || mode === 'off') return []
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
