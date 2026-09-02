/**
 * The daemon's **Layer-1 platform adapter contract**
 * (integration-plugin-architecture.md §7.1, stage S2).
 *
 * Layer 1 is what a CHAT platform must provide: transport lifecycle, connection
 * identity, and the read/query port core depends on (thread backfill for
 * mid-thread context, authenticated attachment download, the MCP MessageGateway
 * channel/member/profile/DM tools, bot-membership enumeration behind the
 * console's channel triggers). Layer 2 — the per-turn OUTPUT surface (converger
 * + applier + per-turn state) — is a separate contract and deliberately NOT
 * here: `postMessage` and friends stay on the concrete connections until the
 * renderer seam lands.
 *
 * LIFTED, NOT INVENTED. Every member below already exists on all four real
 * connections (`src/{slack,telegram,discord,feishu}/connection.ts`) and on the
 * Collaboration Arena's virtual connections (`evaluation/virtual-connections.ts`),
 * which were a de-facto enumeration of this surface. Declaring both sets against
 * one interface makes the evals a compile-time SECOND IMPLEMENTER: a member that
 * drifts on one side stops compiling on the other (an S2 exit criterion).
 *
 * REQUIRED vs OPTIONAL is the real division of labour, not a convenience:
 * a member is required only where core calls it for EVERY chat platform.
 * Everything core already probes for (`typeof conn.getThreadReplies === 'function'`
 * and friends — the audit catalogued these as duck-typed capability branches) is
 * optional here, so the probe has a typed home instead of an `unknown` cast. The
 * probes themselves collapse into adapter capabilities in a later S2 stage; this
 * PR only publishes the shape they will collapse onto.
 *
 * WHERE THIS LIVES. D1 puts shared contract/manifest TYPES in
 * `@agentconnect.md/protocol`, but that package is the browser-safe wire
 * contract (the web console imports it) and no other host implements this
 * interface — the relay's ingress contract (§8), the CP's provider slot (§9),
 * and the web module (§10) are each different shapes. Only the platform
 * MANIFEST (§5, pure data) is genuinely cross-host, and it goes to protocol when
 * the registry lands. This one is daemon-owned.
 */

/** The human behind one interactive click (button / select / modal submit). Carried
 *  alongside the action so the daemon records WHO changed a session, which a bare
 *  `sessionKey` cannot say. */
export interface InteractionActor {
  userId: string
  /** Only set where the platform reports it on the interaction (Discord does; a Slack
   *  `block_actions` payload carries no bot flag on its `user`). */
  isBot?: boolean
  /** Provider-observed display label. Presentation only — never an identity or auth input. */
  name?: string
}

/**
 * What a reaction placed on an INBOUND message means.
 *
 * Core names the intent; the platform picks the glyph, because a reaction
 * vocabulary is platform vocabulary — Slack takes a shortcode (`eyes`), Telegram
 * a literal emoji from a fixed allowed set, Lark an `emoji_type` key (`GLANCE`).
 * Naming the glyph in core would put a platform's alphabet where core can read
 * it; naming the intent keeps the mapping inside the module that owns it.
 */
export type PlatformReactionIntent = 'seen'

/** One conversation as the platform describes it. Members beyond `id` are
 *  optional because no platform reports all of them (`isMpim`/`user` are Slack's;
 *  `isIm` drives DM canonicalization and session classification on every
 *  platform that has direct conversations). */
export interface PlatformChannelInfo {
  id: string
  name?: string
  isIm?: boolean
  isMpim?: boolean
  isPrivate?: boolean
  user?: string
  /** Display glyph and tint where the platform gives the conversation one (a Linear team). */
  icon?: string
  color?: string
  /** The conversation's short platform handle and the page it opens there (a Linear team). */
  key?: string
  url?: string
}

/** A conversation in an enumeration (`listChannels` / `listBotChannels`). */
export interface PlatformChannelRef {
  id: string
  name?: string
  isPrivate?: boolean
  /** Display glyph and tint where the platform gives the conversation one (a Linear team). */
  icon?: string
  color?: string
  /** The conversation's short platform handle and the page it opens there (a Linear team). */
  key?: string
  url?: string
}

/** A conversation member — enough to resolve a mention and drop bots. */
export interface PlatformMemberRef {
  id: string
  name?: string
  isBot?: boolean
}

/** A user's public profile. `avatarUrl` is absent on platforms that do not
 *  expose one (Telegram). */
export interface PlatformUserProfile {
  id: string
  name?: string
  realName?: string
  isBot?: boolean
  avatarUrl?: string
}

/** One historical message from a provider thread read (`getThreadReplies`).
 *  `attachments` stays `unknown[]` here: the daemon's `Attachment` is a runtime
 *  model, and Layer 1 only needs the contract to agree on arity/order. */
export interface PlatformThreadMessage {
  sender: string
  ts: string
  text: string
  isBot: boolean
  chrome: boolean
  agentAuthorId?: string
  chromeOwnerAgentId?: string
  appId?: string
  attachments: unknown[]
}

/** Bounded window for a thread read; `readState` reports truncation back to the
 *  caller (the daemon's warm-thread backfill relies on it). */
export interface PlatformThreadWindow {
  oldest?: string
  latest?: string
  throwOnError?: boolean
  readState?: { truncated: boolean }
}

/** One bounded page of channel messages from a provider history read. */
export interface PlatformChannelHistoryMessage {
  sender: string
  ts: string
  text: string
  isBot: boolean
  threadTs?: string
  replyCount?: number
}

export interface PlatformChannelHistoryOptions {
  cursor?: string
  limit?: number
  oldest?: string
  latest?: string
}

export interface PlatformChannelHistoryPage {
  messages: PlatformChannelHistoryMessage[]
  hasMore: boolean
  nextCursor?: string
}

/** One emoji tally on a message (`getReactions`). `users` is present where the platform
 *  reports who reacted and the caller asked for the full list. */
export interface PlatformReactionSummary {
  name: string
  count: number
  users?: string[]
}

/** What `createConversation` was asked to make. `name` present ⇒ a channel; `users` alone ⇒
 *  the 1:1 or group conversation with exactly those people. */
export interface PlatformConversationSpec {
  name?: string
  isPrivate?: boolean
  users?: string[]
}

/** A message accepted for LATER delivery (`scheduleMessage`). `id` is the platform's own
 *  handle for the pending send, kept so a future cancel has something to name. */
export interface PlatformScheduledMessage {
  id: string
  channel: string
  postAt: number
}

/** One pinned link in a conversation. */
export interface PlatformBookmark {
  id: string
  title: string
  link?: string
  emoji?: string
}

/** A column of a structured list, and the shape a value for it must take. `type` is the
 *  provider's own vocabulary (`rich_text`, `user`, `date`, `select`, `number`, `checkbox`,
 *  `phone`), because a written value is keyed BY it and translating would lose the mapping. */
export interface PlatformListColumn {
  id: string
  name?: string
  /** The key a WRITE must use for this column — not necessarily the provider's schema type.
   *  Slack's primary column reads as `text` and is written as `rich_text`, so the two are
   *  normalized here rather than at each call site. */
  type: string
  /** Set when the provider computes this column and no request may set it. */
  readOnly?: boolean
}

/** One row. `fields` maps a column id to whatever the provider stored there. */
export interface PlatformListItem {
  id: string
  fields: Record<string, unknown>
}

/** A page of a list, WITH its columns — an agent cannot write a row without the column ids,
 *  and the provider offers no schema read, so the read carries them. */
export interface PlatformListPage {
  columns: PlatformListColumn[]
  items: PlatformListItem[]
  nextCursor?: string
}

/** A value to write into one column, in the provider's type-keyed shape. */
export interface PlatformListFieldWrite {
  columnId: string
  type: string
  value: unknown
}

/** Bounded workspace search (`searchPublicMessages`). `channel` narrows to one conversation. */
export interface PlatformSearchOptions {
  limit?: number
  cursor?: string
  channel?: string
  includeBots?: boolean
  /** Epoch-second bounds, as the provider takes them. */
  before?: number
  after?: number
}

/** One search hit, already flattened out of the provider's own result envelope. */
export interface PlatformSearchHit {
  channel: string
  channelName?: string
  messageTs: string
  text: string
  author?: string
  authorId?: string
  isBot?: boolean
  permalink?: string
}

export interface PlatformSearchResults {
  messages: PlatformSearchHit[]
  nextCursor?: string
}

/** A platform-hosted rich-text document page (Slack Canvas). `markdown` is present only on
 *  a read that could actually retrieve the body; `sections` are the addressable anchors an
 *  edit targets. */
export interface PlatformCanvas {
  id: string
  title?: string
  url?: string
  markdown?: string
  sections?: { id: string }[]
}

/** One edit against a {@link PlatformCanvas}. `replace` with no anchor rewrites the whole
 *  document; the anchored operations need a `sectionId` from a prior read. */
export interface PlatformCanvasEdit {
  operation: 'replace' | 'insert_at_start' | 'insert_at_end' | 'insert_before' | 'insert_after' | 'delete'
  sectionId?: string
  markdown?: string
}

/**
 * The Layer-1 contract every chat-platform connection satisfies.
 *
 * `start`/`stop` are the transport lifecycle the connection registry drives.
 * The read port is what core calls; the optional facets are what core probes
 * for. Identity fields are declared as optional properties rather than an
 * `identity()` method because that is how the connections already carry them
 * (Slack resolves `botUserId` from `auth.test` at start; Telegram/Discord/Feishu
 * carry a `workspaceUrl`); folding them into one accessor is a change of shape,
 * not of contract, and belongs with the registry.
 */
export interface PlatformConnection {
  // ── 1. transport lifecycle ──
  start(): Promise<void>
  stop(): Promise<void>

  // ── identity (carried as fields today; see the note above) ──
  // Only the members that are PUBLIC on every connection appear here. The
  // provider app id is deliberately absent: Slack keeps it private and Feishu
  // exposes it, so it is per-platform state, not shared identity — the manifest
  // (§5 `credentialShape`/`identityScope`) is where that difference belongs.
  readonly botUserId?: string
  readonly botId?: string
  readonly workspaceUrl?: string
  /** Durable tenant id for session/audience classification (Slack's team id).
   *  Absent on platforms with no tenant of their own. */
  workspaceId?(): string | undefined

  // ── 3. read / query port (the MessageGateway surface) ──
  getChannelInfo(channel: string): Promise<PlatformChannelInfo>
  listMembers(channel: string): Promise<PlatformMemberRef[]>
  listChannels(): Promise<PlatformChannelRef[]>
  getUserProfile(user: string): Promise<PlatformUserProfile>
  /** Fetch an attachment with the connection's own credential, bounded by
   *  `maxBytes`. `null` = unavailable/oversized, never a throw. */
  downloadFile(ref: string, maxBytes?: number): Promise<Buffer | null>

  // ── optional facets: what core PROBES for today ──
  /** Fetch one provider-paginated page of channel messages. */
  getChannelHistory?(channel: string, options?: PlatformChannelHistoryOptions): Promise<PlatformChannelHistoryPage>
  /** Provider thread history — backs mid-thread context recovery. Absent ⇒ the
   *  daemon degrades to observed-only transcript rows. */
  getThreadReplies?(
    channel: string,
    thread: string,
    maxMessages?: number,
    window?: PlatformThreadWindow
  ): Promise<PlatformThreadMessage[]>
  /** Open (or resolve) the 1:1 conversation with `user`; the MCP `toUser` form. */
  openDirectMessage?(user: string): Promise<string>
  /** AUTHORITATIVE bot membership, when the platform can enumerate it
   *  (`membershipEnumeration: 'authoritative'`). `null` ⇒ not answerable now. */
  listBotChannels?(): Promise<PlatformChannelRef[] | null>
  /** Leave one conversation (`leaveGranularity: 'conversation'`). */
  leaveChannel?(channel: string): Promise<void>
  /** Leave the enclosing space/guild (`leaveGranularity: 'space'` — Discord). */
  leaveSpace?(space: string): Promise<void>
  /** Delete a message the daemon posted (chrome cleanup). */
  deleteMessage?(channel: string, ts: string): Promise<boolean>
  /** React to an inbound message — the turn-start acknowledgement, placed before the
   *  agent has anything to say. Best-effort chrome that never throws into dispatch: a
   *  platform with no reactions omits the member, and an installation missing the
   *  permission simply shows nothing.
   *
   *  `container` is the message's NATIVE container (`nativeMessageCoordinates`), not the
   *  normalized `channel`: only the native pair addresses a Discord message inside a
   *  thread, whose normalized channel is the parent. */
  react?(container: string, messageId: string, intent: PlatformReactionIntent): Promise<void>
  /** Place an ARBITRARY reaction, for the agent-callable tool rather than turn chrome.
   *
   *  Distinct from {@link react} on purpose: that one takes an INTENT because core names it
   *  and the module owns the glyph. Here the glyph comes from the model, which already knows
   *  which platform it is speaking on, so `emoji` is the platform's own token (Slack's
   *  shortcode without colons) and no core-side vocabulary exists to translate. */
  addReaction?(channel: string, messageTs: string, emoji: string): Promise<void>
  /** The reactions already on one message. */
  getReactions?(channel: string, messageTs: string): Promise<PlatformReactionSummary[]>
  /** Create a channel, or open the direct conversation with a set of users. */
  createConversation?(spec: PlatformConversationSpec): Promise<PlatformChannelInfo>
  /** The links pinned in a conversation. */
  listBookmarks?(channel: string): Promise<PlatformBookmark[]>
  /** Pin a link in a conversation. */
  addBookmark?(channel: string, spec: { title: string; link: string; emoji?: string }): Promise<PlatformBookmark>
  /** Unpin one, by the id a read returned. */
  removeBookmark?(channel: string, bookmarkId: string): Promise<void>
  /** One page of a structured list, with the columns needed to write to it. */
  readList?(listId: string, options?: { cursor?: string; limit?: number }): Promise<PlatformListPage>
  /** Append a row. */
  addListItem?(listId: string, fields: PlatformListFieldWrite[]): Promise<PlatformListItem>
  /** Change fields on an existing row. */
  updateListItem?(listId: string, itemId: string, fields: PlatformListFieldWrite[]): Promise<void>
  /** Park the ephemeral search credential that arrived with one inbound message, for the
   *  HTTP arm where the RELAY saw the event and this connection did not. Core hands over the
   *  message id and the opaque token and keeps neither: the credential lives only in the
   *  adapter, because the normalized message is persisted and replayed. */
  rememberInboundSearchToken?(msgId: string, token: string): void
  /** Search the workspace. `originMsgId` names the inbound message the turn is answering,
   *  which some platforms require as the proof that a user action triggered the search. */
  searchPublicMessages?(
    query: string,
    options: PlatformSearchOptions,
    originMsgId: string | undefined
  ): Promise<PlatformSearchResults>
  /** Hand the platform a message to deliver at `postAt` (epoch seconds). The daemon is not
   *  involved in the eventual delivery, so nothing anchors a session to it. */
  scheduleMessage?(channel: string, text: string, postAt: number, thread?: string): Promise<PlatformScheduledMessage>
  /** Create a platform-hosted document page; `channel` tabs it into a conversation. */
  createCanvas?(title: string, markdown: string, channel?: string): Promise<PlatformCanvas>
  /** Read one back. A platform whose API exposes no body read returns the metadata it has. */
  readCanvas?(canvasId: string): Promise<PlatformCanvas>
  /** Apply edits to one. */
  updateCanvas?(canvasId: string, edits: PlatformCanvasEdit[]): Promise<void>
}
