import type { MemoryChannelDto } from '@/lib/api'
import { chatPlatformName, chatRoomSigil } from '@/lib/platform-labels'

/** A place layer's name in the layer picker: "#name · Platform", else its channel id, and its folder key only as a last resort. */
export function placeLayerLabel(entry: Pick<MemoryChannelDto, 'channelKey' | 'channel' | 'name' | 'platform'>): string {
  const platform = entry.platform ?? undefined
  // A DM's name already carries its "@"; a room's takes its platform's sigil.
  const room = entry.name ? (entry.name.startsWith('@') ? entry.name : `${chatRoomSigil(platform)}${entry.name}`) : null
  const label = room ?? entry.channel ?? null
  if (!label) return entry.channelKey
  return platform ? `${label} · ${chatPlatformName(platform, platform)}` : label
}
