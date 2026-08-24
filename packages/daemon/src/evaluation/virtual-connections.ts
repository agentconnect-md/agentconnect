/**
 * Virtual platform connections — the Collaboration Arena transport seam
 * (docs/designs/collaboration-arena.md §3).
 *
 * A virtual connection implements the COMPLETE per-platform concrete-connection
 * surface the daemon consumes — the ordinary reply path (`postMessage`), tenant
 * metadata (`workspaceId()`), and the `MessageGateway` operations — so every
 * existing consumer (reply resolution, MCP ops, session/audience classification)
 * reaches the virtual transport through the daemon's existing per-integration
 * connection maps without new branches at daemon call sites.
 *
 * Both the ordinary reply path and MCP `sendMessage` converge on ONE world
 * outbound-effect sink ({@link VirtualConnectionWorldPort.recordOutbound}, §7.2)
 * that authorizes — not merely records — every attempted effect.
 */
import type { SendIdentity } from '../mcp/ops.js'
import type {
  PlatformChannelHistoryMessage,
  PlatformChannelHistoryOptions,
  PlatformChannelHistoryPage,
  PlatformConnection
} from '../platforms/contract.js'

/** Slack post options subset the virtual transport interprets. Structurally
 *  compatible with the real connection's `SlackPostOptions`: `chrome` marks
 *  daemon-authored delivery chrome (status bars, progress cards) as opposed to
 *  the agent's conversational reply. */
export interface VirtualPostOptions extends SendIdentity {
  chrome?: boolean
  chromeOwnerAgentId?: string
  trailingBlocks?: unknown[]
  replyTo?: number
  /** §4 finalized-response routing block on agent-authored posts. */
  response?: VirtualResponseMetadata
}

export interface VirtualChannelInfo {
  id: string
  name?: string
  isIm?: boolean
  isPrivate?: boolean
}

export interface VirtualMember {
  id: string
  name?: string
  isBot?: boolean
}

export interface VirtualProfile {
  id: string
  name?: string
  realName?: string
  isBot?: boolean
}

export type VirtualPlatform = 'slack' | 'discord' | 'telegram'

/** Which daemon path produced the effect. `reply` is the agent's conversational
 *  output (ordinary replies AND MCP sends — both are room speech); `chrome` is
 *  daemon delivery chrome (status bars, progress cards, footer migration);
 *  `finalize` is the §5 response-closing edit that re-stamps the last delivered
 *  message with the finalized routing metadata. */
export type OutboundEffectKind = 'reply' | 'chrome' | 'finalize'

/** Daemon-owned response metadata (send-message-routing-rework.md §4) — the
 *  virtual mirror of the real connection's SlackResponseMetadata. */
export interface VirtualResponseMetadata {
  responseId: string
  deliveryState: 'streaming' | 'final'
  hopCount: number
  mentionedAgentIds: string[]
  agentCallDeliveryId?: string
}

export interface OutboundEffectInput {
  kind: OutboundEffectKind
  platform: VirtualPlatform
  integrationId: string
  channel: string
  thread?: string
  /** Per-message sender identity stamped by the daemon (agentAuthorId is the
   *  trusted AgentConnect author id on Slack sends). */
  identity?: SendIdentity
  /** §4 response metadata the daemon attached to this delivery. */
  response?: VirtualResponseMetadata
  /** For `finalize`: the platform id of the message being re-stamped. */
  messageTs?: string
  text: string
}

/** §7.2 rejection taxonomy — the checks a real platform + daemon policy would
 *  enforce. Every attempt is recorded either way; invariant scoring counts
 *  ATTEMPTED violations, not just delivered ones. */
export type OutboundRejection =
  | 'integration_not_owned'
  | 'platform_mismatch'
  | 'not_a_member'
  | 'channel_not_visible'
  | 'unknown_channel'
  | 'invalid_thread'

export type OutboundEffectResult =
  | { status: 'delivered'; messageId: string; sequence: number }
  | { status: 'rejected'; sequence: number; reason: OutboundRejection }

/**
 * The world half of the transport seam: outbound authorization + the read model
 * (channels, members, profiles) the `MessageGateway` operations answer from.
 */
/** One historical room message as the provider would return it — the input to
 *  the daemon's turn-final thread snapshot (`finalThreadSnapshot` →
 *  `getThreadReplies`), which is how a running turn discovers messages that
 *  landed while it was working and triggers the regeneration fence. */
export interface VirtualThreadMessage {
  ts: string
  text: string
  sender: string
  isBot: boolean
  /** Stable AgentConnect author id for agent-authored posts (Slack metadata). */
  agentAuthorId?: string
  /** §4 response metadata as `conversations.replies` would report it. */
  response?: VirtualResponseMetadata
  /** Daemon delivery chrome (status bars, progress cards) — never conversation. */
  chrome?: boolean
}

export interface VirtualConnectionWorldPort {
  /** Outbound-effect sink shared by ordinary replies and MCP sends (§7.2). */
  recordOutbound(effect: OutboundEffectInput): Promise<OutboundEffectResult>
  channelInfo(channel: string): VirtualChannelInfo | undefined
  members(channel: string): readonly VirtualMember[]
  channels(integrationId: string): readonly VirtualChannelInfo[]
  profile(user: string): VirtualProfile | undefined
  /** Provider channel history; absent ⇒ the virtual world has no history source. */
  channelHistory?(channel: string): readonly VirtualThreadMessage[]
  /** Provider thread history in ts order, optionally windowed — backs
   *  `getThreadReplies`. Absent ⇒ the connection reports no history adapter and
   *  the daemon degrades to observed-only rows, exactly as on a platform
   *  without a history API. */
  threadHistory?(channel: string, thread: string): readonly VirtualThreadMessage[]
}

/** Surfaced to the agent when the world refuses an effect — the same shaped
 *  reply/tool error a real platform would return (§7.2). */
export class VirtualDeliveryRejected extends Error {
  readonly reason: OutboundRejection
  readonly sequence: number

  constructor(result: Extract<OutboundEffectResult, { status: 'rejected' }>) {
    super(result.reason)
    this.name = 'VirtualDeliveryRejected'
    this.reason = result.reason
    this.sequence = result.sequence
  }
}

export interface VirtualSlackTenant {
  workspaceId: string
  workspaceUrl?: string
}

export interface VirtualSlackIdentity {
  botUserId?: string
  botId?: string
  appId?: string
}

function identityOf(options?: VirtualPostOptions): SendIdentity | undefined {
  if (!options) return undefined
  const identity: SendIdentity = {
    ...(options.username !== undefined ? { username: options.username } : {}),
    ...(options.icon_url !== undefined ? { icon_url: options.icon_url } : {}),
    ...(options.agentAuthorId !== undefined ? { agentAuthorId: options.agentAuthorId } : {})
  }
  return Object.keys(identity).length > 0 ? identity : undefined
}

function virtualChannelHistory(
  world: VirtualConnectionWorldPort,
  channel: string,
  options: PlatformChannelHistoryOptions,
  maxLimit: number
): PlatformChannelHistoryPage {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), maxLimit)
  const offset = Math.max(Number.parseInt(options.cursor ?? '0', 10) || 0, 0)
  const oldest = options.oldest || undefined
  const latest = options.latest || undefined
  const messages = [...(world.channelHistory?.(channel) ?? [])]
    .filter(
      (message) => (oldest === undefined || message.ts >= oldest) && (latest === undefined || message.ts <= latest)
    )
    .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
  const page = messages.slice(offset, offset + limit)
  const nextOffset = offset + page.length
  const nextCursor = nextOffset < messages.length ? String(nextOffset) : undefined
  const result: PlatformChannelHistoryMessage[] = page.map((message) => ({
    sender: message.sender,
    ts: message.ts,
    text: message.text,
    isBot: message.isBot
  }))
  return {
    messages: result,
    hasMore: nextCursor !== undefined,
    ...(nextCursor !== undefined ? { nextCursor } : {})
  }
}

/**
 * Implements the `SlackConnection` surface the daemon uses: the ordinary reply
 * path, Slack tenant identity for session/audience classification, delivery
 * chrome (best-effort, like the real connection), and the full gateway ops.
 */
export class VirtualSlackConnection implements PlatformConnection {
  readonly botUserId: string
  readonly botId: string
  readonly appId?: string
  /** The real connection exposes credential fields that reconcile compares.
   *  Virtual integrations are excluded from physical reconcile, but keep the
   *  fields present (and secret-free) so duck-typed readers never throw. */
  readonly appToken = ''
  readonly botToken = ''
  readonly workspaceUrl?: string

  constructor(
    readonly integrationId: string,
    private readonly tenant: VirtualSlackTenant,
    private readonly world: VirtualConnectionWorldPort,
    identity: VirtualSlackIdentity = {}
  ) {
    this.botUserId =
      identity.botUserId ??
      `UVIRT${integrationId
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 8)
        .toUpperCase()}`
    this.botId = identity.botId ?? `B${this.botUserId.slice(1)}`
    if (identity.appId !== undefined) this.appId = identity.appId
    if (tenant.workspaceUrl !== undefined) this.workspaceUrl = tenant.workspaceUrl
  }

  /** Tenant identity for session/audience classification — same contract as the
   *  real connection's `workspaceId()` (auth.test team id). */
  workspaceId(): string {
    return this.tenant.workspaceId
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  private record(
    kind: OutboundEffectKind,
    channel: string,
    text: string,
    thread?: string,
    identity?: SendIdentity
  ): Promise<OutboundEffectResult> {
    return this.world.recordOutbound({
      kind,
      platform: 'slack',
      integrationId: this.integrationId,
      channel,
      ...(thread !== undefined ? { thread } : {}),
      ...(identity ? { identity } : {}),
      text
    })
  }

  /** Ordinary reply path — the same method the daemon's reply pipeline calls on
   *  a real connection. Routed to the world as a `reply` effect; a `chrome`
   *  post (options.chrome) is recorded but is best-effort like the real one. */
  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
    options?: VirtualPostOptions
  ): Promise<string | undefined> {
    const kind: OutboundEffectKind = options?.chrome ? 'chrome' : 'reply'
    const result = await this.world.recordOutbound({
      kind,
      platform: 'slack',
      integrationId: this.integrationId,
      channel,
      ...(threadTs !== undefined ? { thread: threadTs } : {}),
      ...(identityOf(options) ? { identity: identityOf(options)! } : {}),
      // The real connection persists the response block into Slack message
      // metadata (ignored on chrome, which is never routable) — preserve it.
      ...(options?.response !== undefined && !options.chrome ? { response: options.response } : {}),
      text
    })
    if (result.status !== 'delivered') {
      if (kind === 'chrome') return undefined
      throw new VirtualDeliveryRejected(result)
    }
    return result.messageId
  }

  /**
   * Close a logical response (send-message-routing-rework.md §5): re-stamp the
   * last delivered message with the finalized routing metadata. The real
   * connection does this with chat.update + message metadata; the virtual
   * transport records a `finalize` effect against the SAME platform message id
   * so the world's provider history — and the platform echo built from it —
   * carries the claim a peer's ingress verifies.
   */
  async finalizeResponse(
    channel: string,
    ts: string,
    _blocks: unknown[],
    text: string,
    agentAuthorId: string,
    response: VirtualResponseMetadata
  ): Promise<boolean> {
    const result = await this.world.recordOutbound({
      kind: 'finalize',
      platform: 'slack',
      integrationId: this.integrationId,
      channel,
      identity: { agentAuthorId },
      response,
      messageTs: ts,
      text
    })
    return result.status === 'delivered'
  }

  /** In-place edits are recorded as chrome effects: counting parses candidates
   *  from initial `reply` posts, and the real connection's chat.update is
   *  best-effort (never throws into dispatch). */
  async updateMessage(channel: string, _ts: string, text: string): Promise<void> {
    await this.record('chrome', channel, text)
  }

  async postBlocks(
    channel: string,
    _blocks: unknown[],
    text: string,
    threadTs?: string,
    options?: VirtualPostOptions
  ): Promise<string | undefined> {
    const result = await this.record('chrome', channel, text, threadTs, identityOf(options))
    return result.status === 'delivered' ? result.messageId : undefined
  }

  async updateBlocks(channel: string, _ts: string, _blocks: unknown[], text?: string): Promise<boolean> {
    await this.record('chrome', channel, text ?? '')
    return true
  }

  async deleteMessage(_channel: string, _ts: string): Promise<boolean> {
    return true
  }

  /**
   * Provider thread history (Slack `conversations.replies`). The daemon's
   * turn-final snapshot calls this to discover messages that landed while a
   * turn was running — the regeneration fence depends on it, so the virtual
   * transport answers from the world's real room history rather than an empty
   * (and falsely authoritative) list.
   */
  async getThreadReplies(
    channel: string,
    threadTs: string,
    maxMessages = 200,
    window?: { oldest?: string; latest?: string; readState?: { truncated: boolean } }
  ): Promise<
    {
      sender: string
      agentAuthorId?: string
      ts: string
      text: string
      isBot: boolean
      chrome: boolean
      attachments: never[]
    }[]
  > {
    const history = this.world.threadHistory?.(channel, threadTs) ?? []
    const windowed = history.filter(
      (message) =>
        (window?.oldest === undefined || message.ts > window.oldest) &&
        (window?.latest === undefined || message.ts <= window.latest)
    )
    // Same bounded-page contract as the real connection: report truncation so a
    // clipped page is never labeled an authoritative empty tail.
    if (window?.readState && windowed.length > maxMessages) window.readState.truncated = true
    return windowed.slice(-maxMessages).map((message) => ({
      sender: message.sender,
      ...(message.agentAuthorId !== undefined ? { agentAuthorId: message.agentAuthorId } : {}),
      ts: message.ts,
      text: message.text,
      isBot: message.isBot,
      chrome: message.chrome ?? false,
      attachments: [] as never[]
    }))
  }

  /** Provider channel history with the same bounded, cursor-paginated shape as Slack. */
  async getChannelHistory(
    channel: string,
    options: PlatformChannelHistoryOptions = {}
  ): Promise<PlatformChannelHistoryPage> {
    return virtualChannelHistory(this.world, channel, options, 200)
  }

  /** Ephemeral presence (assistant status) — not a message; not recorded. */
  async setStatus(): Promise<void> {}

  async setTitle(): Promise<void> {}

  /**
   * Native streaming turn output is UNSUPPORTED here, deliberately and deterministically.
   * The arena has no Slack API to stream into, and a half-modelled stream would change what
   * the arena counts; answering "cannot stream" sends every arena turn down the legacy
   * pipeline, which is the path every existing baseline was recorded against.
   */
  async startTurnStream(): Promise<undefined> {
    return undefined
  }

  async appendTurnStream(): Promise<'ok' | 'refused' | 'stopped'> {
    return 'refused'
  }

  async stopTurnStream(): Promise<boolean> {
    return false
  }

  streamingLikely(): boolean {
    return false
  }

  async openDirectMessage(user: string): Promise<string> {
    return `D-${user}`
  }

  async getChannelInfo(channel: string): Promise<{ id: string; name?: string; isIm?: boolean; isPrivate?: boolean }> {
    const info = this.world.channelInfo(channel)
    if (!info) throw new Error('channel_not_found')
    return info
  }

  async listMembers(channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]> {
    return [...this.world.members(channel)]
  }

  async listChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[]> {
    return [...this.world.channels(this.integrationId)]
  }

  async listBotChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[] | null> {
    return this.listChannels()
  }

  async leaveChannel(_channel: string): Promise<void> {}

  async getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }> {
    return this.world.profile(user) ?? { id: user }
  }

  async downloadFile(): Promise<Buffer | null> {
    return null
  }

  /** The Arena world hosts no files, so a forward is recorded for the ONE part of it a
   *  participant can see: the caption, as an ordinary reply. It reports delivery but no
   *  `messageId`, because the real Slack share answers with the file and no message ts — a
   *  virtual anchor would make the Arena the only place a forward can seed a session. */
  async uploadFile(
    channel: string,
    _file: { bytes: Buffer; name: string; mimeType?: string },
    comment?: string,
    anchor?: { thread?: string; replyTo?: number },
    options?: VirtualPostOptions
  ): Promise<{ ok: true; messageId?: string; warning?: string }> {
    const result = await this.world.recordOutbound({
      kind: 'reply',
      platform: 'slack',
      integrationId: this.integrationId,
      channel,
      ...(anchor?.thread !== undefined ? { thread: anchor.thread } : {}),
      ...(identityOf(options) ? { identity: identityOf(options)! } : {}),
      text: comment ?? ''
    })
    if (result.status !== 'delivered') throw new VirtualDeliveryRejected(result)
    return { ok: true }
  }
}

/** Minimal Discord shape: the reply path + gateway ops the counting milestone
 *  consumes. Extended to the full Discord surface with the cross-room game. */
export class VirtualDiscordConnection implements PlatformConnection {
  readonly botUserId: string
  readonly botToken = ''

  constructor(
    readonly integrationId: string,
    private readonly world: VirtualConnectionWorldPort,
    identity: { botUserId?: string } = {}
  ) {
    this.botUserId = identity.botUserId ?? `9${virtualNumericId(integrationId)}`
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async postMessage(
    channel: string,
    text: string,
    thread?: string,
    options?: VirtualPostOptions
  ): Promise<string | undefined> {
    const kind: OutboundEffectKind = options?.chrome ? 'chrome' : 'reply'
    const result = await this.world.recordOutbound({
      kind,
      platform: 'discord',
      integrationId: this.integrationId,
      channel,
      ...(thread !== undefined ? { thread } : {}),
      ...(identityOf(options) ? { identity: identityOf(options)! } : {}),
      text
    })
    if (result.status !== 'delivered') {
      if (kind === 'chrome') return undefined
      throw new VirtualDeliveryRejected(result)
    }
    return result.messageId
  }

  async getChannelInfo(channel: string): Promise<{ id: string; name?: string; isIm?: boolean; isPrivate?: boolean }> {
    const info = this.world.channelInfo(channel)
    if (!info) throw new Error('channel_not_found')
    return info
  }

  async listMembers(channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]> {
    return [...this.world.members(channel)]
  }

  async listChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[]> {
    return [...this.world.channels(this.integrationId)]
  }

  async getChannelHistory(
    channel: string,
    options: PlatformChannelHistoryOptions = {}
  ): Promise<PlatformChannelHistoryPage> {
    return virtualChannelHistory(this.world, channel, options, 100)
  }

  async getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }> {
    return this.world.profile(user) ?? { id: user }
  }

  async downloadFile(): Promise<Buffer | null> {
    return null
  }
}

/** Minimal Telegram shape mirroring {@link VirtualDiscordConnection}. */
export class VirtualTelegramConnection implements PlatformConnection {
  readonly botUserId: string
  readonly botUsername: string
  readonly botToken = ''

  constructor(
    readonly integrationId: string,
    private readonly world: VirtualConnectionWorldPort,
    identity: { botUserId?: string; botUsername?: string } = {}
  ) {
    this.botUserId = identity.botUserId ?? virtualNumericId(integrationId)
    this.botUsername = identity.botUsername ?? `virtual_${integrationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}_bot`
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async sendChatAction(_channel: string): Promise<void> {}

  async postMessage(
    channel: string,
    text: string,
    thread?: string,
    options?: VirtualPostOptions
  ): Promise<string | undefined> {
    const result = await this.world.recordOutbound({
      kind: 'reply',
      platform: 'telegram',
      integrationId: this.integrationId,
      channel,
      ...(thread !== undefined ? { thread } : {}),
      ...(identityOf(options) ? { identity: identityOf(options)! } : {}),
      text
    })
    if (result.status !== 'delivered') throw new VirtualDeliveryRejected(result)
    return result.messageId
  }

  async getChannelInfo(channel: string): Promise<{ id: string; name?: string; isIm?: boolean; isPrivate?: boolean }> {
    const info = this.world.channelInfo(channel)
    if (!info) throw new Error('channel_not_found')
    return info
  }

  async listMembers(channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]> {
    return [...this.world.members(channel)]
  }

  async listChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[]> {
    return [...this.world.channels(this.integrationId)]
  }

  async getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }> {
    return this.world.profile(user) ?? { id: user }
  }

  async downloadFile(): Promise<Buffer | null> {
    return null
  }
}

export type VirtualPlatformConnection = VirtualSlackConnection | VirtualDiscordConnection | VirtualTelegramConnection

/** Deterministic digits for synthetic numeric bot ids (Discord/Telegram). */
function virtualNumericId(seed: string): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return String(100_000_000 + (hash % 900_000_000))
}
