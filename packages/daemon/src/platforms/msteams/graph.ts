// The Microsoft Graph history reads a Teams bot makes with an app-only token under the resource-specific consent its package asks for (teams-integration.md §4.1).
import { MSTEAMS_ADAPTIVE_CARD_TYPE } from './connection.js'
import { MsTeamsApiError, type MsTeamsApi } from './api.js'

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0/'
/** Graph's largest `$top` for channel messages, replies and chat messages; a larger one answers 400. */
export const MSTEAMS_GRAPH_PAGE_MAX = 50
const SKIPTOKEN_MAX = 4_096

/** Where a conversation's messages are read: a team channel, by the team's group ID, or a group chat. */
export type MsTeamsHistorySource =
  { kind: 'channel'; groupId: string; channelId: string } | { kind: 'chat'; chatId: string }

/** One message as Graph answers it, reduced to what a history read reports. */
export interface MsTeamsGraphMessage {
  id: string
  createdMs: number
  /** A person's Entra object ID, or a bot's `28:<appId>`. */
  sender: string
  isBot: boolean
  appId?: string
  text: string
  /** Whether the message carries an Adaptive Card, which a bot's question or approval is. */
  card: boolean
  link?: string
}

/** One page of a message list, and the skip token Graph gave for the next one. */
export interface MsTeamsGraphPage {
  messages: MsTeamsGraphMessage[]
  skiptoken?: string
}

function sourcePath(source: MsTeamsHistorySource): string {
  return source.kind === 'channel'
    ? `teams/${encodeURIComponent(source.groupId)}/channels/${encodeURIComponent(source.channelId)}/messages`
    : `chats/${encodeURIComponent(source.chatId)}/messages`
}

/** The URL of a conversation's root messages, or of one message's replies when `rootId` is given. */
export function msTeamsGraphMessagesUrl(
  source: MsTeamsHistorySource,
  page: { top: number; skiptoken?: string; rootId?: string }
): string {
  const path = page.rootId ? `${sourcePath(source)}/${encodeURIComponent(page.rootId)}/replies` : sourcePath(source)
  const url = new URL(path, GRAPH_ROOT)
  url.searchParams.set('$top', String(page.top))
  if (page.skiptoken) url.searchParams.set('$skiptoken', page.skiptoken)
  return url.toString()
}

/** The URL of one message in a conversation. */
export function msTeamsGraphMessageUrl(source: MsTeamsHistorySource, id: string): string {
  return new URL(`${sourcePath(source)}/${encodeURIComponent(id)}`, GRAPH_ROOT).toString()
}

/** A history cursor as the skip token it carries; anything else is refused rather than sent on. */
export function msTeamsSkiptoken(cursor: string): string {
  if (!cursor || cursor.length > SKIPTOKEN_MAX || /[\s&#]/.test(cursor))
    throw new MsTeamsApiError('msteams: the history cursor is not one this read returned', 'invalid')
  return cursor
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** A Teams message body as plain text: block ends become line breaks, tags go, entities are decoded. */
export function msTeamsHtmlText(html: string): string {
  return html
    .replace(/<attachment\b[^>]*>\s*<\/attachment>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A Graph message as a history row; a system event, a deleted message or one without a sender is none. */
export function msTeamsGraphMessage(raw: unknown): MsTeamsGraphMessage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const m = raw as Record<string, unknown>
  if (m.messageType !== 'message' || m.deletedDateTime) return undefined
  const id = typeof m.id === 'string' && /^\d+$/.test(m.id) ? m.id : undefined
  const createdMs = typeof m.createdDateTime === 'string' ? Date.parse(m.createdDateTime) : NaN
  if (!id || Number.isNaN(createdMs)) return undefined
  const from = (m.from ?? {}) as { user?: { id?: unknown }; application?: { id?: unknown } }
  const userId = typeof from.user?.id === 'string' && from.user.id ? from.user.id : undefined
  const appId = typeof from.application?.id === 'string' && from.application.id ? from.application.id : undefined
  if (!userId && !appId) return undefined
  const body = (m.body ?? {}) as { contentType?: unknown; content?: unknown }
  const content = typeof body.content === 'string' ? body.content : ''
  const attachments = Array.isArray(m.attachments) ? (m.attachments as { contentType?: unknown }[]) : []
  const link = typeof m.webUrl === 'string' && m.webUrl.startsWith('https://') ? m.webUrl : undefined
  return {
    id,
    createdMs,
    sender: userId ?? `28:${appId!.toLowerCase()}`,
    isBot: !userId,
    ...(!userId && appId ? { appId: appId.toLowerCase() } : {}),
    text: body.contentType === 'html' ? msTeamsHtmlText(content) : content.trim(),
    card: attachments.some((a) => a?.contentType === MSTEAMS_ADAPTIVE_CARD_TYPE),
    ...(link ? { link } : {})
  }
}

// Graph's next-page link as the skip token it carries, so a cursor never names a URL of its own.
function skiptokenOf(nextLink: unknown): string | undefined {
  if (typeof nextLink !== 'string') return undefined
  try {
    return new URL(nextLink).searchParams.get('$skiptoken') ?? undefined
  } catch {
    return undefined
  }
}

// A refusal names what is missing: Graph answers 403 where the app's consent to read this conversation is not granted.
function refusal(err: unknown, source: MsTeamsHistorySource): unknown {
  if (!(err instanceof MsTeamsApiError) || err.kind !== 'forbidden') return err
  const where =
    source.kind === 'channel'
      ? "this channel's messages (ChannelMessage.Read.Group)"
      : "this chat's messages (ChatMessage.Read.Chat)"
  return new MsTeamsApiError(
    `msteams: Microsoft Teams refused to read ${where}; the app's consent is not granted here — an owner reinstalls the app in this ${source.kind === 'channel' ? 'team' : 'chat'} to grant it`,
    'forbidden',
    err.status,
    err.code
  )
}

/** One bot's Graph reads: newest-first pages of a conversation's messages or a thread's replies, and one message. */
export class MsTeamsGraph {
  constructor(private readonly api: MsTeamsApi) {}

  async page(
    source: MsTeamsHistorySource,
    page: { top: number; skiptoken?: string; rootId?: string }
  ): Promise<MsTeamsGraphPage> {
    let body: Record<string, unknown>
    try {
      body = await this.api.read(msTeamsGraphMessagesUrl(source, page))
    } catch (err) {
      throw refusal(err, source)
    }
    const list = Array.isArray(body.value) ? (body.value as unknown[]) : []
    const skiptoken = skiptokenOf(body['@odata.nextLink'])
    return {
      messages: list.flatMap((raw) => msTeamsGraphMessage(raw) ?? []),
      ...(skiptoken ? { skiptoken } : {})
    }
  }

  async message(source: MsTeamsHistorySource, id: string): Promise<MsTeamsGraphMessage | undefined> {
    try {
      return msTeamsGraphMessage(await this.api.read(msTeamsGraphMessageUrl(source, id)))
    } catch (err) {
      throw refusal(err, source)
    }
  }
}
