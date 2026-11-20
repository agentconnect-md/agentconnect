// One agent address's daemon connection (email-integration.md §5.6, §6): no socket of its own, its reads served from the daemon's records and its sends made through the relay.
import { renderEmailHeaderBlock } from '@agentconnect.md/message'
import {
  EMAIL_MESSAGE_ID_MAX,
  EMAIL_MESSAGE_ID_PATTERN,
  EMAIL_PLATFORM,
  EMAIL_STARTED_TAG_PATTERN,
  WireEmailAdapterExt,
  type IntegrationEmailConfig,
  type RdPlatformReply,
  type WireEmailCall,
  type WireEmailMailbox
} from '@agentconnect.md/protocol'
import type { LoadedAgent } from '../../agents/load-agents.js'
import type { EmailMessageRow, EmailMessages } from '../../store/email-messages.js'
import type {
  PlatformChannelHistoryOptions,
  PlatformChannelHistoryPage,
  PlatformChannelInfo,
  PlatformConnection,
  PlatformMemberRef,
  PlatformThreadMessage,
  PlatformThreadWindow,
  PlatformUserProfile
} from '../contract.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { PlatformRelayUnsent, type PlatformRelay } from '../platform-relay.js'
import type { EmailMembers } from './members.js'
import type { EmailConversationState, EmailKnownMessage, EmailPlacementIndex, EmailStartedThread } from './threading.js'

/** One agent address and the integrations that serve it; an address is never shared, so a group holds one. */
export interface EmailConnectionGroup {
  key: string
  config: IntegrationEmailConfig
  integrations: { agentId: string; integrationId: string }[]
}

/** Every Email integration of the roster, keyed by its address and the bot row the relay authorizes a send against. */
export function consolidateEmail(agents: readonly LoadedAgent[]): Map<string, EmailConnectionGroup> {
  const groups = new Map<string, EmailConnectionGroup>()
  for (const agent of agents)
    for (const integration of agent.integrations) {
      const config = platformIntegrationConfig('email', integration)
      if (!config) continue
      const key = `${config.address}\u001f${config.botId}`
      const group = groups.get(key) ?? { key, config, integrations: [] }
      group.integrations.push({ agentId: agent.id, integrationId: integration.id })
      groups.set(key, group)
    }
  return groups
}

/** What a received mail's index row keeps beside its header fields: who it reached, which the fence and a reply read. */
export interface EmailStoredMail extends WireEmailAdapterExt {
  participants: string[]
}

/** What a sent mail's index row keeps: whom it went to and under which subject, and whether it was a mail the agent started (§6.4). */
export interface EmailStoredSent {
  from: WireEmailMailbox
  to: WireEmailMailbox[]
  cc: WireEmailMailbox[]
  subject: string
  started?: true
}

/** A received row's stored mail, read defensively because the row is persisted; undefined for anything unreadable. */
export function storedMailOf(row: Pick<EmailMessageRow, 'mail' | 'direction'>): EmailStoredMail | undefined {
  if (row.direction !== 'received' || !row.mail) return undefined
  try {
    const value = JSON.parse(row.mail) as { participants?: unknown }
    const parsed = WireEmailAdapterExt.safeParse(value)
    const participants = Array.isArray(value.participants)
      ? value.participants.filter((entry): entry is string => typeof entry === 'string')
      : undefined
    return parsed.success && participants?.length ? { ...parsed.data, participants } : undefined
  } catch {
    return undefined
  }
}

/** A sent row's stored mail, read defensively because the row is persisted; undefined for anything unreadable. */
export function storedSentOf(row: Pick<EmailMessageRow, 'mail' | 'direction'>): EmailStoredSent | undefined {
  if (row.direction !== 'sent' || !row.mail) return undefined
  try {
    const value = JSON.parse(row.mail) as Partial<EmailStoredSent>
    return value.from && Array.isArray(value.to) && Array.isArray(value.cc) && typeof value.subject === 'string'
      ? (value as EmailStoredSent)
      : undefined
  } catch {
    return undefined
  }
}

/** How one send settled: delivered to the provider, never sent, or cut off where it may have landed. */
export type EmailSendResult =
  | { outcome: 'sent'; messageId?: string }
  | { outcome: 'unsent'; reason: string }
  | { outcome: 'unknown'; reason: string }

/** The provider's id for a sent mail, from the relay's answer when it names one; any shape it does not recognize reads as none. */
export function providerMessageId(body: unknown): string | undefined {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  const top = record(body)
  const result = record(top?.result)
  for (const candidate of [
    result?.messageId,
    result?.message_id,
    result?.id,
    top?.messageId,
    top?.message_id,
    top?.id
  ]) {
    if (typeof candidate !== 'string') continue
    const id = candidate.trim().replace(/^<|>$/g, '')
    if (id && id.length <= EMAIL_MESSAGE_ID_MAX && EMAIL_MESSAGE_ID_PATTERN.test(id) && id.includes('@')) return id
  }
  return undefined
}

// The provider's own words on a refusal, cut short; the status alone when it gave none.
function providerReason(status: number, body: unknown): string {
  const errors = (body as { errors?: { message?: unknown }[] } | undefined)?.errors
  const message = Array.isArray(errors) && typeof errors[0]?.message === 'string' ? errors[0].message : undefined
  const text = message?.replace(/\s+/g, ' ').trim().slice(0, 200)
  return text ? `the mail provider refused it (${status}: ${text})` : `the mail provider refused it (${status})`
}

/** One relay answer read as a send's outcome (§6.2): `refused` and `unavailable` never reached the provider, and a gateway timeout may have. */
export function emailSendOutcome(reply: RdPlatformReply): EmailSendResult & { retryable?: boolean } {
  if (reply.outcome === 'unavailable')
    return {
      outcome: 'unsent',
      reason: `the relay could not send it (${reply.reason ?? 'unavailable'})`,
      retryable: true
    }
  if (reply.outcome === 'refused')
    return {
      outcome: 'unsent',
      reason: `the relay refused it (${reply.reason ?? 'refused'})`,
      ...(reply.retryable ? { retryable: true } : {})
    }
  const payload = reply.payload as { status?: unknown; body?: unknown } | undefined
  const status = typeof payload?.status === 'number' ? payload.status : undefined
  if (status === undefined) return { outcome: 'unknown', reason: 'the relay answered an unreadable result' }
  if (status >= 200 && status < 300) {
    const messageId = providerMessageId(payload?.body)
    return { outcome: 'sent', ...(messageId ? { messageId } : {}) }
  }
  if (status === 504)
    return { outcome: 'unknown', reason: 'the mail provider did not answer, so it may have been sent' }
  return { outcome: 'unsent', reason: providerReason(status, payload?.body) }
}

/** How many times a send nothing reached the provider with is tried, and the waits between. */
const SEND_ATTEMPT_WAITS_MS = [1_000, 3_000]

export interface EmailConnectionDeps {
  group: EmailConnectionGroup
  /** The daemon's relays, resolved per call: they start with the Control Plane's roster. */
  relay?: PlatformRelay
  /** The mail index and the transcript rows it names. */
  store(): {
    emailMessages: EmailMessages
    admittedTextRowsByTs(
      agentId: string,
      channel: string,
      keys: readonly string[]
    ): Promise<{ ts: string; sender: string; text: string; eventTimeUs: number }[]>
  }
  /** The transcript channel a conversation's rows are kept under on this connection. */
  transcriptChannel(channel: string): string
  /** The member question, which a started mail asks of its recipients (§6.4). */
  members?: EmailMembers
  sleep?(ms: number): Promise<void>
}

const DEFAULT_HISTORY_LIMIT = 20
const MAX_HISTORY_LIMIT = 100

export class EmailConnection implements PlatformConnection, EmailPlacementIndex {
  readonly key: string
  /** The agent's own address: what a group mail names it by, and the identity mention routing matches. */
  readonly botUserId: string
  readonly address: string
  readonly botId: string

  constructor(private readonly deps: EmailConnectionDeps) {
    this.key = deps.group.key
    this.address = deps.group.config.address
    this.botUserId = this.address
    this.botId = deps.group.config.botId
  }

  get group(): EmailConnectionGroup {
    return this.deps.group
  }

  /** The member question this address asks; undefined where the daemon wired none. */
  get members(): EmailMembers | undefined {
    return this.deps.members
  }

  /** The agent the address serves. */
  get agentId(): string {
    return this.deps.group.integrations[0]!.agentId
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  private get index(): EmailMessages {
    return this.deps.store().emailMessages
  }

  // ── §5.1 / §5.2 placement reads ──

  async message(messageId: string): Promise<EmailKnownMessage | undefined> {
    const row = await this.index.get(this.address, messageId)
    return row ? { thread: row.thread, conversation: row.conversation } : undefined
  }

  async conversation(channel: string): Promise<EmailConversationState | undefined> {
    const [first, latest] = await Promise.all([
      this.index.firstReceived(this.address, channel),
      this.index.latestReceived(this.address, channel)
    ])
    const opener = first ? storedMailOf(first)?.from.address : undefined
    const members = latest ? storedMailOf(latest)?.participants : undefined
    return opener && members ? { opener, members } : undefined
  }

  /** The thread a minted tag names (§5.1), with the started mail's recipients as its members until a reply is admitted (§5.2). */
  async startedThread(tag: string): Promise<EmailStartedThread | undefined> {
    if (!EMAIL_STARTED_TAG_PATTERN.test(tag)) return undefined
    const row = await this.index.firstSent(this.address, tag)
    const sent = row ? storedSentOf(row) : undefined
    if (!row || !sent?.started) return undefined
    const recipients = [...sent.to, ...sent.cc].map((mailbox) => mailbox.address)
    const latest = await this.index.latestReceived(this.address, row.conversation, tag)
    const members = (latest ? storedMailOf(latest)?.participants : undefined) ?? recipients
    return { thread: tag, conversation: row.conversation, recipients, members }
  }

  /** Index one mail the agent sent from this address. */
  async recordSent(row: Omit<EmailMessageRow, 'seq' | 'address' | 'direction'>): Promise<boolean> {
    return await this.index.record({ ...row, address: this.address, direction: 'sent' })
  }

  /** A conversation's current members: a direct conversation's member, or the participants of a group's latest admitted mail. */
  async currentMembers(channel: string): Promise<string[]> {
    if (channel.startsWith('dm:')) return [channel.slice('dm:'.length)]
    return (await this.conversation(channel))?.members.slice() ?? []
  }

  /** The latest mail a thread of a conversation received, which a reply answers when the turn's own message carries none. */
  async latestReceived(channel: string, thread: string): Promise<EmailStoredMail | undefined> {
    const row = await this.index.latestReceived(this.address, channel, thread)
    return row ? storedMailOf(row) : undefined
  }

  /** The addresses that have written on a thread of a conversation as admitted senders, which an outside Cc is bounded by (§6.1). */
  async threadSenders(channel: string, thread: string): Promise<Set<string>> {
    const rows = await this.index.receivedInThread(this.address, channel, thread)
    return new Set(rows.flatMap((row) => storedMailOf(row)?.from.address ?? []))
  }

  // ── Layer-1 reads ──

  async getChannelInfo(channel: string): Promise<PlatformChannelInfo> {
    if (channel.startsWith('dm:')) return { id: channel, isIm: true, isPrivate: true, user: channel.slice(3) }
    return { id: channel, isMpim: true, isPrivate: true }
  }

  async listMembers(channel: string): Promise<PlatformMemberRef[]> {
    return (await this.currentMembers(channel)).map((id) => ({ id, isBot: false }))
  }

  async listMemberIds(channel: string): Promise<string[]> {
    return await this.currentMembers(channel)
  }

  /** Conversations are found by their mail, never listed. */
  async listChannels(): Promise<[]> {
    return []
  }

  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    return { id: user, isBot: false }
  }

  /** Attachments are named and never delivered (§5.4). */
  async downloadFile(): Promise<null> {
    return null
  }

  /** Mail goes out as a turn's reply (§6.1) or a mail `sendEmail` starts (§6.4), so nothing is posted here. */
  async postMessage(): Promise<string | undefined> {
    throw new Error('email: a new mail is started with sendEmail, and anything else is sent as the reply to a mail')
  }

  // The text of each row as the agent reads it: a received mail's own header block is already in its transcript row; a sent one's is rendered here.
  private async texts(channel: string, rows: readonly EmailMessageRow[]): Promise<Map<string, string>> {
    const keys = rows.flatMap((row) => (row.ts ? [row.ts] : []))
    const found = await this.deps.store().admittedTextRowsByTs(this.agentId, this.deps.transcriptChannel(channel), keys)
    const byTs = new Map(found.map((row) => [row.ts, row.text]))
    const out = new Map<string, string>()
    for (const row of rows) {
      const text = row.ts ? byTs.get(row.ts) : undefined
      if (text === undefined) continue
      const sent = storedSentOf(row)
      const status =
        row.direction === 'sent' && row.outcome !== 'sent'
          ? `\n[Not delivered${row.reason ? `: ${row.reason}` : ''}]`
          : ''
      out.set(row.ts!, sent ? `${renderEmailHeaderBlock(sent)}${status}\n\n${text}` : text)
    }
    return out
  }

  /** The first message of each of a conversation's threads, newest first, with the number of messages after it (§5.6). */
  async getChannelHistory(
    channel: string,
    options: PlatformChannelHistoryOptions = {}
  ): Promise<PlatformChannelHistoryPage> {
    const limit = Math.min(Math.max(options.limit ?? DEFAULT_HISTORY_LIMIT, 1), MAX_HISTORY_LIMIT)
    const before = options.cursor && /^\d+$/.test(options.cursor) ? Number(options.cursor) : undefined
    const threads = await this.index.threads(this.address, channel, {
      ...(before !== undefined ? { before } : {}),
      limit: limit + 1
    })
    const page = threads.slice(0, limit)
    const firsts = await this.index.bySeq(
      this.address,
      channel,
      page.map((thread) => thread.first)
    )
    const texts = await this.texts(channel, firsts)
    const bySeq = new Map(firsts.map((row) => [row.seq, row]))
    const messages = page.flatMap((thread) => {
      const row = bySeq.get(thread.first)
      const text = row?.ts ? texts.get(row.ts) : undefined
      if (!row || text === undefined) return []
      return [
        {
          sender: row.direction === 'sent' ? this.agentId : this.senderOf(row),
          ts: row.ts!,
          text,
          isBot: row.direction === 'sent',
          threadTs: thread.thread,
          replyCount: thread.count - 1
        }
      ]
    })
    const more = threads.length > limit
    return { messages, hasMore: more, ...(more ? { nextCursor: String(page.at(-1)!.first) } : {}) }
  }

  /** One thread's messages in full, received and sent, oldest first, and only those of the conversation it names (§5.6). */
  async getThreadReplies(
    channel: string,
    thread: string,
    maxMessages = DEFAULT_HISTORY_LIMIT,
    window: PlatformThreadWindow = {}
  ): Promise<PlatformThreadMessage[]> {
    const limit = Math.min(Math.max(maxMessages, 1), MAX_HISTORY_LIMIT)
    const { rows, more } = await this.index.threadMessages(this.address, channel, thread, limit)
    const texts = await this.texts(channel, rows)
    if (window.readState) window.readState.truncated = more
    return rows.flatMap((row) => {
      const text = row.ts ? texts.get(row.ts) : undefined
      if (text === undefined) return []
      const sent = row.direction === 'sent'
      return [
        {
          sender: sent ? this.agentId : this.senderOf(row),
          ts: row.ts!,
          text,
          isBot: sent,
          chrome: false,
          ...(sent ? { agentAuthorId: this.agentId } : {}),
          attachments: []
        }
      ]
    })
  }

  private senderOf(row: EmailMessageRow): string {
    return storedMailOf(row)?.from.address ?? 'unknown'
  }

  // ── §6.2 sending ──

  /** Send one reply or started mail through the relay; a send nothing reached the provider with is tried again, one that may have landed never is. */
  async send(call: WireEmailCall): Promise<EmailSendResult> {
    const relay = this.deps.relay
    if (!relay) return { outcome: 'unsent', reason: 'no relay is configured to send mail' }
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    let last: EmailSendResult = { outcome: 'unsent', reason: 'no relay is reachable' }
    for (let attempt = 0; attempt <= SEND_ATTEMPT_WAITS_MS.length; attempt++) {
      if (attempt > 0) await sleep(SEND_ATTEMPT_WAITS_MS[attempt - 1]!)
      let reply: RdPlatformReply
      try {
        reply = await relay.request({ platformId: EMAIL_PLATFORM, botId: this.botId, payload: call })
      } catch (err) {
        if (err instanceof PlatformRelayUnsent) {
          last = { outcome: 'unsent', reason: 'no relay is reachable' }
          continue
        }
        return { outcome: 'unknown', reason: 'the relay did not answer, so it may have been sent' }
      }
      const { retryable, ...result } = emailSendOutcome(reply)
      if (!retryable) return result
      last = result
    }
    return last
  }
}
