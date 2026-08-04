/**
 * Discord's **observed-channels strategy** (§7.4) — the one platform whose
 * observed rows need folding.
 *
 * Sessions key on a THREAD channel (the daemon opens one off every top-level
 * mention), so the raw observed set repeats the same channel once per thread:
 * collapse each row onto its enclosing channel, dedupe on the channel
 * snowflake, and label each row with the guild it sits in — a bot in several
 * servers reaches a "#general" in each, and the name alone cannot keep those
 * rows apart. The pure folding rules live in `discord/channels.ts`; this
 * strategy binds them to the host's scope/name lookups.
 */
import { collapseDiscordChannels, collapseNameLookupIds } from '../../discord/channels.js'
import type { ObservedChannelsHost, ObservedChannelsStrategy } from '../observed-channels.js'

export const discordObservedChannels: ObservedChannelsStrategy = {
  platform: 'discord',

  collapse(host: ObservedChannelsHost, observed: { id: string; name?: string }[]) {
    // Two-step: the observed (thread) ids first, then the channels they fold onto —
    // whose OWN scope carries the guild, which a thread row may never have recorded.
    const scopes = host.channelScopes(observed.map((c) => c.id))
    const parents = [...scopes.values()].map((s) => s.parentId).filter((id): id is string => !!id)
    for (const [id, scope] of host.channelScopes(parents)) scopes.set(id, scope)
    const names = host.displayNames(collapseNameLookupIds(observed, scopes))
    return collapseDiscordChannels(observed, scopes, names)
  },

  spaceFor(host: ObservedChannelsHost, channelId: string) {
    const id = host.channelScopes([channelId]).get(channelId)?.spaceId
    if (!id) return undefined
    const name = host.displayNames([id]).get(id)
    return { id, ...(name ? { name } : {}) }
  }
}
