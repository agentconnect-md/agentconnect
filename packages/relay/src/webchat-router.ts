/**
 * `WebchatRouter` — the relay's `chatId → browser connection` index (shared-bot-relay.md
 * §7.2). A daemon streams a turn's reply back as `rd/chat { chatId, seq, event }` over
 * its rd/* socket; the relay looks the chatId up here and forwards each chunk to the
 * browser that owns that conversation. Registered when a browser socket opens, removed
 * (only-if-still-ours) on close. A completed reply post (`rd/webchat-post`) resolves
 * through the same index: the browser connection holds the conversation's verified
 * roster, so it both renders the post and fans the context copies out
 * (webchat-multi-agents.md §5.2).
 */
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
  private byChatId = new Map<string, ChatSink>()
  private rosterByChatId = new Map<string, CachedParticipant[]>()

  register(chatId: string, sink: ChatSink): void {
    this.byChatId.set(chatId, sink)
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

  /** Remove only if `sink` is still the registered one (a stale close must not evict a resume). */
  unregister(chatId: string, sink: ChatSink): void {
    if (this.byChatId.get(chatId) === sink) this.byChatId.delete(chatId)
  }

  /** Route one `rd/chat` to the browser owning its chatId (dropped if none is attached). */
  deliver(chat: RdChat): void {
    this.byChatId.get(chat.chatId)?.onChat(chat)
  }

  /** Render one `rd/webchat-post` to the browser owning its conversation, when one is
   *  attached (the live stream already showed the text; this is the canonical record).
   *  Peer-daemon context fan-out happens SEPARATELY from the roster cache — never
   *  through the browser sink, which may be gone mid-turn. */
  deliverPost(post: RdWebchatPost): void {
    this.byChatId.get(post.conversationId)?.onPost?.(post)
  }

  size(): number {
    return this.byChatId.size
  }
}
