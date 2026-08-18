import type { Logger } from '../log.js'

/**
 * The channel/user read helpers both the Discord and Telegram connections expose
 * (their MCP MessageGateway backing methods). The resolver needs the channel name +
 * whether it's a 1:1 IM/DM, and the triggering user's profile to label a DM that has
 * no name of its own.
 */
export interface ChannelInfoSource {
  getChannelInfo(channel: string): Promise<{
    id: string
    name?: string
    isIm?: boolean
    isPrivate?: boolean
    /** Enclosing channel id when `channel` is itself a thread (Discord). */
    parentId?: string
    /** Enclosing channel name when `channel` is itself a thread (Discord). */
    parentName?: string
    /** Enclosing space the conversation lives in — the Discord guild id. */
    spaceId?: string
    /** That space's display name (the Discord server name). */
    spaceName?: string
  }>
  getUserProfile(
    user: string
  ): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean; avatarUrl?: string }>
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

/** Where a conversation sits — reported alongside its name so the daemon can fold a
 *  thread onto the enclosing channel it belongs to (see discord/channels.ts), and so
 *  a reported channel can name the space (Discord guild) that encloses it. */
export interface ResolvedChannelScope {
  parentId?: string
  spaceId?: string
  /** The conversation is a 1:1 DM. Session history can't tell a DM from a group, so
   *  without this observed discovery offers a DM as a configurable channel row. */
  isIm?: boolean
}

export interface ChannelNameResolverOpts {
  /** Sink for the conversation's scope, saved next to its display name. */
  saveScope?: (id: string, scope: ResolvedChannelScope) => void | Promise<void>
  /** Public provider-hosted user avatar cache sink. */
  saveAvatar?: (source: ChannelInfoSource, id: string, avatarUrl: string) => void | Promise<void>
  log?: Logger
  now?: () => number
}

export class ChannelNameResolver {
  /** Platform id → epoch ms until which we won't re-attempt a lookup. */
  private nextAttemptAt = new Map<string, number>()
  /** Inline names use a separate TTL namespace because a channel and user may share an id. */
  private observedNameNextSaveAt = new Map<string, number>()
  private saveScope?: (id: string, scope: ResolvedChannelScope) => void | Promise<void>
  private saveAvatar?: (source: ChannelInfoSource, id: string, avatarUrl: string) => void | Promise<void>
  private log?: Logger
  private now: () => number

  constructor(
    private save: (id: string, name: string) => void | Promise<void>,
    opts: ChannelNameResolverOpts = {}
  ) {
    this.saveScope = opts.saveScope
    this.saveAvatar = opts.saveAvatar
    this.log = opts.log
    this.now = opts.now ?? Date.now
  }

  /**
   * Kick off (cached) resolution for one channel id against its owning connection.
   * `triggeredBy` is the id of the human who opened the session — used only to label a
   * DM that has no name of its own (the person on the other side), mirroring Slack.
   */
  noteChannel(src: ChannelInfoSource, channel: string, triggeredBy?: string): void {
    void this.resolveChannel(src, channel, triggeredBy)
  }

  /**
   * Kick off (cached) resolution for a whole inbound message: its channel plus the
   * human sender and everyone they mentioned — so session read-back can label the
   * triggering user by name instead of a raw platform id (Slack-parity, where
   * SlackNameResolver.noteMessage does the same over the Web API). Bot senders are
   * skipped: agent-authored frames are labelled by agentId upstream.
   */
  noteMessage(
    src: ChannelInfoSource,
    msg: { channel: string; sender: { id: string; isBot: boolean; name?: string }; mentionedUserIds?: string[] }
  ): void {
    void this.resolveChannel(src, msg.channel, msg.sender.id)
    if (!msg.sender.isBot) {
      if (msg.sender.name) {
        if (this.claim(msg.sender.id, this.observedNameNextSaveAt))
          this.persist(this.save(msg.sender.id, msg.sender.name))
      } else {
        void this.resolveUser(src, msg.sender.id)
      }
    }
    for (const id of msg.mentionedUserIds ?? []) void this.resolveUser(src, id)
  }

  /** A cache sink may write asynchronously; a failed name cache write never fails a lookup. */
  private persist(write: void | Promise<void>): void {
    void Promise.resolve(write).catch((err: unknown) => {
      this.log?.debug(`name cache write failed: ${(err as Error).message}`)
    })
  }

  private claim(id: string, attempts = this.nextAttemptAt): boolean {
    const at = attempts.get(id)
    if (at !== undefined && this.now() < at) return false
    // Mark before the async call so concurrent messages dedup in-flight lookups.
    // Re-inserting moves the id to the tail so Map insertion order stays LRU-ish.
    attempts.delete(id)
    attempts.set(id, this.now() + OK_TTL_MS)
    // Bound the cache by evicting the oldest entries — never a full clear, which would
    // drop every TTL at once and burst-re-resolve against the platform API.
    for (const key of attempts.keys()) {
      if (attempts.size <= MAX_TRACKED_IDS) break
      attempts.delete(key)
    }
    return true
  }

  private async resolveChannel(src: ChannelInfoSource, channel: string, triggeredBy?: string): Promise<void> {
    if (!this.claim(channel)) return
    try {
      const info = await src.getChannelInfo(channel)
      // Where the conversation sits: a thread folds onto its enclosing channel in
      // channel discovery. Saved before the name so a nameless lookup still contributes
      // the scope.
      if (info.parentId || info.spaceId || info.isIm !== undefined)
        this.persist(
          this.saveScope?.(channel, {
            ...(info.parentId ? { parentId: info.parentId } : {}),
            ...(info.spaceId ? { spaceId: info.spaceId } : {}),
            ...(info.isIm === undefined ? {} : { isIm: info.isIm })
          })
        )
      // The enclosing channel is a reportable conversation of its own (channel discovery
      // labels the folded row from it) — cache its name, and the space both of them sit
      // in, under THEIR ids too.
      if (info.parentId && info.parentName) this.persist(this.save(info.parentId, info.parentName))
      if (info.parentId && info.spaceId) this.persist(this.saveScope?.(info.parentId, { spaceId: info.spaceId }))
      // The space's own name lands in the same id → name cache (a guild snowflake never
      // collides with a channel or user id), so a reported channel can be labelled with
      // the server it belongs to without a second live lookup.
      if (info.spaceId && info.spaceName) this.persist(this.save(info.spaceId, info.spaceName))
      // A named channel/group is saved bare (the console prefixes "#"); a DM that carries
      // its own handle (a Telegram @username) is saved "@name" so readers can tell it apart.
      // A legacy Discord session may still ask to resolve a thread id during upgrade.
      // Label it with the enclosing channel so its historical row reads "#general".
      const name = info.parentName ?? info.name
      if (name) {
        this.persist(this.save(channel, info.isIm ? `@${name}` : name))
        return
      }
      // A DM with no name of its own (a Discord DM channel) — label it by the human on the
      // other side, the session's triggering user (Slack-parity). Nameless profiles (e.g.
      // Telegram, whose bot API can't resolve arbitrary users) just cache the attempt.
      if (info.isIm && triggeredBy) {
        const p = await src.getUserProfile(triggeredBy)
        const name = p.realName || p.name
        if (name) this.persist(this.save(channel, `@${name}`))
        if (p.avatarUrl) this.persist(this.saveAvatar?.(src, triggeredBy, p.avatarUrl))
      }
    } catch (err) {
      this.nextAttemptAt.set(channel, this.now() + FAIL_TTL_MS)
      this.log?.debug(`name lookup failed for channel ${channel}: ${(err as Error).message}`)
    }
  }

  /** Cache one user id's display name (Slack-parity `resolveUser`). Platforms whose bot
   *  API can't resolve arbitrary users just return a nameless profile — the attempt is
   *  still cached, so the miss costs one call per TTL. */
  private async resolveUser(src: ChannelInfoSource, user: string): Promise<void> {
    if (!this.claim(user)) return
    try {
      const p = await src.getUserProfile(user)
      const name = p.realName || p.name
      if (name) this.persist(this.save(user, name))
      if (p.avatarUrl) this.persist(this.saveAvatar?.(src, user, p.avatarUrl))
    } catch (err) {
      this.nextAttemptAt.set(user, this.now() + FAIL_TTL_MS)
      this.log?.debug(`name lookup failed for user ${user}: ${(err as Error).message}`)
    }
  }
}
