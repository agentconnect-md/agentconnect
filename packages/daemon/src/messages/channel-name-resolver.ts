import type { Logger } from '../log.js'

/**
 * The channel/user read helpers both the Discord and Telegram connections expose
 * (their MCP MessageGateway backing methods). The resolver needs the channel name +
 * whether it's a 1:1 IM/DM, and the triggering user's profile to label a DM that has
 * no name of its own.
 */
export interface ChannelInfoSource {
  getChannelInfo(channel: string): Promise<{ id: string; name?: string; isIm?: boolean; isPrivate?: boolean }>
  getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }>
}

/**
 * Resolves a channel id to a human display name off the inbound-message path for the
 * platforms whose normalized messages don't already carry one (Discord channel/thread
 * ids, Telegram chat ids) and caches the result into the LocalStore `display_names`
 * table, so session read-back (`session/list` / `session/history`) can label the
 * channel without a live platform call at read time. The Slack analog is
 * SlackNameResolver — Slack instead learns names in bulk from its channel-membership
 * snapshot (daemon.refreshChannels), which Discord/Telegram have no cheap equivalent of.
 *
 * Design constraints (same as SlackNameResolver):
 *  - Fire-and-forget: never on the dispatch hot path, never throws into it.
 *  - Rate-friendly: an in-memory attempt cache means each id hits the platform API at
 *    most once per TTL (short after a failure, long after success), whatever the volume.
 *  - Names persist in SQLite, so a restart keeps stale-but-useful names while the cache
 *    warms back up (rename lag is bounded by OK_TTL_MS).
 *
 * A group/channel title is saved bare (the console prefixes "#"); an IM/DM is saved
 * "@name" so the console renders it as a DM — matching the Slack convention.
 */
const OK_TTL_MS = 6 * 60 * 60 * 1000 // re-check successful lookups (renames) every 6h
const FAIL_TTL_MS = 10 * 60 * 1000 // retry failed lookups (rate limit / outage) after 10min
const MAX_TRACKED_IDS = 5000 // attempt-cache cap (oldest-evicted)

export class ChannelNameResolver {
  /** channel id → epoch ms until which we won't re-attempt a lookup. */
  private nextAttemptAt = new Map<string, number>()

  constructor(
    private save: (id: string, name: string) => void,
    private log?: Logger,
    private now: () => number = Date.now
  ) {}

  /**
   * Kick off (cached) resolution for one channel id against its owning connection.
   * `triggeredBy` is the id of the human who opened the session — used only to label a
   * DM that has no name of its own (the person on the other side), mirroring Slack.
   */
  noteChannel(src: ChannelInfoSource, channel: string, triggeredBy?: string): void {
    void this.resolveChannel(src, channel, triggeredBy)
  }

  private claim(id: string): boolean {
    const at = this.nextAttemptAt.get(id)
    if (at !== undefined && this.now() < at) return false
    // Mark before the async call so concurrent messages dedup in-flight lookups.
    // Re-inserting moves the id to the tail so Map insertion order stays LRU-ish.
    this.nextAttemptAt.delete(id)
    this.nextAttemptAt.set(id, this.now() + OK_TTL_MS)
    // Bound the cache by evicting the oldest entries — never a full clear, which would
    // drop every TTL at once and burst-re-resolve against the platform API.
    for (const key of this.nextAttemptAt.keys()) {
      if (this.nextAttemptAt.size <= MAX_TRACKED_IDS) break
      this.nextAttemptAt.delete(key)
    }
    return true
  }

  private async resolveChannel(src: ChannelInfoSource, channel: string, triggeredBy?: string): Promise<void> {
    if (!this.claim(channel)) return
    try {
      const info = await src.getChannelInfo(channel)
      // A named channel/group is saved bare (the console prefixes "#"); a DM that carries
      // its own handle (a Telegram @username) is saved "@name" so readers can tell it apart.
      if (info.name) {
        this.save(channel, info.isIm ? `@${info.name}` : info.name)
        return
      }
      // A DM with no name of its own (a Discord DM channel) — label it by the human on the
      // other side, the session's triggering user (Slack-parity). Nameless profiles (e.g.
      // Telegram, whose bot API can't resolve arbitrary users) just cache the attempt.
      if (info.isIm && triggeredBy) {
        const p = await src.getUserProfile(triggeredBy)
        const name = p.realName || p.name
        if (name) this.save(channel, `@${name}`)
      }
    } catch (err) {
      this.nextAttemptAt.set(channel, this.now() + FAIL_TTL_MS)
      this.log?.debug(`name lookup failed for channel ${channel}: ${(err as Error).message}`)
    }
  }
}
