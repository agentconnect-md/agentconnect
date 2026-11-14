import {
  MSTEAMS_PLATFORM,
  type NormalizedPlatformMessage,
  type PlatformAttachment,
  type QuotedMessage
} from '@agentconnect.md/protocol'
import { mimeTypeFromFileName, safeAttachmentName } from './file-name.js'

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
  attachments?: { contentType?: string; contentUrl?: string; name?: string; content?: unknown }[]
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
  /** The receiving bot's name as Teams shows it, from the activity's recipient. */
  botName?: string
  /** The relay's tickets for the conversation and its team, which a deployment app's row sends through the relay with; never set by this normalizer. */
  ticket?: string
  teamTicket?: string
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
/** A file a person sent in a 1:1 chat with a bot that declares `supportsFiles` (§4.8). */
export const MSTEAMS_FILE_DOWNLOAD_INFO_TYPE = 'application/vnd.microsoft.teams.file.download.info'
const MAX_FILES = 10
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

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
function resolveMentions(
  text: string,
  entities: Obj[],
  botId: string
): { text: string; mentionedBots: string[]; mentionNames: { id: string; name: string }[] } {
  const mentionedBots = new Set<string>()
  const mentionNames = new Map<string, string>()
  let out = ''
  let cursor = 0
  for (const entity of entities) {
    if (entity.type !== 'mention') continue
    const id = str(obj(entity.mentioned)?.id)
    const span = str(entity.text)
    if (!id || !span) continue
    // A bot's `28:` ID is compared exactly downstream, so it is recorded in the bot identity's lower case.
    if (id.startsWith('28:')) mentionedBots.add(id.toLowerCase())
    const at = text.indexOf(span, cursor)
    if (at < 0) continue
    const label = /^<at>([\s\S]*)<\/at>$/.exec(span)?.[1]?.trim()
    const isBot = id.toLowerCase() === botId
    // Whom else it names, as Teams shows them: the entity's name, else the span's label.
    const name = (str(obj(entity.mentioned)?.name)?.trim() || label)?.slice(0, 256)
    if (!isBot && name && mentionNames.size < 20) mentionNames.set(id.startsWith('28:') ? id.toLowerCase() : id, name)
    out += text.slice(cursor, at) + (isBot ? '' : label ? `@${label}` : span)
    cursor = at + span.length
    // A removed span between two words leaves one space, not two.
    if (isBot && (!out || /\s$/.test(out)) && /[ \t]/.test(text[cursor] ?? '')) cursor++
  }
  out += text.slice(cursor)
  return {
    text: out.trim(),
    mentionedBots: [...mentionedBots],
    mentionNames: [...mentionNames].map(([id, name]) => ({ id: id.slice(0, 256), name }))
  }
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

/** A 1:1 file's pre-authorized download link, read into provider attachment metadata; anything else is not a file. */
function fileAttachmentOf(item: Obj): PlatformAttachment | undefined {
  if (item.contentType !== MSTEAMS_FILE_DOWNLOAD_INFO_TYPE) return undefined
  const content = obj(item.content)
  const downloadUrl = str(content?.downloadUrl)
  const name = safeAttachmentName(str(item.name))
  if (!downloadUrl || !/^https:\/\/[^\s/?#@]+\/\S*$/.test(downloadUrl) || !name) return undefined
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const uniqueId = str(content?.uniqueId)
  return {
    id: uniqueId && NATIVE_ID.test(uniqueId) ? uniqueId : name,
    name,
    mimeType: (Object.hasOwn(IMAGE_TYPES, ext) && IMAGE_TYPES[ext]) || mimeTypeFromFileName(name),
    sourceUrl: downloadUrl
  }
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
  const botId = str(obj(a.recipient)?.id)?.toLowerCase()
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
  const items = Array.isArray(a.attachments) ? a.attachments.map(obj) : []
  const files = items.flatMap((item) => (item ? [fileAttachmentOf(item)] : [])).filter((f) => f !== undefined)
  const attachments = files.slice(0, MAX_FILES)
  const unread =
    files.length > MAX_FILES ||
    items.some((item) => !item || (item.contentType !== 'text/html' && !fileAttachmentOf(item)))
  const text = unread ? [mentions.text, ATTACHMENT_NOTE].filter(Boolean).join('\n') : mentions.text
  const addressed = mentions.mentionedBots.includes(botId)
  if (!text && !attachments.length && !reply?.quoted && !addressed) return { kind: 'ignored', reason: 'empty' }

  // The Entra object ID is the person; the bot-specific `29:` ID stands in only when an activity carries none.
  const aadObjectId = str(from.aadObjectId)
  const displayName = str(from.name)?.trim()
  const teamId = type === 'channel' ? str(obj(channelData?.team)?.id) : undefined
  const botName = str(obj(a.recipient)?.name)?.trim()
  const ext: MsTeamsAdapterExt = {
    serviceUrl,
    conversationId,
    userId: fromId,
    ...(teamId ? { teamId } : {}),
    ...(botName ? { botName } : {})
  }
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
      ...(mentions.mentionNames.length ? { mentionNames: mentions.mentionNames } : {}),
      ...(attachments.length ? { attachments } : {}),
      isDm: type === 'personal',
      ...(reply ? { replyTo: reply.replyTo } : {}),
      ...(reply?.quoted ? { quoted: reply.quoted } : {}),
      ...(platformTimeMs !== undefined ? { platformTimeMs } : {}),
      adapterExt: { [MSTEAMS_PLATFORM]: ext }
    }
  }
}
