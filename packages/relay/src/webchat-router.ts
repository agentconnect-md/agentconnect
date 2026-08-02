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

export class WebchatRouter {
  private byChatId = new Map<string, ChatSink>()

  register(chatId: string, sink: ChatSink): void {
    this.byChatId.set(chatId, sink)
  }

  /** Remove only if `sink` is still the registered one (a stale close must not evict a resume). */
  unregister(chatId: string, sink: ChatSink): void {
    if (this.byChatId.get(chatId) === sink) this.byChatId.delete(chatId)
  }

  /** Route one `rd/chat` to the browser owning its chatId (dropped if none is attached). */
  deliver(chat: RdChat): void {
    this.byChatId.get(chat.chatId)?.onChat(chat)
  }

  /** Route one `rd/webchat-post` to the browser owning its conversation. Dropped when no
   *  browser is attached — the authoring daemon's transcript row is the durable record,
   *  and a resuming browser rebuilds from the persisted sessions. */
  deliverPost(post: RdWebchatPost): void {
    this.byChatId.get(post.conversationId)?.onPost?.(post)
  }

  size(): number {
    return this.byChatId.size
  }
}
