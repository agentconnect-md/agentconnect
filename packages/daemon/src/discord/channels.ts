/**
 * Collapsing observed Discord conversations into the channel set the console shows.
 *
 * A Discord session keys on the concrete channel a message arrived in — which is the
 * THREAD's own id whenever the bot answers in a thread (see discord/normalize.ts), and
 * the daemon opens a thread off every top-level @mention. Approach-A discovery
 * (daemon.refreshObservedChannels) derives the reachable set from that session history,
 * so a channel the bot has been mentioned in three times surfaced as three rows, all
 * labelled with the same enclosing channel name ("#general" ×3).
 *
 * Fold each observed id onto its enclosing channel (LocalStore `channel_scopes`, learnt
 * from the inbound message and from the channel-name lookup) and dedupe on the resulting
 * channel SNOWFLAKE. Identity is deliberately never the display name: Discord permits
 * two distinct channels of one guild to carry the same name, so a (guild, name) key
 * would silently hide one of them from the console and make its trigger unconfigurable.
 * An id whose scope isn't known yet therefore stays a row of its own until the lookup
 * resolves its parent — a transient duplicate is recoverable, a hidden channel is not.
 */

export interface ChannelScope {
  /** Enclosing channel id when this id is a thread. */
  parentId?: string
  /** Enclosing guild id — one bot commonly spans several servers. */
  spaceId?: string
}

/**
 * Pure: observed conversations (newest-first) → the deduped channel set, order
 * preserved and newest occurrence winning. `scopes` and `displayNames` are the
 * LocalStore lookups keyed by conversation id; the enclosing channel's own cached
 * name wins over the observed row's label when present.
 *
 * Each row also carries its guild's name (`space`) when known: a bot invited to
 * several servers surfaces one "#general" per server, and the channel name alone
 * makes those rows indistinguishable in the console. The guild id resolves from the
 * folded-onto channel's scope, falling back to the observed thread's own.
 */
export function collapseDiscordChannels(
  observed: { id: string; name?: string }[],
  scopes: Map<string, ChannelScope>,
  displayNames: Map<string, string>
): { id: string; name?: string; space?: string }[] {
  const out: { id: string; name?: string; space?: string }[] = []
  const seen = new Set<string>()
  for (const c of observed) {
    const id = scopes.get(c.id)?.parentId ?? c.id
    if (seen.has(id)) continue
    seen.add(id)
    // A thread row already carries its parent's name (the resolver labels a thread with
    // the enclosing channel), so the observed label is a sound fallback either way.
    const name = displayNames.get(id) ?? c.name
    const spaceId = scopes.get(id)?.spaceId ?? scopes.get(c.id)?.spaceId
    const space = spaceId ? displayNames.get(spaceId) : undefined
    out.push({ id, ...(name ? { name } : {}), ...(space ? { space } : {}) })
  }
  return out
}

/** Every id whose cached display name the collapse needs — the observed ids, the
 *  enclosing channels they fold onto, and the guilds either of those sits in. */
export function collapseNameLookupIds(observed: { id: string }[], scopes: Map<string, ChannelScope>): string[] {
  const ids: string[] = []
  for (const c of observed) {
    ids.push(c.id)
    const scope = scopes.get(c.id)
    if (scope?.parentId) ids.push(scope.parentId)
    if (scope?.spaceId) ids.push(scope.spaceId)
    const parentSpace = scope?.parentId ? scopes.get(scope.parentId)?.spaceId : undefined
    if (parentSpace) ids.push(parentSpace)
  }
  return ids
}
