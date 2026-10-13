import type { SlackConnection } from './connection.js'
import type { Logger } from '../log.js'
import { mentionedUserIds } from './mentions.js'
import { TIME_ZONE_LOOKUP_WAIT_MS, within } from '../messages/time-zone.js'

/**
 * Resolves Slack ids (channel "C…", user "U…/W…") to human display names off the
 * inbound-message path and caches the results into the LocalStore `display_names`
 * table, so session read-back (`session/list` / `session/history`) can label ids
 * without ever calling Slack at read time.
 *
 * Design constraints:
 *  - Fire-and-forget: never on the dispatch hot path, never throws into it.
 *  - Rate-friendly: an in-memory attempt cache means each id hits the Web API at
 *    most once per TTL (short TTL after a failure, long after success/no-name),
 *    regardless of message volume.
 *  - Names persist in SQLite, so a daemon restart keeps stale-but-useful names
 *    while the cache warms back up (rename lag is bounded by OK_TTL_MS).
 */
const OK_TTL_MS = 6 * 60 * 60 * 1000 // re-check successful lookups (renames) every 6h
const FAIL_TTL_MS = 10 * 60 * 1000 // retry failed lookups (rate limit / outage) after 10min
const MAX_TRACKED_IDS = 5000 // attempt-cache cap (oldest-evicted, ~a large workspace's actives)

export class SlackNameResolver {
  /** id → epoch ms until which we won't re-attempt a lookup. */
  private nextAttemptAt = new Map<string, number>()
  /** user id → the profile's time zone, null when it names none; refreshed with the name. */
  private readonly zones = new Map<string, string | null>()
  /** User lookups in flight, so a turn can wait for the one its message started. */
  private readonly userLookups = new Map<string, Promise<void>>()

  constructor(
    private save: (id: string, name: string) => void | Promise<void>,
    private log?: Logger,
    private now: () => number = Date.now,
    private saveAvatar?: (conn: SlackConnection, id: string, avatarUrl: string) => void | Promise<void>
  ) {}

  /** A cache sink may write asynchronously; a failed name cache write never fails a lookup. */
  private persist(write: void | Promise<void>): void {
    void Promise.resolve(write).catch((err: unknown) => {
      this.log?.debug(`slack: name cache write failed: ${(err as Error).message}`)
    })
  }

  /** Kick off (cached) resolution for a message's channel, human sender, and any
   *  `<@U…>` user mentions in its body — so session read-back can render mentions
   *  as `@name` (not the raw id). Mention ids use the `U…/W…` user id (resolvable
   *  via users.info even for a bot's user id), unlike a bot SENDER's `B…` id. */
  noteMessage(
    conn: SlackConnection,
    msg: { channel: string; sender: { id: string; isBot: boolean }; text?: string }
  ): void {
    void this.resolveChannel(conn, msg.channel)
    // Bot senders carry a "B…" bot id that users.info can't resolve; agents' own
    // frames are labeled by agentId upstream — only resolve human user ids.
    if (!msg.sender.isBot && /^[UW]/.test(msg.sender.id)) void this.resolveUser(conn, msg.sender.id)
    for (const id of mentionedUserIds(msg.text)) void this.resolveUser(conn, id)
  }

  private claim(id: string): boolean {
    const at = this.nextAttemptAt.get(id)
    if (at !== undefined && this.now() < at) return false
    // Mark before the async call so concurrent messages dedup in-flight lookups.
    // Re-inserting moves the id to the tail so Map insertion order stays LRU-ish.
    this.nextAttemptAt.delete(id)
    this.nextAttemptAt.set(id, this.now() + OK_TTL_MS)
    // Bound the cache by evicting the oldest entries — never a full clear, which
    // would drop every TTL at once and burst-re-resolve against the Web API.
    for (const key of this.nextAttemptAt.keys()) {
      if (this.nextAttemptAt.size <= MAX_TRACKED_IDS) break
      this.nextAttemptAt.delete(key)
      this.zones.delete(key)
    }
    return true
  }

  /** The person's profile time zone for any agent's turn, waiting at most `waitMs` for a lookup in flight. */
  async timeZoneOf(
    conn: SlackConnection,
    user: string,
    waitMs = TIME_ZONE_LOOKUP_WAIT_MS
  ): Promise<string | undefined> {
    if (!/^[UW]/.test(user)) return undefined
    if (!this.zones.has(user)) await within(this.resolveUser(conn, user), waitMs)
    return this.zones.get(user) ?? undefined
  }

  private async resolveChannel(conn: SlackConnection, channel: string): Promise<void> {
    if (!this.claim(channel)) return
    try {
      const info = await conn.getChannelInfo(channel)
      if (info.name) {
        this.persist(this.save(channel, info.name))
      } else if (info.isIm && info.user) {
        // A DM has no name of its own — label it by the human on the other side,
        // "@Name" so readers (and the console) can tell it apart from a "#channel"
        // name. Nameless profiles just cache the attempt (OK_TTL), saving nothing.
        const p = await conn.getUserProfile(info.user)
        const name = p.realName || p.name
        if (name) this.persist(this.save(channel, `@${name}`))
        if (p.avatarUrl) this.persist(this.saveAvatar?.(conn, info.user, p.avatarUrl))
      }
    } catch (err) {
      this.nextAttemptAt.set(channel, this.now() + FAIL_TTL_MS)
      this.log?.debug(`slack: name lookup failed for channel ${channel}: ${(err as Error).message}`)
    }
  }

  private resolveUser(conn: SlackConnection, user: string): Promise<void> {
    if (!this.claim(user)) return this.userLookups.get(user) ?? Promise.resolve()
    const lookup = this.lookUpUser(conn, user).finally(() => this.userLookups.delete(user))
    this.userLookups.set(user, lookup)
    return lookup
  }

  private async lookUpUser(conn: SlackConnection, user: string): Promise<void> {
    try {
      const p = await conn.getUserProfile(user)
      const name = p.realName || p.name
      if (name) this.persist(this.save(user, name))
      if (p.avatarUrl) this.persist(this.saveAvatar?.(conn, user, p.avatarUrl))
      this.zones.set(user, p.timeZone ?? null)
    } catch (err) {
      this.nextAttemptAt.set(user, this.now() + FAIL_TTL_MS)
      this.log?.debug(`slack: name lookup failed for user ${user}: ${(err as Error).message}`)
    }
  }
}
