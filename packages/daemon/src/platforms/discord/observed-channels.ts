/**
 * Discord's **observed-channels strategy** (§7.4) — the one platform whose
 * observed rows need guild metadata and legacy folding.
 *
 * Current sessions already use the enclosing channel as `channel`; the folding
 * step is retained for legacy rows written before that coordinate migration.
 * The strategy also labels each row with the guild it sits in — a bot in several
 * servers reaches a "#general" in each, and the name alone cannot keep those rows
 * apart. The pure compatibility rules live in `discord/channels.ts`.
 */
import { collapseDiscordChannels, collapseNameLookupIds } from '../../discord/channels.js'
import type { ObservedChannelsHost, ObservedChannelsStrategy } from '../observed-channels.js'

export const discordObservedChannels: ObservedChannelsStrategy = {
  platform: 'discord',

  async collapse(host: ObservedChannelsHost, observed: { id: string; name?: string }[]) {
    // Two-step: the observed (thread) ids first, then the channels they fold onto —
    // whose OWN scope carries the guild, which a thread row may never have recorded.
    const scopes = await host.channelScopes(observed.map((c) => c.id))
    const parents = [...scopes.values()].map((s) => s.parentId).filter((id): id is string => !!id)
    for (const [id, scope] of await host.channelScopes(parents)) scopes.set(id, scope)
    const names = await host.displayNames(collapseNameLookupIds(observed, scopes))
    return collapseDiscordChannels(observed, scopes, names)
  },

  async spaceFor(host: ObservedChannelsHost, channelId: string) {
    const id = (await host.channelScopes([channelId])).get(channelId)?.spaceId
    if (!id) return undefined
    const name = (await host.displayNames([id])).get(id)
    return { id, ...(name ? { name } : {}) }
  }
}
