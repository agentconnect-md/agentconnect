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
}

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
}

/** A conversation in an enumeration (`listChannels` / `listBotChannels`). */
export interface PlatformChannelRef {
  id: string
  name?: string
  isPrivate?: boolean
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
}
