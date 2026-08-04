/**
 * The **observed-channels strategy** (`collapseObservedChannels` /
 * `spaceForChannel` in §7.4, stage S2).
 *
 * Platforms without an authoritative membership snapshot get their console
 * channel list rebuilt from OBSERVED conversations (session history, service
 * records). Two Discord facts made that rebuild platform-conditional:
 *
 *  - Discord sessions key on a THREAD channel (the daemon opens one off every
 *    top-level mention), so the raw observed set repeats the same channel once
 *    per thread — rows must COLLAPSE onto their enclosing channel;
 *  - a bot in several servers reaches a "#general" in each, so a row is only
 *    unambiguous with the SPACE (guild) it sits in.
 *
 * Telegram and Feishu chats have neither notion; their rows pass through. That
 * is the default: no collapse, no spaces — any platform without a registered
 * strategy reports observed rows exactly as collected.
 */

/** One observed conversation row, as the snapshot pipeline carries it. */
export interface ObservedChannelRow {
  id: string
  name?: string
  spaceId?: string
  space?: string
}

/** The store reads a strategy may perform — channel scopes (parent/space
 *  links) and resolved display names are core bookkeeping. */
export interface ObservedChannelsHost {
  channelScopes(ids: string[]): Map<string, { parentId?: string; spaceId?: string }>
  displayNames(ids: string[]): Map<string, string>
}

export interface ObservedChannelsStrategy {
  readonly platform: string
  /** Fold raw observed rows onto the channel set the console should offer. */
  collapse(host: ObservedChannelsHost, observed: { id: string; name?: string }[]): ObservedChannelRow[]
  /** The space a channel sits in — the id that keeps one bot's several
   *  same-named rows apart, plus its display name once resolved. */
  spaceFor(host: ObservedChannelsHost, channelId: string): { id: string; name?: string } | undefined
}

const STRATEGIES = new Map<string, ObservedChannelsStrategy>()

export function registerObservedChannels(strategy: ObservedChannelsStrategy): void {
  STRATEGIES.set(strategy.platform, strategy)
}

/** The platform's strategy, or undefined — rows then pass through untouched
 *  and no space is attached, every non-Discord platform's behavior. */
export function observedChannelsFor(platform: string): ObservedChannelsStrategy | undefined {
  return STRATEGIES.get(platform)
}
