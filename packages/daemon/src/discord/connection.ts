import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  MessageFlags,
  type Message,
  type Channel,
  type ChatInputCommandInteraction
} from 'discord.js'
import type { Agent } from '../agents/agent-schema.js'
import { platformIntegrationConfig } from '../platforms/integration-config.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { Logger } from '../log.js'
import { isSendQueueTimeout, PlatformSendQueue } from '../platforms/send-queue.js'
import type { UploadAnchor, UploadFailReason, UploadOutcome } from '../mcp/ops/context.js'
import { humanizeDiscordText, normalizeDiscordMessage, type DiscordMessageLike } from './normalize.js'
import { DISCORD_APP_COMMANDS } from './app-commands.js'
import {
  buildPermissionUpdateNotice,
  parseDiscordCallback,
  parseDiscordSelect,
  chunkForDiscord,
  type DiscordComponents,
  type DiscordSelectKind
} from './render.js'
import type {
  InteractionActor,
  PlatformChannelHistoryOptions,
  PlatformChannelHistoryPage,
  PlatformConnection,
  PlatformReactionIntent
} from '../platforms/contract.js'

/** Core names the intent; Discord's alphabet is literal unicode emoji. */
const DISCORD_REACTION_EMOJI: Record<PlatformReactionIntent, string> = { seen: '👀' }

/**
 * §Discord edge unit. Mirrors slack/connection.ts + telegram/connection.ts but over
 * the discord.js Gateway (a persistent OUTBOUND WebSocket, so it works behind NAT
 * like Slack Socket Mode / Telegram long-polling). One connection per bot token.
 *
 * v1 is TEXT-ONLY over standard Discord markdown: `postMessage`/`postChrome` send
 * verbatim (no mrkdwn/HTML conversion) chunked to the 2000-char cap, `sendChatAction`
 * maps to the channel typing indicator, and status-bar buttons (message components)
 * drive the same cancel / set-fast actions Telegram's inline keyboard does — routed
 * back through `onStatusAction` via the InteractionCreate event.
 *
 * NATIVE SLASH COMMANDS: on connect we register the control vocabulary as Discord
 * application commands (app-commands.ts) so `/status`, `/models`, … appear in the `/`
 * autocomplete menu. An invocation isn't a second engine — it's reconstructed into its
 * `/text` form and fed through the SAME onMessage path as a typed command. Requires the
 * bot to be invited with the `applications.commands` scope (else `set` 403s).
 */

/** One Discord Gateway connection per unique bot token. */
export interface ConsolidatedDiscordGroup {
  botToken: string
  integrations: { agentId: string; integrationId: string }[]
}

/** §6.1 analog: group integrations by bot token (one discord.js Client per token). */
/** §7.5 opaque identity of one Discord Gateway connection: the bot token. */
export function discordConnKey(c: { botToken: string }): string {
  return c.botToken
}

export function consolidateDiscord(agents: Agent[]): Map<string, ConsolidatedDiscordGroup> {
  const groups = new Map<string, ConsolidatedDiscordGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'discord') continue
      // §6.4: config validated by this platform's module schema; invalid ⇒ no gateway.
      const discord = platformIntegrationConfig('discord', int)
      if (!discord) continue
      const k = discord.botToken
      const g = groups.get(k) ?? { botToken: k, integrations: [] }
      g.integrations.push({ agentId: a.id, integrationId: int.id })
      groups.set(k, g)
    }
  }
  return groups
}

export interface DiscordDeps {
  group: ConsolidatedDiscordGroup
  onMessage: (msg: NormalizedMessage) => void
  /** Fired when a user taps a status-bar button (message component). `sessionKey`
   *  is resolved by the connection from the button's message (channel+message_id →
   *  session key, registered when the status bar was posted). */
  onStatusAction?: (a: {
    kind: 'cancel' | 'set-fast'
    sessionKey: string
    fastMode?: boolean
    /** Who tapped it, so the daemon can record the operator behind a session change. */
    actor?: InteractionActor
  }) => void
  /** Fired when a user taps a select-card button (`/models` `/effort` `/permission`).
   *  Applies the choice for `sessionKey` and returns the re-rendered card so the
   *  connection edits the tapped message in place (the current option now flagged).
   *  Returns undefined to leave the card unchanged (no session / stale option). */
  onSelectAction?: (a: {
    kind: DiscordSelectKind
    index: number
    sessionKey: string
    actor?: InteractionActor
  }) => Promise<{ text: string; components: DiscordComponents } | undefined>
  newTraceId: () => string
  log?: Logger
  /** Min spacing (ms) between outbound writes (serialized send-queue). Tests pass 0. */
  sendIntervalMs?: number
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** Cap on channels enumerated per listChannels call (bounds the response). */
const CHANNEL_CAP = 200
const DISCORD_CHANNEL_HISTORY_DEFAULT_LIMIT = 100
const DISCORD_CHANNEL_HISTORY_MAX_LIMIT = 100
const PERMISSION_NOTICE_RETRY_MS = 5 * 60_000

// Keep this permission set in lock-step with packages/web/src/components/console/platforms/discord/invite.ts.
const DISCORD_BOT_PERMISSIONS = (
  (1n << 6n) | // ADD_REACTIONS
  (1n << 10n) | // VIEW_CHANNEL
  (1n << 11n) | // SEND_MESSAGES
  (1n << 14n) | // EMBED_LINKS
  (1n << 15n) | // ATTACH_FILES
  (1n << 16n) | // READ_MESSAGE_HISTORY
  (1n << 35n) | // CREATE_PUBLIC_THREADS
  (1n << 38n)
) // SEND_MESSAGES_IN_THREADS
  .toString()

/** Map a Discord send error to the port's typed failure vocabulary. 40005 = entity too large. */
function classifyDiscordUploadError(err: unknown): UploadFailReason {
  const code = (err as { code?: unknown })?.code
  if (code === 40005) return 'too_large'
  if (code === 50013 || code === 50001) return 'forbidden'
  if (code === 10003 || code === 10008) return 'not_found'
  return 'platform_error'
}

type DiscordPermissionIssue = 'missing-access' | 'missing-permissions' | 'missing-oauth-scope'

type DiscordErrorLike = {
  code?: unknown
  data?: { code?: unknown }
  rawError?: { code?: unknown }
}

/** Discord API errors use stable numeric codes even though discord.js may expose the
 * code on either the wrapper or raw payload. Exact message matching keeps test doubles
 * and older library shapes compatible without treating every HTTP 403 as reparable. */
function discordPermissionIssueFrom(err: unknown): DiscordPermissionIssue | null {
  const e = err && typeof err === 'object' ? (err as DiscordErrorLike) : undefined
  const candidate = e?.code ?? e?.rawError?.code ?? e?.data?.code
  const code = typeof candidate === 'number' ? candidate : Number(candidate)
  if (code === 50001) return 'missing-access'
  if (code === 50013) return 'missing-permissions'
  if (code === 50026) return 'missing-oauth-scope'

  const message = err instanceof Error ? err.message : ''
  if (/\bmissing access\b/i.test(message)) return 'missing-access'
  if (/\bmissing permissions?\b/i.test(message)) return 'missing-permissions'
  if (/\bmissing required oauth2 scope\b/i.test(message)) return 'missing-oauth-scope'
  return null
}

function discordErrorCode(err: unknown): number | undefined {
  const e = err && typeof err === 'object' ? (err as DiscordErrorLike) : undefined
  const candidate = e?.code ?? e?.rawError?.code ?? e?.data?.code
  const code = typeof candidate === 'number' ? candidate : Number(candidate)
  return Number.isSafeInteger(code) && code >= 0 ? code : undefined
}

/** The discord.js message-send payload we use (content + optional components). */
type SendPayload = {
  content?: string
  components?: DiscordComponents
  /** Discord carries bytes on the message itself — no separate upload call. */
  files?: { attachment: Buffer; name: string }[]
  /** `parse: []` suppresses every ping a model-authored caption could carry. */
  allowedMentions?: { parse: never[] }
}
type Sendable = Channel & {
  send: (payload: SendPayload) => Promise<Message>
  sendTyping?: () => Promise<void>
  messages?: { fetch: (id: string) => Promise<Message> }
}

export class DiscordConnection implements PlatformConnection {
  private client: Client
  // All outbound writes funnel through one queue so streamed edits are FIFO-ordered
  // per connection (discord.js handles REST rate limits, but the queue keeps a
  // post-then-edit pair from racing on the same progress message).
  private queue: PlatformSendQueue
  // Status-component message → session key, so a button interaction (which carries
  // only channel+message id, not the session key) resolves back to its session.
  // Keyed `${channelId}:${messageId}`.
  private statusKeys = new Map<string, string>()
  /** Permission failures can repeat for every streamed write. Announce once per bot
   * connection, with a bounded retry if the bot currently cannot send the notice. */
  private hasGlobalPermissionIssue = false
  private permissionIssueChannels = new Set<string>()
  private loggedPermissionIssues = new Set<DiscordPermissionIssue>()
  private permissionNoticeSent = false
  private permissionNoticeInFlight = false
  private permissionNoticeRetryAt = new Map<string, number>()
  /** The bot token this gateway authenticated with (used to detect a swap). */
  readonly botToken: string
  /** The bot's user id (a numeric snowflake, as string). Discord routes mentions on
   *  this id (normalize's mentionedBots are user ids). Resolved at start() via ready. */
  botUserId = ''
  /** The bot's username, for logging/parity (Discord routes on id, not name). */
  botUsername = ''
  /** No workspace permalink base on Discord (unlike Slack); '' so the daemon's
   *  deep-link base falls through to the configured / CP / local default Web App URL. */
  readonly workspaceUrl = ''

  constructor(private deps: DiscordDeps) {
    this.botToken = deps.group.botToken
    this.queue = new PlatformSendQueue(deps.sendIntervalMs ?? 350)
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // privileged: needed to read message text
        GatewayIntentBits.DirectMessages
      ],
      // Discord does not cache DM channels. Without this partial, discord.js drops
      // MESSAGE_CREATE events from DMs before they reach our MessageCreate handler.
      partials: [Partials.Channel]
    })
  }

  async start(): Promise<void> {
    const log = this.deps.log
    const client = this.client

    client.on(Events.MessageCreate, (message) => {
      // Skip our own messages — the agent's replies must not re-trigger a turn.
      if (message.author.id === this.botUserId) return
      try {
        const msg = normalizeDiscordMessage(this.toLike(message), { traceId: this.deps.newTraceId() })
        log?.debug(
          `discord: inbound ch=${msg.channel} user=${msg.sender.id} isBot=${msg.sender.isBot} isDm=${msg.isDm} ` +
            `mentions=[${msg.mentionedBots.join(',')}] text=${JSON.stringify(msg.text.slice(0, 80))}`
        )
        this.deps.onMessage(msg)
      } catch (err) {
        log?.debug(`discord: inbound normalize failed: ${(err as Error).message}`)
      }
    })

    // Status-component taps: ack promptly (Discord requires an interaction response
    // within 3s), resolve the session key from the button's message, and forward.
    client.on(Events.InteractionCreate, async (interaction) => {
      // Native slash command (/status, /models, …) — reconstruct + route as a message.
      if (interaction.isChatInputCommand()) {
        this.onSlashCommand(interaction)
        return
      }
      if (!interaction.isButton()) return
      void interaction.deferUpdate().catch(() => {})
      const channel = interaction.channelId
      const sessionKey = this.statusKeys.get(`${channel}:${interaction.message.id}`)
      if (!sessionKey) return
      const actor: InteractionActor = { userId: interaction.user.id, isBot: interaction.user.bot }
      // Status-bar verbs (Cancel / Fast) — fire-and-forget onto the session.
      const status = parseDiscordCallback(interaction.customId)
      if (status) {
        if (status.kind === 'cancel') this.deps.onStatusAction?.({ kind: 'cancel', sessionKey, actor })
        else this.deps.onStatusAction?.({ kind: 'set-fast', sessionKey, fastMode: status.fastMode, actor })
        return
      }
      // Select-card taps (model / effort / permission): apply + re-render the card in place.
      const sel = parseDiscordSelect(interaction.customId)
      if (sel && this.deps.onSelectAction) {
        const rendered = await this.deps.onSelectAction({ kind: sel.kind, index: sel.index, sessionKey, actor })
        if (rendered)
          void this.updateMessage(channel, interaction.message.id, rendered.text, { keyboard: rendered.components })
      }
    })

    client.on(Events.Error, (err) => log?.debug(`discord: client error: ${err.message}`))

    log?.debug('discord: login → opening Gateway…')
    await new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, (c) => {
        this.botUserId = c.user.id
        this.botUsername = c.user.username
        log?.debug(`discord: ready → bot @${this.botUsername} (id ${this.botUserId})`)
        // Register native slash commands (best-effort, off the ready path so a failure
        // — e.g. the bot lacks the applications.commands scope — never blocks connect).
        void this.registerCommands()
        resolve()
      })
      client.login(this.botToken).catch(reject)
    })
  }

  /** Register the control vocabulary as global Discord application commands so it shows
   *  up in the `/` autocomplete menu. Global registration covers every guild + DMs;
   *  first-time propagation can take up to ~1h (edits are near-instant thereafter).
   *  Best-effort — a 403 almost always means the bot wasn't invited with the
   *  `applications.commands` scope, so we log that hint rather than throwing. */
  private async registerCommands(): Promise<void> {
    try {
      await this.client.application?.commands.set(DISCORD_APP_COMMANDS)
      this.deps.log?.info(
        `discord: registered ${DISCORD_APP_COMMANDS.length} slash commands (global) for @${this.botUsername}`
      )
    } catch (err) {
      this.rememberPermissionIssue(err)
      this.deps.log?.error(
        `discord: slash-command registration failed — is the bot invited with the ` +
          `applications.commands scope? (${(err as Error).message})`
      )
    }
  }

  /**
   * A native slash-command invocation. Ack within Discord's 3s window (an ephemeral
   * echo, seen only by the invoker), then reconstruct the `/text` form and feed it
   * through the SAME onMessage path as a typed command — so routing, authz, the reply,
   * and the tappable cards all reuse handleCommand. The real output posts to the
   * channel/thread (public), matching how a typed `/command` behaves today.
   */
  private onSlashCommand(interaction: ChatInputCommandInteraction): void {
    const text = this.slashCommandText(interaction)
    void interaction.reply({ content: text, flags: MessageFlags.Ephemeral }).catch(() => {})
    try {
      const msg = normalizeDiscordMessage(this.slashToLike(interaction, text), { traceId: this.deps.newTraceId() })
      this.deps.log?.debug(`discord: slash ${text} ch=${msg.channel} user=${msg.sender.id}`)
      this.deps.onMessage(msg)
    } catch (err) {
      this.deps.log?.debug(`discord: slash command failed: ${(err as Error).message}`)
    }
  }

  /** Reconstruct a slash invocation into its `/text` form (`/models opus`, `/queue do X`)
   *  so parseCommand handles it exactly like a typed message. Options are appended in
   *  declaration order; our control commands take at most one. */
  private slashCommandText(interaction: ChatInputCommandInteraction): string {
    const args = interaction.options.data
      .map((o) => (o.value === undefined || o.value === null ? '' : String(o.value)))
      .join(' ')
      .trim()
    return args ? `/${interaction.commandName} ${args}` : `/${interaction.commandName}`
  }

  /** Adapt a slash interaction to the pure normalizer's plain-object view (text = the
   *  reconstructed command). Mirrors toLike; no attachments/mentions on a command. */
  private slashToLike(interaction: ChatInputCommandInteraction, text: string): DiscordMessageLike {
    return {
      id: interaction.id,
      channelId: interaction.channelId,
      url: `https://discord.com/channels/${interaction.guildId ?? '@me'}/${interaction.channelId}`,
      content: text,
      authorId: interaction.user.id,
      authorIsBot: interaction.user.bot,
      authorAvatarUrl: interaction.user.displayAvatarURL(),
      inGuild: interaction.inGuild(),
      isThread: interaction.channel?.isThread() ?? false,
      mentionUserIds: [],
      ...(interaction.channel?.isThread() && interaction.channel.parentId
        ? { parentChannelId: interaction.channel.parentId }
        : {}),
      attachments: []
    }
  }

  /** Adapt a live gateway Message to the pure normalizer's plain-object view. */
  private toLike(message: Message): DiscordMessageLike {
    return {
      id: message.id,
      channelId: message.channelId,
      url: message.url,
      content: message.content,
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      authorAvatarUrl: message.author.displayAvatarURL(),
      inGuild: message.inGuild(),
      isThread: message.channel.isThread(),
      mentionUserIds: [...message.mentions.users.keys()],
      // The gateway ships the mentioned users inline — humanize `<@id>` to a real
      // handle without any extra REST call.
      mentionUserNames: Object.fromEntries(
        [...message.mentions.users.values()].map((u) => [u.id, u.globalName ?? u.username])
      ),
      ...(message.channel.isThread() && message.channel.parentId ? { parentChannelId: message.channel.parentId } : {}),
      attachments: [...message.attachments.values()].map((a) => ({
        id: a.id,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        url: a.url,
        proxyUrl: a.proxyURL
      }))
    }
  }

  /** Fetch a channel and confirm it can send messages. */
  private async sendableChannel(channelId: string): Promise<Sendable | null> {
    try {
      const ch = await this.client.channels.fetch(channelId)
      if (ch && 'send' in ch && typeof (ch as { send?: unknown }).send === 'function') return ch as Sendable
      return null
    } catch (err) {
      this.rememberPermissionIssue(err, channelId)
      this.deps.log?.debug(`discord: channel fetch failed (ch=${channelId}): ${(err as Error).message}`)
      return null
    }
  }

  private rememberPermissionIssue(err: unknown, channel?: string): boolean {
    const issue = discordPermissionIssueFrom(err)
    if (!issue) return false
    if (!this.loggedPermissionIssues.has(issue)) {
      this.loggedPermissionIssues.add(issue)
      this.deps.log?.warn(`discord: bot permission update required (${issue})`)
    }
    // OAuth scope is application-wide. Access/permission errors discovered during a
    // channel operation stay on that channel; calls without a channel (command
    // registration) remain global. Keep both layers so a failed channel notice cannot
    // replace an earlier unsent global repair.
    if (issue === 'missing-oauth-scope' || !channel) {
      this.hasGlobalPermissionIssue = true
    } else if (!this.permissionIssueChannels.has(channel)) {
      this.permissionIssueChannels.add(channel)
      this.permissionNoticeRetryAt.delete(`channel:${channel}`)
    }
    return true
  }

  private pendingPermissionKey(channel: string): string | undefined {
    if (this.hasGlobalPermissionIssue) return 'global'
    return this.permissionIssueChannels.has(channel) ? `channel:${channel}` : undefined
  }

  private permissionUpdateUrl(): string | undefined {
    const applicationId = this.client.application?.id ?? this.botUserId
    if (!/^\d{17,20}$/.test(applicationId)) return undefined
    const params = new URLSearchParams({
      client_id: applicationId,
      scope: 'bot applications.commands',
      permissions: DISCORD_BOT_PERMISSIONS
    })
    return `https://discord.com/oauth2/authorize?${params.toString()}`
  }

  /** Post one Devin-style permission notice. `target` distinguishes an already-failed
   * channel lookup (`null`) from a caller that has not fetched the channel yet
   * (`undefined`). The in-flight claim is set before any await so concurrent thread or
   * chrome failures cannot race into duplicate notices. */
  private async postPermissionUpdateNotice(channel: string, target?: Sendable | null): Promise<void> {
    const pendingKey = this.pendingPermissionKey(channel)
    if (
      !pendingKey ||
      this.permissionNoticeSent ||
      this.permissionNoticeInFlight ||
      Date.now() < (this.permissionNoticeRetryAt.get(pendingKey) ?? 0)
    )
      return
    const updateUrl = this.permissionUpdateUrl()
    if (!updateUrl) return

    this.permissionNoticeInFlight = true
    try {
      const ch = target === undefined ? await this.sendableChannel(channel) : target
      if (!ch) {
        this.permissionNoticeRetryAt.set(
          this.pendingPermissionKey(channel) ?? pendingKey,
          Date.now() + PERMISSION_NOTICE_RETRY_MS
        )
        return
      }
      await ch.send(buildPermissionUpdateNotice(updateUrl))
      this.permissionNoticeSent = true
    } catch (err) {
      this.rememberPermissionIssue(err, channel)
      this.permissionNoticeRetryAt.set(
        this.pendingPermissionKey(channel) ?? pendingKey,
        Date.now() + PERMISSION_NOTICE_RETRY_MS
      )
      this.deps.log?.debug(`discord: permission update notice failed (ch=${channel}): ${(err as Error).message}`)
    } finally {
      this.permissionNoticeInFlight = false
    }
  }

  /**
   * Open a thread off a channel message so a turn's reply + chrome live in the thread
   * rather than the parent channel (Slack-parity — see daemon's Discord ingress). The
   * created thread's id EQUALS the source message id (a Discord guarantee), so the
   * caller re-keys the session onto it and follow-ups posted in the thread (which
   * arrive with `channelId` = thread id) continue the same session. Best-effort:
   * returns the thread id, or undefined when the message/channel can't be resolved or
   * the bot lacks the Create Public Threads permission (caller then replies in-channel).
   */
  async createThread(channelId: string, messageId: string, name: string): Promise<string | undefined> {
    let ch: Sendable | null = null
    try {
      ch = await this.sendableChannel(channelId)
      if (!ch?.messages) return undefined
      const message = await ch.messages.fetch(messageId)
      const thread = await message.startThread({ name: name.slice(0, 100) || 'Agent thread' })
      return thread.id
    } catch (err) {
      if (this.rememberPermissionIssue(err, channelId)) await this.postPermissionUpdateNotice(channelId, ch)
      this.deps.log?.debug(`discord: createThread failed (ch=${channelId} msg=${messageId}): ${(err as Error).message}`)
      return undefined
    }
  }

  /** Discord threads are provider channels, so the normalized `{ channel, thread }`
   * pair maps to a concrete send target by preferring `thread`. */
  private replyTarget(channel: string, thread?: string): string {
    return thread || channel
  }

  /** Post a message to the normalized channel/thread coordinates. Long text is
   * chunked to the 2000-char cap; returns the FIRST resulting message id. */
  async postMessage(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
    const target = this.replyTarget(channel, threadTs)
    return this.queue.enqueue(async () => {
      const ch = await this.sendableChannel(target)
      if (!ch) {
        await this.postPermissionUpdateNotice(target, ch)
        return undefined
      }
      let firstId: string | undefined
      for (const chunk of chunkForDiscord(text)) {
        const sent = await ch.send({ content: chunk }).catch((err: Error) => {
          this.rememberPermissionIssue(err, target)
          this.deps.log?.debug(`discord: send failed (ch=${target}): ${err.message}`)
          return null
        })
        if (sent && firstId === undefined) firstId = sent.id
      }
      await this.postPermissionUpdateNotice(target, ch)
      return firstId
    })
  }

  /**
   * Put a file into a channel — the mirror of {@link downloadFile}. Discord carries bytes on
   * the message itself, so the file and its caption are ONE post and the id it returns
   * anchors like any other. Over-cap text keeps the existing chunking, with the file riding
   * the first chunk so the caption reads above it.
   */
  async uploadFile(
    channel: string,
    file: { bytes: Buffer; name: string; mimeType?: string },
    comment?: string,
    anchor?: UploadAnchor,
    _identity?: unknown
  ): Promise<UploadOutcome> {
    const target = this.replyTarget(channel, anchor?.thread)
    const task: Promise<UploadOutcome> = this.queue.enqueue(async () => {
      const ch = await this.sendableChannel(target)
      if (!ch) {
        await this.postPermissionUpdateNotice(target, ch)
        return { ok: false, reason: 'not_found' }
      }
      const chunks = comment ? chunkForDiscord(comment) : ['']
      let firstId: string | undefined
      let attached = false
      let dropped = false
      let firstErr: unknown
      for (const chunk of chunks) {
        const payload: SendPayload = {
          ...(chunk ? { content: chunk } : {}),
          ...(attached ? {} : { files: [{ attachment: file.bytes, name: file.name }] }),
          // A model-authored caption must not be able to ping — <@id>/@everyone resolve in
          // plain content, and suppression is Discord-native rather than string surgery.
          allowedMentions: { parse: [] }
        }
        const sent = await ch.send(payload).catch((err: Error) => {
          firstErr = err
          this.rememberPermissionIssue(err, target)
          this.deps.log?.debug(`discord: uploadFile failed (ch=${target}): ${err.message}`)
          return null
        })
        // Nothing posted yet ⇒ nothing landed at all — the `ok: false` contract. A later
        // chunk failing is a partial: the file is in the chat, so say what was lost rather
        // than claim the send never happened.
        if (!sent && !attached) return { ok: false, reason: classifyDiscordUploadError(firstErr) }
        if (!sent) dropped = true
        attached = true
        if (sent && firstId === undefined) firstId = sent.id
      }
      await this.postPermissionUpdateNotice(target, ch)
      return {
        ok: true,
        ...(firstId !== undefined ? { messageId: firstId } : {}),
        ...(dropped ? { warning: 'the file was sent, but part of its caption did not post' } : {})
      }
    })
    return task.catch((err) => ({
      ok: false,
      reason: isSendQueueTimeout(err) ? 'indeterminate' : 'platform_error'
    }))
  }

  /**
   * Post a "chrome" message (progress / plan / reasoning / tool-output / status bar)
   * with optional message components + returns the new message id for later in-place
   * edits. When `sessionKey` is given (the status bar), the message is registered so
   * its button interactions resolve back to the session. Best-effort: swallows send
   * errors (chrome must never break a turn). Only the first 2000-char chunk is sent
   * (chrome is short; the agent's full reply goes through postMessage).
   */
  async postChrome(
    channel: string,
    text: string,
    opts: { threadTs?: string; keyboard?: DiscordComponents; sessionKey?: string } = {}
  ): Promise<string | undefined> {
    const target = this.replyTarget(channel, opts.threadTs)
    return this.queue.enqueue(async () => {
      let ch: Sendable | null = null
      try {
        ch = await this.sendableChannel(target)
        if (!ch) {
          await this.postPermissionUpdateNotice(target, ch)
          return undefined
        }
        const payload: SendPayload = { content: chunkForDiscord(text)[0] ?? '' }
        if (opts.keyboard) payload.components = opts.keyboard
        const sent = await ch.send(payload)
        if (sent && opts.sessionKey) this.statusKeys.set(`${target}:${sent.id}`, opts.sessionKey)
        await this.postPermissionUpdateNotice(target, ch)
        return sent?.id
      } catch (err) {
        this.rememberPermissionIssue(err, target)
        await this.postPermissionUpdateNotice(target, ch)
        this.deps.log?.debug(`discord: send (chrome) failed (ch=${target}): ${(err as Error).message}`)
        return undefined
      }
    })
  }

  /** Edit a previously-posted message in place. Best-effort. Only the first chunk is
   *  shown (overflow beyond 2000 chars is dropped — progress messages are short). */
  async updateMessage(
    channel: string,
    messageId: string,
    text: string,
    opts: { threadTs?: string; keyboard?: DiscordComponents } = {}
  ): Promise<void> {
    const target = this.replyTarget(channel, opts.threadTs)
    await this.queue.enqueue(async () => {
      let ch: Sendable | null = null
      try {
        ch = await this.sendableChannel(target)
        if (!ch?.messages) {
          await this.postPermissionUpdateNotice(target, ch)
          return
        }
        const msg = await ch.messages.fetch(messageId)
        const payload: SendPayload = { content: chunkForDiscord(text)[0] ?? '' }
        if (opts.keyboard) payload.components = opts.keyboard
        await msg.edit(payload)
      } catch (err) {
        this.rememberPermissionIssue(err, target)
        this.deps.log?.debug(`discord: edit failed (ch=${target} id=${messageId}): ${(err as Error).message}`)
      }
      await this.postPermissionUpdateNotice(target, ch)
    })
  }

  /** Best-effort transient "typing…" indicator (Discord's analog of a status bar).
   *  Not queued — a fire-and-forget hint that expires on its own (~10s). */
  async sendChatAction(channel: string, threadTs?: string): Promise<void> {
    const target = this.replyTarget(channel, threadTs)
    let ch: Sendable | null = null
    try {
      ch = await this.sendableChannel(target)
      if (ch?.sendTyping) await ch.sendTyping()
    } catch (err) {
      this.rememberPermissionIssue(err, target)
      this.deps.log?.debug(`discord: sendTyping failed (ch=${target}): ${(err as Error).message}`)
    }
    await this.postPermissionUpdateNotice(target, ch)
  }

  /** Turn-start acknowledgement on the message that fired the turn. Not queued, for the
   *  same reason the typing hint is not. An install whose invite predates ADD_REACTIONS
   *  degrades to nothing visible. */
  async react(container: string, messageId: string, intent: PlatformReactionIntent): Promise<void> {
    try {
      // Fetched directly rather than through `sendableChannel`: reacting needs the message,
      // not permission to post in the channel it lives in.
      const ch = (await this.client.channels.fetch(container)) as Pick<Sendable, 'messages'> | null
      const message = await ch?.messages?.fetch(messageId)
      await message?.react(DISCORD_REACTION_EMOJI[intent])
    } catch (err) {
      this.rememberPermissionIssue(err, container)
      this.deps.log?.debug(`discord: react failed (ch=${container} msg=${messageId}): ${(err as Error).message}`)
    }
  }

  /**
   * Download a Discord attachment by its CDN url (carried in Attachment.sourceUrl).
   * Discord CDN urls are PUBLIC (no auth) — a plain bounded fetch, up to `maxBytes`.
   * Returns null on any failure / over-cap (best-effort; a failed attachment degrades
   * to a resource_link, never breaks the prompt). Bytes stay daemon-local (§9.2).
   */
  async downloadFile(sourceUrl: string, maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES): Promise<Buffer | null> {
    try {
      const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) {
        this.deps.log?.debug(`discord: downloadFile → HTTP ${res.status}`)
        return null
      }
      const declared = Number(res.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        this.deps.log?.debug(`discord: downloadFile skipped — ${declared} bytes > cap ${maxBytes}`)
        return null
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > maxBytes) {
        this.deps.log?.debug(`discord: downloadFile discarded — ${buf.byteLength} bytes > cap ${maxBytes}`)
        return null
      }
      return buf
    } catch (err) {
      this.deps.log?.debug(`discord: downloadFile failed: ${(err as Error).message}`)
      return null
    }
  }

  // ── MCP MessageGateway: read helpers backing the injected channel tools ──

  /** Fetch one bounded page of channel messages using Discord's `before` cursor. */
  async getChannelHistory(
    channel: string,
    options: PlatformChannelHistoryOptions = {}
  ): Promise<PlatformChannelHistoryPage> {
    const limit = Math.min(
      Math.max(options.limit ?? DISCORD_CHANNEL_HISTORY_DEFAULT_LIMIT, 1),
      DISCORD_CHANNEL_HISTORY_MAX_LIMIT
    )
    try {
      const oldest = options.oldest === undefined ? undefined : Number(options.oldest)
      const latest = options.latest === undefined ? undefined : Number(options.latest)
      if ((oldest !== undefined && !Number.isFinite(oldest)) || (latest !== undefined && !Number.isFinite(latest))) {
        throw new Error('invalid timestamp bound')
      }

      const ch = await this.client.channels.fetch(channel)
      if (!ch?.isTextBased()) throw new Error('channel does not expose message history')
      const fetched = await ch.messages.fetch({ limit, ...(options.cursor ? { before: options.cursor } : {}) })
      const raw = [...fetched.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp)
      const messages = raw
        .filter(
          (message) =>
            (oldest === undefined || message.createdTimestamp >= oldest) &&
            (latest === undefined || message.createdTimestamp <= latest)
        )
        .map((message) => {
          const replyCount = message.thread?.messageCount
          return {
            sender: message.author.id,
            ts: String(message.createdTimestamp),
            text: humanizeDiscordText(
              message.content,
              Object.fromEntries(
                [...message.mentions.users.values()].map((user) => [user.id, user.globalName ?? user.username])
              )
            ),
            isBot: message.author.bot,
            ...(message.thread ? { threadTs: message.thread.id } : {}),
            ...(typeof replyCount === 'number' && replyCount > 0 ? { replyCount } : {})
          }
        })

      const reachedOldest = oldest !== undefined && raw.some((message) => message.createdTimestamp <= oldest)
      const nextCursor = raw.length === limit && !reachedOldest ? raw.at(-1)?.id : undefined
      return {
        messages,
        hasMore: nextCursor !== undefined,
        ...(nextCursor ? { nextCursor } : {})
      }
    } catch (err) {
      this.rememberPermissionIssue(err, channel)
      const code = discordErrorCode(err)
      this.deps.log?.debug(`discord: channel history failed (ch=${channel}): ${code ?? 'unknown'}`)
      throw new Error(code === undefined ? 'Discord channel history failed' : `Discord channel history failed: ${code}`)
    }
  }

  async getChannelInfo(channel: string): Promise<{
    id: string
    name?: string
    isIm?: boolean
    isPrivate?: boolean
    parentId?: string
    parentName?: string
    spaceId?: string
    spaceName?: string
  }> {
    const ch = await this.client.channels.fetch(channel).catch(() => null)
    const c = ch as
      | (Channel & {
          name?: string
          isDMBased?: () => boolean
          isThread?: () => boolean
          parentId?: string | null
          guildId?: string | null
          guild?: { id: string; name?: string } | null
        })
      | null
    const isIm = typeof c?.isDMBased === 'function' ? c.isDMBased() : false
    // A thread's own name is the turn title the bot generated; readers that want the
    // enclosing channel ("#general") get it as `parentId`/`parentName`.
    const isThread = typeof c?.isThread === 'function' && c.isThread()
    const parentId = isThread && c?.parentId ? c.parentId : undefined
    const parentName = parentId ? await this.channelName(parentId) : undefined
    // The guild this conversation sits in. A bot in several servers reaches a
    // "#general" in each of them, so the console can only tell the rows apart by
    // the server that encloses them. DMs have no guild.
    const spaceId = c?.guild?.id ?? c?.guildId ?? undefined
    const spaceName = c?.guild?.name
    return {
      id: channel,
      ...(c?.name ? { name: c.name } : {}),
      ...(parentId ? { parentId } : {}),
      ...(parentName ? { parentName } : {}),
      ...(spaceId ? { spaceId } : {}),
      ...(spaceName ? { spaceName } : {}),
      isIm,
      // A guild channel's visibility depends on role overwrites we don't resolve here;
      // treat non-DM guild channels as non-private best-effort.
      isPrivate: false
    }
  }

  /** Name of one channel id (cache-first via channels.fetch), undefined if unreachable. */
  private async channelName(channel: string): Promise<string | undefined> {
    const ch = await this.client.channels.fetch(channel).catch(() => null)
    return (ch as (Channel & { name?: string }) | null)?.name
  }

  /** Discord bots cannot cheaply enumerate a channel's full member list — return []
   *  best-effort. Names are resolved via getUserProfile / inbound messages instead. */
  async listMembers(_channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]> {
    return []
  }

  /**
   * Leave a GUILD. Discord gives a bot no per-channel membership to withdraw from —
   * it joins a server and sees that server's channels through permissions — so the
   * smallest thing it can leave is the whole server, and every channel of that guild
   * goes with it. Callers must not offer this as "leave this channel".
   *
   * Throws Discord's own refusal, and an unknown guild id is an error rather than a
   * silent success: reporting "left" for a server we never resolved would retire
   * console rows for a bot that is still in it.
   */
  async leaveSpace(spaceId: string): Promise<void> {
    const guild = this.client.guilds.cache.get(spaceId) ?? (await this.client.guilds.fetch(spaceId))
    await guild.leave()
    this.deps.log?.debug(`discord: left guild ${spaceId}`)
  }

  /** Text channels the bot can see across its guilds (from the ready cache). */
  async listChannels(): Promise<{ id: string; name?: string; isPrivate?: boolean }[]> {
    try {
      const out: { id: string; name?: string; isPrivate?: boolean }[] = []
      for (const guild of this.client.guilds.cache.values()) {
        for (const ch of guild.channels.cache.values()) {
          if (!ch.isTextBased()) continue
          out.push({ id: ch.id, name: ch.name, isPrivate: false })
          if (out.length >= CHANNEL_CAP) return out
        }
      }
      return out
    } catch (err) {
      this.deps.log?.debug(`discord: listChannels failed: ${(err as Error).message}`)
      return []
    }
  }

  async getUserProfile(
    user: string
  ): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean; avatarUrl?: string }> {
    try {
      const u = await this.client.users.fetch(user)
      return {
        id: user,
        name: u.username,
        realName: u.globalName ?? undefined,
        isBot: u.bot,
        avatarUrl: u.displayAvatarURL()
      }
    } catch {
      return { id: user }
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy()
  }
}
