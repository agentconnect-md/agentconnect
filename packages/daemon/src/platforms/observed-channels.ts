/**
 * The **observed-channels strategy** (`collapseObservedChannels` /
 * `spaceForChannel` in §7.4, stage S2).
 *
 * Platforms without an authoritative membership snapshot get their console
 * channel list rebuilt from OBSERVED conversations (session history, service
 * records). Discord needs a platform strategy because:
 *
 *  - a bot in several servers reaches a "#general" in each, so a row is only
 *    unambiguous with the SPACE (guild) it sits in.
 *
 * Current sessions already store the enclosing channel. The collapse facet remains
 * backward-compatible with pre-coordinate-migration rows that stored the Discord
 * thread channel in `sessions.channel`.
 *
 * Telegram and Feishu chats have neither notion; their rows pass through. That
 * is the default: no collapse, no spaces — any platform without a registered
 * strategy reports observed rows exactly as collected.
 *
 * WHICH platforms get rebuilt this way is {@link observedMembershipPlatforms} —
 * a derived set, not a hand list, so the "no authoritative snapshot" fact has one
 * spelling in the daemon rather than two.
 */
import { manifestFor } from '@agentconnect.md/protocol'
import { platformIds } from './integration-config.js'

/**
 * The platforms whose reachable-conversation set core must rebuild from OBSERVED
 * traffic — this daemon's registered platforms (integration-config.ts) filtered by
 * the §5 manifest's `membershipEnumeration`. Today: Telegram, Discord, Feishu.
 *
 * BOUNDED BY THE REGISTRY, not by the manifest alone. `manifestFor` is total and its
 * fail-closed default is `observed`, so an id this build has never heard of would
 * answer "observed" — correct as a per-message capability read, wrong as an
 * ENUMERATION. Core can only rebuild a platform it has a module for, so the registry
 * supplies the universe and the manifest supplies the filter.
 *
 * Computed once: both inputs are static module tables.
 */
const OBSERVED_MEMBERSHIP_PLATFORMS: readonly string[] = Object.freeze(
  platformIds().filter((platform) => manifestFor(platform).membershipEnumeration === 'observed')
)

export function observedMembershipPlatforms(): readonly string[] {
  return OBSERVED_MEMBERSHIP_PLATFORMS
}

/** One conversation a connection reports having observed, ahead of any session row.
 *  `icon`/`color` are the row's own display glyph and tint, `key`/`url` its short platform
 *  handle and the page it opens there (a Linear team); other platforms never set them. */
export interface ObservedChat {
  id: string
  name?: string
  isPrivate: boolean
  icon?: string
  color?: string
  key?: string
  url?: string
}

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
  channelScopes(ids: string[]): Promise<Map<string, { parentId?: string; spaceId?: string }>>
  displayNames(ids: string[]): Promise<Map<string, string>>
}

export interface ObservedChannelsStrategy {
  readonly platform: string
  /** Fold raw observed rows onto the channel set the console should offer. */
  collapse(host: ObservedChannelsHost, observed: { id: string; name?: string }[]): Promise<ObservedChannelRow[]>
  /** The space a channel sits in — the id that keeps one bot's several
   *  same-named rows apart, plus its display name once resolved. */
  spaceFor(host: ObservedChannelsHost, channelId: string): Promise<{ id: string; name?: string } | undefined>
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
