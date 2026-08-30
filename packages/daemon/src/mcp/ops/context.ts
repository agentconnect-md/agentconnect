import type { MemoryWriteSource } from '../../memory/store.js'
import type { MemoryScope } from '../../memory/types.js'
import type { ToolDescriptor } from '../../tool-schema/descriptor.js'
import type {
  PlatformCanvas,
  PlatformCanvasEdit,
  PlatformChannelHistoryOptions,
  PlatformChannelHistoryPage,
  PlatformChannelInfo,
  PlatformConversationSpec,
  PlatformReactionSummary,
  PlatformScheduledMessage,
  PlatformThreadMessage,
  PlatformThreadWindow
} from '../../platforms/contract.js'

/**
 * The platform-neutral slice a session's tools need. `SlackConnection` and
 * `TelegramConnection` both implement this; tests pass a fake. Read methods
 * return already-shaped plain objects so the tool results are stable regardless
 * of the underlying platform SDK response. "channel" is the platform conversation
 * id (Slack channel `C…` / Telegram chat id); "user" is a platform user id.
 */
/** Optional per-message sender identity for {@link MessageGateway}. Slack can render
 *  the name/avatar (via `chat:write.customize`) and persist the stable AgentConnect
 *  author id in message metadata; other platforms ignore these fields. */
export interface SendIdentity {
  username?: string
  /** Public https image URL for the message avatar (the agent's icon). */
  icon_url?: string
  /** Stable AgentConnect author id persisted in Slack message metadata. */
  agentAuthorId?: string
  /**
   * The finalized-response block for the VISIBLE half of a paired `toAgent + channel`
   * send (send-message-routing-rework.md §3.2/§4).
   *
   * Unlike a streamed turn reply, this post is complete the moment it is made — there is
   * no later finalization edit to close it — so it is stamped `final` here, carrying the
   * pairing id the target's activation rendezvous keys on. Without it the platform half
   * of a paired call arrives at ingress indistinguishable from an ordinary agent reply,
   * and the platform-first arrival order can never be recognized as one.
   */
  response?: {
    responseId: string
    deliveryState: 'streaming' | 'final'
    hopCount: number
    mentionedAgentIds: string[]
    agentCallDeliveryId?: string
  }
}

/** Where inside a conversation a file post lands — see {@link MessageGateway.uploadFile}. */
export interface UploadAnchor {
  thread?: string
  replyTo?: number
}

/** Why an upload posted nothing. `indeterminate` alone means "may have landed — do not retry". */
export type UploadFailReason =
  'missing_scope' | 'too_large' | 'not_found' | 'forbidden' | 'indeterminate' | 'platform_error'

export type UploadOutcome =
  | { ok: true; messageId?: string; warning?: string }
  /** `detail` is the PROVIDER's own error code, carried because a category alone is not
   *  diagnosable: `platform_error` is the catch-all every unclassified refusal lands in, and
   *  a report that omits what the platform actually said cannot be acted on. */
  | { ok: false; reason: UploadFailReason; detail?: string }

export interface MessageGateway {
  /** Layer-1 `openDirectMessage`: resolve one platform user to the app's real
   *  direct-message conversation. Optional because it is a declared read port,
   *  not a universal one — Slack needs it before posting with a customized agent
   *  identity (sending to a raw U… id routes the message through Slack's
   *  system-notification DM); a platform without the port has no `toUser` form. */
  openDirectMessage?(user: string): Promise<string>
  /** Post a message; returns the resulting message id (`ts` / message_id) so the
   *  daemon can record it. `identity` carries the agent's stable id and optional
   *  visual identity; other platforms may ignore it. */
  postMessage(channel: string, text: string, threadTs?: string, identity?: SendIdentity): Promise<string | undefined>
  /** Materialize a provider-native thread from a root message when that platform
   *  requires one before the post can own a follow-up session (Discord). */
  createThread?(channel: string, messageId: string, name: string): Promise<string | undefined>
  getChannelInfo(channel: string): Promise<{ id: string; name?: string; isIm?: boolean; isPrivate?: boolean }>
  listMembers(channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]>
  listChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[]>
  getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }>
  /** Read one bounded page from the conversation bound to the current session. */
  getChannelHistory?(channel: string, options?: PlatformChannelHistoryOptions): Promise<PlatformChannelHistoryPage>
  /** Root + replies of one thread. Long a daemon-internal context read; the `getThreadHistory`
   *  tool is the same port handed to the agent. */
  getThreadReplies?(
    channel: string,
    thread: string,
    maxMessages?: number,
    window?: PlatformThreadWindow
  ): Promise<PlatformThreadMessage[]>
  /** Arbitrary reactions — the agent-callable pair, not the turn-chrome `react` intent. */
  addReaction?(channel: string, messageTs: string, emoji: string): Promise<void>
  getReactions?(channel: string, messageTs: string): Promise<PlatformReactionSummary[]>
  /** Create a channel, or open the direct conversation with a set of users. */
  createConversation?(spec: PlatformConversationSpec): Promise<PlatformChannelInfo>
  /** Hand the platform a message to deliver later; the daemon sees nothing at delivery. */
  scheduleMessage?(channel: string, text: string, postAt: number, thread?: string): Promise<PlatformScheduledMessage>
  /** Platform-hosted document pages (Slack Canvas). */
  createCanvas?(title: string, markdown: string, channel?: string): Promise<PlatformCanvas>
  readCanvas?(canvasId: string): Promise<PlatformCanvas>
  updateCanvas?(canvasId: string, edits: PlatformCanvasEdit[]): Promise<void>
  /** Download an auth-gated file (Slack url_private / Telegram file_id) with the
   *  bot credentials; null on failure / over-cap. Backs the `read*File` tools so
   *  the agent can read attachments without ever holding the token. */
  downloadFile(sourceUrl: string, maxBytes?: number): Promise<Buffer | null>
  /** The mirror of {@link downloadFile}: put BYTES into a conversation, introduced by
   *  `comment`. Optional — only a platform that can host a file offers it.
   *
   *  THE CONTRACT IS `ok: false` ⇔ NOTHING WAS POSTED — except `reason: 'indeterminate'`,
   *  the send queue abandoning a still-running upload, which means MAY HAVE LANDED and
   *  must never be retried. Two platforms cannot express a file and its caption as one
   *  message, so they send two — and an implementation must order them so the FILE goes
   *  first. Then a failure before anything lands really did land nothing, and a caption
   *  lost after it reports `warning` on an otherwise successful send. Conflating the two
   *  would tell an agent nothing was sent while its words sat in the chat, and the retry
   *  would duplicate them.
   *
   *  `anchor` places the post inside the conversation the caller is already in: `thread`
   *  is the platform's own thread coordinate (Slack thread_ts / Discord thread channel /
   *  Feishu om_ root — which an implementation must REFUSE rather than repurpose when it
   *  cannot honor it), and `replyTo` is the reply-target message id on platforms that
   *  place by reply (Telegram non-forum groups). Absent ⇒ a channel-root post.
   *
   *  A success carries the post anchor when the platform's file send produces one; Slack's
   *  does not (it answers with the file, no ts), so there `messageId` is absent on success
   *  and the caller degrades exactly as it does for a post that returned no id. */
  uploadFile?(
    channel: string,
    file: { bytes: Buffer; name: string; mimeType: string },
    comment?: string,
    anchor?: UploadAnchor,
    identity?: SendIdentity
  ): Promise<UploadOutcome>
}

/**
 * A tool result that should be handed to the agent as native MCP content blocks
 * (e.g. a viewable image) rather than JSON-stringified text. The bridge detects
 * the `mcpContent` marker and passes the blocks through verbatim.
 */
export interface McpContentResult {
  mcpContent: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  /** Preserve a remote MCP tool's semantic error without converting its content. */
  mcpIsError?: boolean
}

/** Per-session binding captured at `session/new`, keyed by the IPC token. */
export interface SessionContext {
  agentId: string
  /** The platform that triggered this session (slack/telegram/…). Trusted — set
   *  by the daemon from the real triggering message, never a tool input. Used to
   *  build the coords for peer-discovery (`listAgents`). */
  platform: string
  /** The exact platform integration that delivered this session. Absent for a
   *  platform-free session; daemon-local universal tools still work there. */
  integrationId?: string
  /** Opaque physical-bot identity captured by the daemon. Platform coordinates
   *  can overlap across bots, so daemon-local session lookups include this scope. */
  transportScope?: string
  /** Whether the trusted source conversation is a direct message. Slack native
   *  thread titles are valid only for app-DM sessions. */
  isDm: boolean
  channel: string
  thread: string
  tools: ToolDescriptor[]
  /**
   * Binds the shared memory tools to THIS trigger's store (#41). Every path that
   * writes memory — an ordinary turn, per-turn distillation, a dream — uses the same
   * tool surface; only this binding differs. Absent ⇒ the agent's live store, written
   * as `tool`, which is the ordinary conversational case.
   */
  memoryBinding?: {
    /** Provenance for the write ledger. Dream adoption's rebase classifies drift by
     *  this, so a distillation-triggered write must still say `distill`. */
    source: MemoryWriteSource
    /** The store to act on. A synthetic session (distillation) has no real channel
     *  coordinates, so it pins the ORIGINATING conversation's scope here — otherwise a
     *  channel-scoped agent would distill into the wrong folder. A dream pins its
     *  STAGED store the same way. */
    scope?: MemoryScope
    /** Constrain topic filenames beyond the store's own path rules. A dream keeps the
     *  lowercase-kebab shape its proposal format always enforced. */
    topicPattern?: RegExp
    /** Cap distinct topics this session may create, mirroring the bound the proposal
     *  format used to apply. Absent ⇒ uncapped, as for an ordinary turn. */
    maxTopics?: number
  }
  /** Snapshot of the agent's integrations (id + platform) at session/new. Lets the
   *  platform-neutral `sendMessage` tool route to ANY connected platform,
   *  not just the one that triggered this session. Absent ⇒ fall back to the
   *  current session's own integration (same-platform send only). */
  integrations?: { id: string; platform: string }[]
  /** The agent's display identity (displayName || name), stamped on tool sends so
   *  they match the agent's ordinary replies. The model never supplies this. */
  agentName?: string
  /** The agent's public avatar URL, sibling of {@link agentName}. */
  iconUrl?: string
}

/** One tool handler in the pre-gateway registry: the trusted session context, the raw
 *  tool args, and the deps slice its domain declares. */
export type ToolHandler<D> = (ctx: SessionContext, args: Record<string, unknown>, deps: D) => Promise<unknown> | unknown
