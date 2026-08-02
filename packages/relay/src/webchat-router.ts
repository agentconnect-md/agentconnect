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
