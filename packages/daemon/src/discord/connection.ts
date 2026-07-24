import {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  type Message,
  type Channel,
  type ChatInputCommandInteraction
} from 'discord.js'
import type { Agent } from '../agents/agent-schema.js'
import type { NormalizedMessage } from '../messages/normalized.js'
import type { Logger } from '../log.js'
import { SlackSendQueue } from '../slack/send-queue.js'
import { normalizeDiscordMessage, type DiscordMessageLike } from './normalize.js'
import { DISCORD_APP_COMMANDS } from './app-commands.js'
import {
  parseDiscordCallback,
  parseDiscordSelect,
  chunkForDiscord,
  type DiscordComponents,
  type DiscordSelectKind
} from './render.js'

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
export function consolidateDiscord(agents: Agent[]): Map<string, ConsolidatedDiscordGroup> {
  const groups = new Map<string, ConsolidatedDiscordGroup>()
  for (const a of agents) {
    for (const int of a.integrations) {
      if (int.platform !== 'discord') continue
      const k = int.discord.botToken
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
  onStatusAction?: (a: { kind: 'cancel' | 'set-fast'; sessionKey: string; fastMode?: boolean }) => void
  /** Fired when a user taps a select-card button (`/models` `/effort` `/permission`).
   *  Applies the choice for `sessionKey` and returns the re-rendered card so the
   *  connection edits the tapped message in place (the current option now flagged).
   *  Returns undefined to leave the card unchanged (no session / stale option). */
  onSelectAction?: (a: {
    kind: DiscordSelectKind
    index: number
    sessionKey: string
  }) => { text: string; components: DiscordComponents } | undefined
  newTraceId: () => string
  log?: Logger
  /** Min spacing (ms) between outbound writes (serialized send-queue). Tests pass 0. */
  sendIntervalMs?: number
}

const DEFAULT_MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
/** Cap on channels enumerated per listChannels call (bounds the response). */
const CHANNEL_CAP = 200

/** The discord.js message-send payload we use (content + optional components). */
type SendPayload = { content: string; components?: DiscordComponents }
type Sendable = Channel & {
  send: (payload: SendPayload) => Promise<Message>
  sendTyping?: () => Promise<void>
  messages?: { fetch: (id: string) => Promise<Message> }
}

export class DiscordConnection {
  private client: Client
  // All outbound writes funnel through one queue so streamed edits are FIFO-ordered
  // per connection (discord.js handles REST rate limits, but the queue keeps a
  // post-then-edit pair from racing on the same progress message).
  private queue: SlackSendQueue
  // Status-component message → session key, so a button interaction (which carries
  // only channel+message id, not the session key) resolves back to its session.
  // Keyed `${channelId}:${messageId}`.
  private statusKeys = new Map<string, string>()
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
    this.queue = new SlackSendQueue(deps.sendIntervalMs ?? 350)
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // privileged: needed to read message text
        GatewayIntentBits.DirectMessages
      ]
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
    client.on(Events.InteractionCreate, (interaction) => {
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
      // Status-bar verbs (Cancel / Fast) — fire-and-forget onto the session.
      const status = parseDiscordCallback(interaction.customId)
      if (status) {
        if (status.kind === 'cancel') this.deps.onStatusAction?.({ kind: 'cancel', sessionKey })
        else this.deps.onStatusAction?.({ kind: 'set-fast', sessionKey, fastMode: status.fastMode })
        return
      }
      // Select-card taps (model / effort / permission): apply + re-render the card in place.
      const sel = parseDiscordSelect(interaction.customId)
      if (sel && this.deps.onSelectAction) {
        const rendered = this.deps.onSelectAction({ kind: sel.kind, index: sel.index, sessionKey })
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
      content: text,
      authorId: interaction.user.id,
      authorIsBot: interaction.user.bot,
      inGuild: interaction.inGuild(),
      isThread: interaction.channel?.isThread() ?? false,
      mentionUserIds: [],
      attachments: []
    }
  }

  /** Adapt a live gateway Message to the pure normalizer's plain-object view. */
  private toLike(message: Message): DiscordMessageLike {
    return {
      id: message.id,
      channelId: message.channelId,
      content: message.content,
      authorId: message.author.id,
      authorIsBot: message.author.bot,
      inGuild: message.inGuild(),
      isThread: message.channel.isThread(),
      mentionUserIds: [...message.mentions.users.keys()],
      attachments: [...message.attachments.values()].map((a) => ({
        id: a.id,
        name: a.name,
        contentType: a.contentType,
        size: a.size,
        url: a.url
      }))
    }
  }

  /** Fetch a channel and confirm it can send messages. */
  private async sendableChannel(channelId: string): Promise<Sendable | null> {
    const ch = await this.client.channels.fetch(channelId).catch(() => null)
    if (ch && 'send' in ch && typeof (ch as { send?: unknown }).send === 'function') return ch as Sendable
    return null
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
    try {
      const ch = await this.sendableChannel(channelId)
      if (!ch?.messages) return undefined
      const message = await ch.messages.fetch(messageId)
      const thread = await message.startThread({ name: name.slice(0, 100) || 'Agent thread' })
      return thread.id
    } catch (err) {
      this.deps.log?.debug(`discord: createThread failed (ch=${channelId} msg=${messageId}): ${(err as Error).message}`)
      return undefined
    }
  }

  /**
   * Post a message. `channel` is already the concrete channel/thread id (Discord
   * threads are their own channels — see normalize.ts), so `threadTs` is unused —
   * the session channel IS the reply target. Long text is chunked to the 2000-char
   * cap; returns the FIRST resulting message id.
   */
  async postMessage(channel: string, text: string, _threadTs?: string): Promise<string | undefined> {
    return this.queue.enqueue(async () => {
      const ch = await this.sendableChannel(channel)
      if (!ch) return undefined
      let firstId: string | undefined
      for (const chunk of chunkForDiscord(text)) {
        const sent = await ch.send({ content: chunk }).catch((err: Error) => {
          this.deps.log?.debug(`discord: send failed (ch=${channel}): ${err.message}`)
          return null
        })
        if (sent && firstId === undefined) firstId = sent.id
      }
      return firstId
    })
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
    return this.queue.enqueue(async () => {
      try {
        const ch = await this.sendableChannel(channel)
        if (!ch) return undefined
        const payload: SendPayload = { content: chunkForDiscord(text)[0] ?? '' }
        if (opts.keyboard) payload.components = opts.keyboard
        const sent = await ch.send(payload)
        if (sent && opts.sessionKey) this.statusKeys.set(`${channel}:${sent.id}`, opts.sessionKey)
        return sent?.id
      } catch (err) {
        this.deps.log?.debug(`discord: send (chrome) failed (ch=${channel}): ${(err as Error).message}`)
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
    opts: { keyboard?: DiscordComponents } = {}
  ): Promise<void> {
    await this.queue.enqueue(async () => {
      try {
        const ch = await this.sendableChannel(channel)
        if (!ch?.messages) return
        const msg = await ch.messages.fetch(messageId)
        const payload: SendPayload = { content: chunkForDiscord(text)[0] ?? '' }
        if (opts.keyboard) payload.components = opts.keyboard
        await msg.edit(payload)
      } catch (err) {
        this.deps.log?.debug(`discord: edit failed (ch=${channel} id=${messageId}): ${(err as Error).message}`)
      }
    })
  }

  /** Best-effort transient "typing…" indicator (Discord's analog of a status bar).
   *  Not queued — a fire-and-forget hint that expires on its own (~10s). */
  async sendChatAction(channel: string): Promise<void> {
    try {
      const ch = await this.sendableChannel(channel)
      if (ch?.sendTyping) await ch.sendTyping()
    } catch (err) {
      this.deps.log?.debug(`discord: sendTyping failed (ch=${channel}): ${(err as Error).message}`)
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

  async getChannelInfo(channel: string): Promise<{ id: string; name?: string; isIm?: boolean; isPrivate?: boolean }> {
    const ch = await this.client.channels.fetch(channel).catch(() => null)
    const c = ch as (Channel & { name?: string; isDMBased?: () => boolean }) | null
    const isIm = typeof c?.isDMBased === 'function' ? c.isDMBased() : false
    return {
      id: channel,
      ...(c?.name ? { name: c.name } : {}),
      isIm,
      // A guild channel's visibility depends on role overwrites we don't resolve here;
      // treat non-DM guild channels as non-private best-effort.
      isPrivate: false
    }
  }

  /** Discord bots cannot cheaply enumerate a channel's full member list — return []
   *  best-effort. Names are resolved via getUserProfile / inbound messages instead. */
  async listMembers(_channel: string): Promise<{ id: string; name?: string; isBot?: boolean }[]> {
    return []
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

  async getUserProfile(user: string): Promise<{ id: string; name?: string; realName?: string; isBot?: boolean }> {
    try {
      const u = await this.client.users.fetch(user)
      return { id: user, name: u.username, realName: u.globalName ?? undefined, isBot: u.bot }
    } catch {
      return { id: user }
    }
  }

  async stop(): Promise<void> {
    await this.client.destroy()
  }
}
