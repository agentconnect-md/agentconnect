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
 * from the inbound message and from the channel-name lookup) and dedupe on
 * **(space, channel name)** — the guild plus the channel name — so the same channel
 * reported under two ids collapses while same-named channels in two different guilds
 * stay separate rows. Rows with no known space (DM conversations, and channels whose
 * scope hasn't been resolved yet) dedupe on id alone, which is the only key that can't
 * merge two genuinely different conversations.
 */

export interface ChannelScope {
  /** Enclosing channel id when this id is a thread. */
  parentId?: string
  /** Guild ("server") display name. */
  spaceName?: string
}

/**
 * Pure: observed conversations (newest-first) → the deduped channel set, order
 * preserved and newest occurrence winning. `scopes` and `displayNames` are the
 * LocalStore lookups keyed by conversation id; the enclosing channel's own cached
 * name wins over the observed row's label when present.
 */
export function collapseDiscordChannels(
  observed: { id: string; name?: string }[],
  scopes: Map<string, ChannelScope>,
  displayNames: Map<string, string>
): { id: string; name?: string }[] {
  const out: { id: string; name?: string }[] = []
  const seen = new Set<string>()
  for (const c of observed) {
    const scope = scopes.get(c.id)
    const id = scope?.parentId ?? c.id
    // A thread row already carries its parent's name (the resolver labels a thread with
    // the enclosing channel), so the observed label is a sound fallback either way.
    const name = displayNames.get(id) ?? c.name
    const byId = `i:${id}`
    // Length-prefixed so a space name containing the separator cannot forge another
    // space's key.
    const key = scope?.spaceName && name ? `s:${scope.spaceName.length}:${scope.spaceName}/${name}` : byId
    if (seen.has(key) || seen.has(byId)) continue
    seen.add(key)
    seen.add(byId)
    out.push({ id, ...(name ? { name } : {}) })
  }
  return out
}

/** Every id whose cached display name the collapse needs — the observed ids plus the
 *  enclosing channels they fold onto. */
export function collapseNameLookupIds(observed: { id: string }[], scopes: Map<string, ChannelScope>): string[] {
  const ids: string[] = []
  for (const c of observed) {
    ids.push(c.id)
    const parent = scopes.get(c.id)?.parentId
    if (parent) ids.push(parent)
  }
  return ids
}
