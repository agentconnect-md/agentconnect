// Fan conversation output to its verified browser connections; cache rosters separately for peer-daemon context.
import type { RdChat, RdWebchatPost } from '@agentconnect.md/protocol'

/** The browser sink the router delivers a reply chunk to. */
export interface ChatSink {
  onChat(chat: RdChat): void
  /** A participant's completed conversation post (multi-agent fan-out seam).
   *  Optional so a minimal test sink stays valid. */
  onPost?(post: RdWebchatPost): void
}

/** One cached roster entry (agentId + current placement, as verified by the CP). */
export interface CachedParticipant {
  agentId: string
  daemonId?: string
}

// Bounded roster cache: entries are refreshed on every browser (re)connect and
// evicted oldest-first. Sized for "conversations with recent browser activity" —
// a completed reply's context fan-out must not depend on the browser still being
// attached (webchat-multi-agents.md §5.2), only on it having been here recently.
const ROSTER_CACHE_MAX = 4096

/**
 * Bind an `rd/webchat-post`'s authorship claim to the AUTHENTICATED daemon that sent
 * it (webchat-multi-agents.md §5.2a; the webchat mirror of the `rd/agentmsg` rule that
 * agent-call identity is bound by a trusted endpoint, never taken from the frame).
 *
 * The claim is bound when the outer and inner author fields agree
 * (`post.agentId === post.post.author.agentId`), the claimed author is a CP-verified
 * roster participant of this conversation, and that participant's verified placement
 * is the daemon the frame arrived from. A stale or evicted roster cache fails closed.
 *
 * An UNBOUND claim is not dropped — a context copy was pre-§5.2a trust (transcript
 * only), and transcripts already record whatever an authenticated daemon asserts. What
 * an unbound claim may NOT carry onward is the activation-capable depth stamp: the
 * returned post has `author.hopCount` stripped, so every receiving daemon treats it as
 * transcript-only, and a forged author can never make peers execute under a
 * `callFrom` the relay did not verify. The target daemon's own checks (call policy,
 * hop budget, exactly-once) remain the terminal verification on the bound path.
 */
export function bindWebchatPostAuthor(
  post: RdWebchatPost,
  fromDaemonId: string,
  roster: CachedParticipant[]
): { post: RdWebchatPost; authorBound: boolean } {
  const author = post.post.author
  const placement = roster.find((p) => p.agentId === post.agentId)
  const authorBound =
    author.kind === 'agent' &&
    author.agentId === post.agentId &&
    placement !== undefined &&
    placement.daemonId !== undefined &&
    placement.daemonId === fromDaemonId
  if (authorBound || author.kind !== 'agent' || author.hopCount === undefined) {
    return { post, authorBound }
  }
  return {
    authorBound,
    post: { ...post, post: { ...post.post, author: { kind: 'agent', agentId: author.agentId } } }
  }
}

export class WebchatRouter {
  private byChatId = new Map<string, Set<ChatSink>>()
  private rosterByChatId = new Map<string, CachedParticipant[]>()

  register(chatId: string, sink: ChatSink): void {
    let sinks = this.byChatId.get(chatId)
    if (!sinks) this.byChatId.set(chatId, (sinks = new Set()))
    sinks.add(sink)
  }

  /** Cache a conversation's CP-verified roster (called on every browser connect,
   *  including the rebuild after a mid-conversation join). Survives the browser
   *  socket closing, so `rd/webchat-post` fan-out keeps reaching peer daemons. */
  rememberRoster(chatId: string, participants: CachedParticipant[]): void {
    // Re-inserting moves the entry to the back of the eviction order.
    this.rosterByChatId.delete(chatId)
    this.rosterByChatId.set(chatId, participants)
    while (this.rosterByChatId.size > ROSTER_CACHE_MAX) {
      const oldest = this.rosterByChatId.keys().next().value
      if (oldest === undefined) break
      this.rosterByChatId.delete(oldest)
    }
  }

  /** The cached roster for a conversation ([] when never seen / evicted). */
  rosterOf(chatId: string): CachedParticipant[] {
    return this.rosterByChatId.get(chatId) ?? []
  }

  /** Remove only this connection; sibling tabs and reconnects remain subscribed. */
  unregister(chatId: string, sink: ChatSink): void {
    const sinks = this.byChatId.get(chatId)
    if (!sinks) return
    sinks.delete(sink)
    if (sinks.size === 0) this.byChatId.delete(chatId)
  }

  /** Route output and completion to every browser subscribed to this conversation. */
  deliver(chat: RdChat): void {
    for (const sink of this.byChatId.get(chat.chatId) ?? []) sink.onChat(chat)
  }

  /** Render the canonical post to every subscriber; peer-daemon context uses the independent roster cache. */
  deliverPost(post: RdWebchatPost): void {
    for (const sink of this.byChatId.get(post.conversationId) ?? []) sink.onPost?.(post)
  }

  size(): number {
    return this.byChatId.size
  }
}
