/**
 * A file shared alongside a message. Platform ingresses carry metadata + a
 * fetch URL and download the bytes daemon-locally with the provider token.
 * Webchat may instead arrive with bounded inline bytes from the relay content
 * plane. Both forms become ACP image/resource blocks at prompt assembly; the
 * daemon also retains bounded webchat images for authorized transcript replay.
 */
export interface Attachment {
  /** Stable source id (Slack file.id). */
  id: string
  /** Display name / title. */
  name: string
  /** e.g. 'image/png', 'application/pdf'. */
  mimeType: string
  /** Bytes, when the platform reports it. */
  size?: number
  /** Auth-gated provider URL/key, absent for an inline webchat upload. */
  sourceUrl?: string
  /** Already-bounded bytes from webchat, absent for provider-backed attachments. */
  inlineData?: Buffer
}

export interface NormalizedMessage {
  msgId: string
  /**
   * A displayable, ordering-safe transcript timestamp when `msgId` itself is not
   * time-based (hook deliveries use `<hookId>:<deliveryKey>`). A suffix after
   * the timestamp keeps same-millisecond deliveries distinct; consumers parse
   * only the timestamp before the separator.
   */
  transcriptTs?: string
  traceId: string
  source: 'user' | 'cron' | 'agent' | 'hook'
  platform: 'slack' | 'telegram' | 'webchat' | 'discord' | 'feishu' | 'hook'
  channel: string
  thread?: string
  /**
   * Opaque identity of the physical platform bot/connection that received this
   * message. Platform channel ids are only unique within one bot installation
   * (Telegram DMs in particular reuse the user's numeric id across bots), so the
   * daemon uses this scope for private transcript and session lookup boundaries.
   * It is internal metadata: user-facing channel/thread coordinates stay unchanged.
   */
  transportScope?: string
  sender: {
    id: string
    isBot: boolean
    /** Slack app id (`A…`) for app-authored messages, when Slack supplies it.
     *  Used only to suppress messages from AgentConnect-managed agent apps; it is
     *  never an authorization claim. */
    appId?: string
  }
  text: string
  /** Ingress-derived title applied only when this message creates a logical
   *  session. A later runtime title remains authoritative and replaces it. */
  initialSessionTitle?: string
  mentionedBots: string[]
  attachments?: Attachment[]
  isDm: boolean
  /**
   * Platform id of the message this one replies to, when the platform models replies
   * (Telegram `reply_to_message.message_id`). The daemon stitches a reply back to its
   * session with it (reply-based Telegram threading); absent when not a reply.
   */
  replyTo?: string
  /**
   * The CONTENT of the message this one replies to, when the platform ships it inline
   * (Telegram sends the whole `reply_to_message`, plus a narrower `quote` when the user
   * selected only part of it). Deliberately separate from `replyTo`: that id only stitches
   * the reply into a session, whereas this is what the reply is ABOUT. Without it, an
   * @mention that quotes a message the daemon never recorded — someone else's message, or
   * one from before this thread had a session — reaches the agent as the mention text alone.
   * Prompt assembly injects it only in exactly that case (see SessionManager.handle).
   */
  quoted?: {
    /** Platform id of the quoted message — the same value as `replyTo` on Telegram.
     *  Absent when the platform doesn't identify the quoted source; prompt assembly then
     *  cannot prove the quote is already in the transcript, so it injects it. */
    messageId?: string
    /** Display label for the quoted author (`@username` when known, else the platform id). */
    sender?: string
    /** The quoted text — already bounded, with any attachment mention folded in. */
    text: string
    /**
     * True when the replying user explicitly SELECTED this passage (Telegram `quote`).
     * The selection is itself the message — it says which part of the source the reply is
     * about — so prompt assembly delivers it even when the full source is already in the
     * agent's context, where a "what about this?" would otherwise be ambiguous.
     */
    selection?: boolean
    /** True when `text` is only part of the quoted message — a selection, or truncated
     *  by the ingress cap. Affects how the block is labeled, not whether it is sent. */
    excerpt?: boolean
  }
  /**
   * Telegram forum-topic id (`message_thread_id` with `is_topic_message`) — a native,
   * stable thread. The daemon uses it both as the session-thread key and as the
   * `message_thread_id` to post back into that topic. Absent outside a forum topic.
   */
  telegramTopicId?: string
  /**
   * Telegram reply-thread root (`message_thread_id` in a NON-forum supergroup, where
   * Telegram auto-threads replies to the root message id). A stable session key, but —
   * unlike a forum topic — it must NOT be sent as `message_thread_id` when posting
   * (Telegram rejects it outside forums); replies are continued with `reply_parameters`.
   */
  telegramThreadRoot?: string
  /**
   * Discord only: this message arrived in a top-level guild text channel (not a DM,
   * not already inside a thread). The daemon opens a thread off it and re-keys the
   * turn into that thread channel, so the reply + chrome live in a thread instead of
   * flooding the channel (Slack-parity). Absent for DMs and in-thread messages.
   */
  discordTopLevel?: boolean
  /** Trusted activation cause when known. In particular, `mention` means the router
   *  matched a raw platform token against this integration's own bound bot identity. */
  trigger?: 'mention' | 'dm' | 'keyword' | 'auto' | 'cron' | 'hook'
  // A cron fire with no target channel: run the agent's turn with ALL platform
  // output suppressed (transcript/session bookkeeping only). `channel` is then a
  // synthetic key, not a real platform channel.
  headless?: boolean
}

type MessageIdentityFields = Pick<NormalizedMessage, 'msgId' | 'platform' | 'traceId' | 'transportScope'>

/** Stable daemon-local delivery identity. Platform ids are only unique within
 * one physical bot; webchat instead needs its per-turn trace id. */
export function stableMessageId(msg: MessageIdentityFields): string {
  const sourceId = msg.platform === 'webchat' ? msg.traceId : msg.msgId
  return msg.transportScope ? `${msg.transportScope}\u001f${sourceId}` : sourceId
}

/** Stable operation fence shared by evaluation and memory lifecycle events. */
export function stableTurnId(agentId: string, msg: MessageIdentityFields): string {
  return `${agentId}:${stableMessageId(msg)}`
}
