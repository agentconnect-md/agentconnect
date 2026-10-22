import { MSTEAMS_PLATFORM, type NormalizedPlatformMessage, type QuotedMessage } from '@agentconnect.md/protocol'

// Plain-object views of a Bot Connector activity (teams-integration.md §3, §4.1); every field is optional because the body is only structurally trusted.
export interface MsTeamsChannelAccount {
  /** `29:…` for a person (specific to the bot), `28:<appId>` for a bot. */
  id?: string
  /** Display label only; never an identity input. */
  name?: string
  /** The person's Entra object ID, stable within the tenant. */
  aadObjectId?: string
  role?: string
}

export interface MsTeamsConversation {
  /** `a:…` for a 1:1 chat, `19:…@thread.v2` for a group chat, `19:…@thread.tacv2;messageid=<root>` for a channel thread. */
  id?: string
  conversationType?: string
  tenantId?: string
  isGroup?: boolean
  name?: string
}

/** A `mention`, `quotedReply` or `clientInfo` entity; only the first two are read. */
export interface MsTeamsEntity {
  type?: string
  mentioned?: MsTeamsChannelAccount
  /** The exact `<at>…</at>` span the mention occupies in the activity text. */
  text?: string
  quotedReply?: {
    messageId?: string
    senderId?: string
    senderName?: string
    preview?: string
    time?: string
    validatedMessageReference?: boolean
  }
}

export interface MsTeamsChannelData {
  tenant?: { id?: string }
  team?: { id?: string; name?: string; aadGroupId?: string }
  channel?: { id?: string; name?: string }
  teamsChannelId?: string
  teamsTeamId?: string
  eventType?: string
}

export interface MsTeamsActivity {
  type?: string
  id?: string
  timestamp?: string
  localTimestamp?: string
  serviceUrl?: string
  channelId?: string
  from?: MsTeamsChannelAccount
  conversation?: MsTeamsConversation
  recipient?: MsTeamsChannelAccount
  textFormat?: string
  text?: string
  replyToId?: string | null
  attachments?: { contentType?: string; content?: unknown }[]
  entities?: MsTeamsEntity[]
  channelData?: MsTeamsChannelData
  locale?: string
}

/** The receiving bot's verified identity; it is never taken from the payload. */
export interface MsTeamsNormalizeContext {
  /** The Entra application (client) ID the inbound token's audience named. */
  appId: string
  /** The tenant the bot is registered in. */
  tenantId: string
  traceId: string
}

/** The reply coordinates the daemon's turn output needs, carried as `adapterExt.msteams`; read from the activity, never built. */
export interface MsTeamsAdapterExt {
  /** The regional Bot Connector origin every send, edit and card update for this conversation goes to. */
  serviceUrl: string
  /** The raw conversation ID, `;messageid=<root>` included for a channel thread. */
  conversationId: string
  /** The sender's bot-specific `29:…` ID, the member a proactive conversation names. */
  userId: string
  /** A channel's enclosing team, when the activity names one. */
  teamId?: string
}

export type MsTeamsUnsupportedReason = 'activity_type' | 'conversation_type' | 'sender_type' | 'thread_missing'

export type MsTeamsInvalidReason = 'malformed' | 'wrong_bot' | 'cross_tenant' | 'cross_conversation'

/** `invalid` is a malformed or misaddressed activity; `ignored` and `unsupported` are completed decisions that start no turn. */
export type MsTeamsActivityResult =
  | { kind: 'message'; message: NormalizedPlatformMessage }
  | { kind: 'ignored'; reason: 'app_authored' | 'empty' }
  | { kind: 'unsupported'; reason: MsTeamsUnsupportedReason }
  | { kind: 'invalid'; reason: MsTeamsInvalidReason }

type Obj = Record<string, unknown>

// A native ID segment of the `platform:channel:native` msgId grammar: colon-free so the split on the last ':' holds.
const NATIVE_ID = /^[^\s:;]+$/
const CHANNEL_THREAD = /^(19:[^;\s]+);messageid=([^\s:;]+)$/
const QUOTED_TAG = /^<quoted messageId="[^"]*"\/>\r?\n?/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i
const MAX_QUOTED_TEXT_CHARS = 1000
const ATTACHMENT_NOTE = '[Attachment not read: Microsoft Teams attachments are not supported.]'

function obj(value: unknown): Obj | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Entra GUIDs compare case-insensitively; an admin may paste one in upper case.
function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function entitiesOf(activity: Obj): Obj[] {
  return Array.isArray(activity.entities) ? activity.entities.map(obj).filter((e): e is Obj => e !== undefined) : []
}

/** The tenant an activity claims, `channelData.tenant.id` before `conversation.tenantId`; the relay's demux hint, verified by the token. */
export function msTeamsActivityTenantId(activity: unknown): string | undefined {
  const a = obj(activity)
  return str(obj(obj(a?.channelData)?.tenant)?.id) ?? str(obj(a?.conversation)?.tenantId)
}

// Removes the bot's own mention spans and renders every other one as `@Name`; a span the text does not hold is skipped, so no user content is erased.
function resolveMentions(text: string, entities: Obj[], botId: string): { text: string; mentionedBots: string[] } {
  const mentionedBots = new Set<string>()
  let out = ''
  let cursor = 0
  for (const entity of entities) {
    if (entity.type !== 'mention') continue
    const id = str(obj(entity.mentioned)?.id)
    const span = str(entity.text)
    if (!id || !span) continue
    if (id.startsWith('28:')) mentionedBots.add(id)
    const at = text.indexOf(span, cursor)
    if (at < 0) continue
    const label = /^<at>([\s\S]*)<\/at>$/.exec(span)?.[1]?.trim()
    out += text.slice(cursor, at) + (id === botId ? '' : label ? `@${label}` : span)
    cursor = at + span.length
    // A removed span between two words leaves one space, not two.
    if (id === botId && (!out || /\s$/.test(out)) && /[ \t]/.test(text[cursor] ?? '')) cursor++
  }
  out += text.slice(cursor)
  return { text: out.trim(), mentionedBots: [...mentionedBots] }
}

// The quoted message a reply names (§4.1): its ID is the reply-chain key, its preview the bounded quote.
function quotedOf(entities: Obj[]): { replyTo: string; quoted?: QuotedMessage } | undefined {
  for (const entity of entities) {
    if (entity.type !== 'quotedReply') continue
    const reply = obj(entity.quotedReply)
    const messageId = str(reply?.messageId)
    if (!messageId) continue
    const preview = str(reply?.preview)?.trim() ?? ''
    const sender = str(reply?.senderName)?.trim()
    const truncated = preview.length > MAX_QUOTED_TEXT_CHARS
    return {
      replyTo: messageId,
      ...(preview
        ? {
            quoted: {
              messageId,
              ...(sender ? { sender } : {}),
              text: truncated ? `${preview.slice(0, MAX_QUOTED_TEXT_CHARS)}…` : preview,
              ...(truncated ? { excerpt: true } : {})
            }
          }
        : {})
    }
  }
  return undefined
}

function timeMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return undefined
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) && ms > 0 ? ms : undefined
}

/** Normalize one verified Bot Connector activity; pure, and fail-closed on anything it cannot classify. */
export function normalizeMsTeamsActivity(activity: unknown, context: MsTeamsNormalizeContext): MsTeamsActivityResult {
  if (!context.appId || !context.tenantId)
    throw new TypeError('Microsoft Teams bot identity needs an app ID and a tenant ID')
  const a = obj(activity)
  if (!a || !str(a.type)) return { kind: 'invalid', reason: 'malformed' }
  // Typing, reactions, edits, installs and card invokes start no turn here; the relay module answers them.
  if (a.type !== 'message') return { kind: 'unsupported', reason: 'activity_type' }

  // The bot's own ID is the recipient, once it matches the verified app ID.
  const botId = str(obj(a.recipient)?.id)
  if (!botId) return { kind: 'invalid', reason: 'malformed' }
  if (!sameId(botId, `28:${context.appId}`)) return { kind: 'invalid', reason: 'wrong_bot' }
  const channelData = obj(a.channelData)
  const conversation = obj(a.conversation)
  const tenants = [str(obj(channelData?.tenant)?.id), str(conversation?.tenantId)].filter((t) => t !== undefined)
  if (!tenants.length) return { kind: 'invalid', reason: 'malformed' }
  if (tenants.some((t) => !sameId(t, context.tenantId))) return { kind: 'invalid', reason: 'cross_tenant' }

  const conversationId = str(conversation?.id)
  const messageId = str(a.id)
  const serviceUrl = str(a.serviceUrl)
  if (!conversationId || !messageId || !NATIVE_ID.test(messageId)) return { kind: 'invalid', reason: 'malformed' }
  if (!serviceUrl || !/^https:\/\/[^\s/?#@]+\/\S*$/.test(serviceUrl)) return { kind: 'invalid', reason: 'malformed' }
  if (a.text !== undefined && typeof a.text !== 'string') return { kind: 'invalid', reason: 'malformed' }

  const from = obj(a.from) ?? {}
  const fromId = str(from.id)
  if (!fromId) return { kind: 'invalid', reason: 'malformed' }
  if (sameId(fromId, botId)) return { kind: 'ignored', reason: 'app_authored' }
  if (!fromId.startsWith('29:')) return { kind: 'unsupported', reason: 'sender_type' }

  // Conversation coordinates (§4.1): a 1:1 chat and a group chat are keyed by their ID, a channel post by its channel and root.
  const type = conversation?.conversationType
  let channel: string
  let thread: string | undefined
  if (type === 'personal' || type === 'groupChat') {
    // A group chat ID never reads as a 1:1 key, and neither carries a channel thread suffix.
    if (conversationId.includes(';') || (type === 'groupChat' && conversationId.startsWith('a:')))
      return { kind: 'invalid', reason: 'malformed' }
    channel = conversationId
  } else if (type === 'channel') {
    const m = CHANNEL_THREAD.exec(conversationId)
    if (!m) return { kind: 'unsupported', reason: 'thread_missing' }
    channel = m[1]!
    thread = m[2]!
    const named = [str(obj(channelData?.channel)?.id), str(channelData?.teamsChannelId)]
    if (named.some((id) => id !== undefined && id !== channel)) return { kind: 'invalid', reason: 'cross_conversation' }
  } else return { kind: 'unsupported', reason: 'conversation_type' }

  const entities = entitiesOf(a)
  const reply = quotedOf(entities)
  // A quoted reply's text opens with the quote's tag; the duplicate `text/html` attachment is never read for text.
  const raw = typeof a.text === 'string' ? a.text : ''
  const body = reply ? raw.replace(QUOTED_TAG, '') : raw
  const mentions = resolveMentions(body, entities, botId)
  const attachments = Array.isArray(a.attachments) ? a.attachments.map(obj) : []
  const unread = attachments.some((item) => !item || item.contentType !== 'text/html')
  const text = unread ? [mentions.text, ATTACHMENT_NOTE].filter(Boolean).join('\n') : mentions.text
  const addressed = mentions.mentionedBots.includes(botId)
  if (!text && !reply?.quoted && !addressed) return { kind: 'ignored', reason: 'empty' }

  // The Entra object ID is the person; the bot-specific `29:` ID stands in only when an activity carries none.
  const aadObjectId = str(from.aadObjectId)
  const displayName = str(from.name)?.trim()
  const teamId = type === 'channel' ? str(obj(channelData?.team)?.id) : undefined
  const ext: MsTeamsAdapterExt = { serviceUrl, conversationId, userId: fromId, ...(teamId ? { teamId } : {}) }
  const platformTimeMs = timeMs(a.timestamp)
  return {
    kind: 'message',
    message: {
      msgId: `${MSTEAMS_PLATFORM}:${channel}:${messageId}`,
      traceId: context.traceId,
      source: 'user',
      platform: MSTEAMS_PLATFORM,
      channel,
      ...(thread ? { thread } : {}),
      sender: { id: aadObjectId ?? fromId, isBot: false, ...(displayName ? { name: displayName } : {}) },
      text,
      mentionedBots: mentions.mentionedBots,
      isDm: type === 'personal',
      ...(reply ? { replyTo: reply.replyTo } : {}),
      ...(reply?.quoted ? { quoted: reply.quoted } : {}),
      ...(platformTimeMs !== undefined ? { platformTimeMs } : {}),
      adapterExt: { [MSTEAMS_PLATFORM]: ext }
    }
  }
}
