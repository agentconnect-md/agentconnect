import type { MemoryChannelDto } from '@/lib/api'
import { chatPlatformName, chatRoomSigil } from '@/lib/platform-labels'

type PlaceLayer = Pick<MemoryChannelDto, 'channelKey' | 'channel' | 'name' | 'platform'>

/** A place layer's name alone: "#name" or "@name", else its channel id, and its folder key only as a last resort. */
export function placeLayerName(entry: PlaceLayer): string {
  // A DM's name already carries its "@"; a room's takes its platform's sigil.
  if (entry.name)
    return entry.name.startsWith('@') ? entry.name : `${chatRoomSigil(entry.platform ?? undefined)}${entry.name}`
  return entry.channel ?? entry.channelKey
}

/** A place layer's full label: "#name · Platform", else its channel id, and its folder key only as a last resort. */
export function placeLayerLabel(entry: PlaceLayer): string {
  if (!entry.name && !entry.channel) return entry.channelKey
  const name = placeLayerName(entry)
  return entry.platform ? `${name} · ${chatPlatformName(entry.platform, entry.platform)}` : name
}
