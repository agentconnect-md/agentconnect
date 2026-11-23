import { MATTERMOST_PLATFORM, type NormalizedPlatformMessage, type PlatformAttachment } from '@agentconnect.md/protocol'
import { leadingMentions } from './command-text.js'
import { mimeTypeFromFileName, safeAttachmentName } from './file-name.js'
import { AGENTCONNECT_THREAD_EVENT_TYPE, readAgentAuthorshipClaim } from './slack-message.js'

/** File metadata carried in Mattermost `post.metadata.files`. */
export interface MattermostFileInfo {
  id?: string
  user_id?: string
  post_id?: string
  channel_id?: string
  create_at?: number
  update_at?: number
  delete_at?: number
  name?: string
  extension?: string
  size?: number
  mime_type?: string
  width?: number
  height?: number
  has_preview_image?: boolean
  mini_preview?: string
}

/** Slack-compatible rich attachment carried in `post.props.attachments`. */
export interface MattermostPostAttachment {
  pretext?: string
  author_name?: string
  author_link?: string
  title?: string
  title_link?: string
  text?: string
  fallback?: string
  fields?: Array<{ title?: string; value?: string; short?: boolean }>
  footer?: string
}

/** Mattermost post object (`data.post` after JSON parsing, or from REST v4). */
export interface MattermostPost {
  id?: string
  create_at?: number
  update_at?: number
  edit_at?: number
  delete_at?: number
  is_pinned?: boolean
  user_id?: string
  channel_id?: string
  root_id?: string
  original_id?: string
  message?: string
  type?: string
  props?: Record<string, unknown>
  hashtags?: string
  file_ids?: string[]
  metadata?: {
    files?: MattermostFileInfo[]
    [key: string]: unknown
  }
}

/** Payload of a Mattermost WebSocket `posted` (or `post_edited`) event's `data` field. */
export interface MattermostPostedEventData {
  /** Mattermost sends `post` as a JSON-encoded string over WS; already-parsed objects are also accepted. */
  post?: string | MattermostPost
  /** Mattermost sends `mentions` as a JSON-encoded string array of user IDs over WS. */
  mentions?: string | string[]
  channel_type?: string
  channel_name?: string
  channel_display_name?: string
  sender_name?: string
  team_id?: string
  set_online?: boolean
}

/** Mattermost WebSocket `posted` (or `post_edited`) frame. */
export interface MattermostPostedEvent {
  event?: string
  data?: MattermostPostedEventData
  broadcast?: {
    channel_id?: string
    team_id?: string
    user_id?: string
    omit_users?: Record<string, boolean> | null
  }
  seq?: number
}

/** The receiving bot's verified identity; never derived from the inbound payload. */
export interface MattermostNormalizeContext {
  /** The bot's Mattermost user id (`GET /api/v4/users/me`). */
  botUserId: string
  /** The bot's Mattermost username (`GET /api/v4/users/me`), used for `@username` fallback and command stripping. */
  botUsername?: string
  /** Whether the sender is a bot according to cached `/api/v4/users` metadata when `props.from_bot` is absent. */
  senderIsBot?: boolean
  /** Fallback sender display name when `data.sender_name` is absent (e.g. REST backfill). */
  senderName?: string
  /** Channel type (`O`, `P`, `D`, `G`) when `data.channel_type` is absent (e.g. REST backfill). */
  channelType?: string
  /** Normalized Mattermost base URL (`http(s)://...`, no trailing slash) used to build attachment download URLs. */
  serverUrl?: string
  /** Server-realm external app ID (`mm-<16 hex>`) stamped onto `sender.appId` for D6/agent verification. */
  appId?: string
  traceId: string
}

/** `ingressEventTag` marking a closing `post_edited` finalization event apart from the initial post. */
export const MATTERMOST_RESPONSE_FINAL_EVENT_TAG = 'response-final'

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/
const COLON_FREE_ID_RE = /^[^\s:]+$/

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function trimmedStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function obj(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeServerUrl(serverUrl?: string): string | undefined {
  const s = trimmedStr(serverUrl)
  return s ? s.replace(/\/+$/, '') : undefined
}

/** Parse a Mattermost `data.post` field (JSON string or already-parsed object). */
export function parseMattermostPost(raw: unknown): MattermostPost | null {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return null
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const post = obj(parsed)
  return post ? (post as MattermostPost) : null
}

/** Parse a Mattermost `data.mentions` field (JSON string array or string[]) into unique user IDs. */
export function parseMattermostMentions(raw: unknown): string[] {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return []
    try {
      parsed = JSON.parse(raw)
    } catch {
      return []
    }
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string' || !item) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

const MATTERMOST_BROADCAST_HANDLES = new Set(['channel', 'all', 'here'])
const GENERAL_MENTION_RE = /(?<![A-Za-z0-9._-])@([A-Za-z0-9._-]+)/g
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})([^\r\n]*)$/
const BLANK_LINE_SPLIT_RE = /(\r?\n[ \t]*\r?\n)/

function stripFencedCodeBlocks(text: string): string {
  if (!text.includes('```') && !text.includes('~~~')) return text
  const out: string[] = []
  let pos = 0
  let minUnmatchedTick = Infinity
  let minUnmatchedTilde = Infinity

  while (pos < text.length) {
    const nl = text.indexOf('\n', pos)
    const lineEnd = nl === -1 ? text.length : nl + 1
    const rawLine = text.slice(pos, nl === -1 ? text.length : nl)
    const cleanLine = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const openMatch = FENCE_OPEN_RE.exec(cleanLine)

    if (openMatch) {
      const fence = openMatch[1]!
      const marker = fence[0]!
      const fenceLen = fence.length
      const info = openMatch[2] ?? ''
      const minFailed = marker === '`' ? minUnmatchedTick : minUnmatchedTilde
      // CommonMark forbids backticks in a backtick fence's info string.
      const validInfo = marker !== '`' || !info.includes('`')
      if (validInfo && fenceLen < minFailed) {
        let scan = lineEnd
        let closedAt = -1
        while (scan < text.length) {
          const nextNl = text.indexOf('\n', scan)
          const nextEnd = nextNl === -1 ? text.length : nextNl + 1
          const nextRaw = text.slice(scan, nextNl === -1 ? text.length : nextNl)
          const nextClean = nextRaw.endsWith('\r') ? nextRaw.slice(0, -1) : nextRaw
          const trimmed = nextClean.replace(/^[ \t]{0,3}/, '').replace(/[ \t]+$/, '')
          if (trimmed.length >= fenceLen && [...trimmed].every((ch) => ch === marker)) {
            closedAt = nextEnd
            break
          }
          scan = nextEnd
        }
        if (closedAt !== -1) {
          out.push(' ')
          pos = closedAt
          continue
        }
        if (marker === '`') minUnmatchedTick = Math.min(minUnmatchedTick, fenceLen)
        else minUnmatchedTilde = Math.min(minUnmatchedTilde, fenceLen)
      }
    }

    out.push(text.slice(pos, lineEnd))
    pos = lineEnd
  }

  return out.join('')
}

function stripInlineCodeSpansInParagraph(paragraph: string): string {
  if (!paragraph.includes('`')) return paragraph
  const runs: Array<{ start: number; len: number }> = []
  const byLen = new Map<number, number[]>()

  let i = 0
  while (i < paragraph.length) {
    if (paragraph[i] === '`') {
      const start = i
      while (i < paragraph.length && paragraph[i] === '`') i++
      const len = i - start
      const idx = runs.length
      runs.push({ start, len })
      const bucket = byLen.get(len)
      if (bucket) bucket.push(idx)
      else byLen.set(len, [idx])
    } else {
      i++
    }
  }

  if (runs.length < 2) return paragraph

  const cursors = new Map<number, number>()
  const out: string[] = []
  let emittedUpTo = 0

  for (let r = 0; r < runs.length; r++) {
    const open = runs[r]!
    if (open.start < emittedUpTo) continue
    const list = byLen.get(open.len)!
    let cursor = cursors.get(open.len) ?? 0
    while (cursor < list.length && list[cursor]! <= r) cursor++
    if (cursor < list.length) {
      const closeIdx = list[cursor]!
      const close = runs[closeIdx]!
      out.push(paragraph.slice(emittedUpTo, open.start), ' ')
      emittedUpTo = close.start + close.len
      cursors.set(open.len, cursor + 1)
      r = closeIdx
    } else {
      cursors.set(open.len, cursor)
    }
  }

  if (emittedUpTo === 0) return paragraph
  out.push(paragraph.slice(emittedUpTo))
  return out.join('')
}

function stripLinkDestinationsInParagraph(paragraph: string): string {
  if (!paragraph.includes('](')) return paragraph
  const stack: Array<{ start: number; isLink: boolean }> = []
  const ranges: Array<[number, number]> = []

  for (let i = 0; i < paragraph.length; i++) {
    const ch = paragraph[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === ']' && paragraph[i + 1] === '(') {
      stack.push({ start: i + 1, isLink: true })
      i++
      continue
    }
    if (ch === '(') {
      stack.push({ start: i, isLink: false })
      continue
    }
    if (ch === ')' && stack.length > 0) {
      const open = stack.pop()!
      if (open.isLink) {
        ranges.push([open.start, i + 1])
      }
    }
  }

  if (ranges.length === 0) return paragraph
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])

  const out: string[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (start < cursor) continue
    out.push(paragraph.slice(cursor, start), '()')
    cursor = end
  }
  out.push(paragraph.slice(cursor))
  return out.join('')
}

/**
 * Strip code blocks, inline code spans (including multi-backtick spans), and markdown link
 * destinations (`[label](...)`, including multi-line targets) before scanning for Mattermost
 * `@username` mentions so CVE-2023-48732 link targets or code snippets never trigger false mentions.
 */
export function stripMattermostNonMentionSpans(text: string): string {
  if (!text) return ''
  const withoutFences = stripFencedCodeBlocks(text)
  const parts = withoutFences.split(BLANK_LINE_SPLIT_RE)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = stripLinkDestinationsInParagraph(stripInlineCodeSpansInParagraph(parts[i]!))
  }
  return parts.join('')
}

function botMentionRegex(botUsername: string): RegExp | null {
  const clean = trimmedStr(botUsername)?.replace(/^@/, '')
  if (!clean) return null
  return new RegExp(`(?:^|[^A-Za-z0-9._-])@${escapeRegExp(clean)}(?=$|[^A-Za-z0-9._-]|\\.(?=$|[^A-Za-z0-9._-]))`, 'i')
}

/** Extract deduplicated lowercased `@username` handles outside code blocks and markdown link targets. */
export function extractMattermostUsernameMentions(text: string): string[] {
  const visible = stripMattermostNonMentionSpans(text)
  if (!visible) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of visible.matchAll(GENERAL_MENTION_RE)) {
    const clean = match[1]!.toLowerCase().replace(/\.+$/, '')
    if (!clean || MATTERMOST_BROADCAST_HANDLES.has(clean) || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

/** True when Mattermost text addresses any user handle or `@channel`/`@all`/`@here` outside code and link targets. */
export function mattermostTextAddressesAnyone(text: string): boolean {
  const visible = stripMattermostNonMentionSpans(text)
  return Boolean(visible && /(?<![A-Za-z0-9._-])@(?:[A-Za-z0-9._-]+|channel|all|here)\b/i.test(visible))
}

/** Case-insensitive `@botUsername` check bounded against email addresses, code spans, markdown link targets, and longer username prefixes. */
export function mattermostMentionsBot(text: string, botUsername?: string): boolean {
  const visible = stripMattermostNonMentionSpans(text)
  if (!visible || !botUsername) return false
  const re = botMentionRegex(botUsername)
  return re ? re.test(visible) : false
}

// Extract exact leading `@username` literals (preserving user casing) so `commandText()` strips them cleanly.
function leadingBotMentionLiterals(text: string, botUsername: string): string[] {
  const clean = trimmedStr(botUsername)?.replace(/^@/, '')
  if (!clean || !text) return []
  const tokenRe = new RegExp(
    `^\\s*(@${escapeRegExp(clean)})(?=$|\\s|[^A-Za-z0-9._-]|\\.(?=$|\\s|[^A-Za-z0-9._-]))`,
    'i'
  )
  const found = new Set<string>()
  let rest = text
  for (let i = 0; i < 20; i++) {
    const m = tokenRe.exec(rest)
    if (!m) break
    found.add(m[1]!)
    rest = rest.slice(m[0].length)
  }
  return [...found]
}

function linkedLabel(label: string | undefined, url: string | undefined): string | undefined {
  if (!label) return undefined
  return url ? `[${label}](${url})` : label
}

/** Extract readable text from Mattermost `props.attachments` (Slack-style rich message attachments). */
export function extractMattermostAttachmentsText(attachments: unknown): string {
  if (!Array.isArray(attachments)) return ''
  const parts: string[] = []
  for (const item of attachments) {
    const a = obj(item)
    if (!a) continue
    const fields = Array.isArray(a.fields)
      ? a.fields
          .map((field) => {
            const f = obj(field)
            if (!f) return ''
            const title = trimmedStr(f.title)
            const value = trimmedStr(f.value)
            if (title && value) return `${title}: ${value}`
            return title ?? value ?? ''
          })
          .filter(Boolean)
      : []
    const structured = [
      trimmedStr(a.pretext),
      linkedLabel(trimmedStr(a.author_name), trimmedStr(a.author_link)),
      linkedLabel(trimmedStr(a.title), trimmedStr(a.title_link)),
      trimmedStr(a.text),
      ...fields,
      trimmedStr(a.footer)
    ].filter((v): v is string => Boolean(v))
    const chunk = structured.length ? structured.join('\n') : trimmedStr(a.fallback)
    if (chunk) parts.push(chunk)
  }
  return parts.join('\n')
}

/** Combine `post.message` with any text rendered inside `post.props.attachments`. */
export function extractMattermostPostText(post: Pick<MattermostPost, 'message' | 'props'>): string {
  const body = typeof post.message === 'string' ? post.message : ''
  const attachmentText = extractMattermostAttachmentsText(obj(post.props)?.attachments)
  if (!attachmentText) return body
  if (!body.trim()) return attachmentText
  return `${body}\n${attachmentText}`
}

/**
 * Read an UNTRUSTED agent-authorship claim from `post.props.agentconnect_thread_event`,
 * delegating validation to {@link readAgentAuthorshipClaim}.
 */
export function readMattermostAgentAuthorshipClaim(
  post: Pick<MattermostPost, 'props'>
): NormalizedPlatformMessage['agentAuthorship'] | undefined {
  const raw = obj(post.props)?.agentconnect_thread_event
  if (raw === undefined || raw === null) return undefined
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) return undefined
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  const record = obj(parsed)
  if (!record) return undefined
  if ('event_type' in record || 'event_payload' in record) {
    return readAgentAuthorshipClaim({
      metadata: {
        ...(typeof record.event_type === 'string' ? { event_type: record.event_type } : {}),
        ...(obj(record.event_payload) ? { event_payload: obj(record.event_payload) } : {})
      }
    })
  }
  return readAgentAuthorshipClaim({
    metadata: {
      event_type: AGENTCONNECT_THREAD_EVENT_TYPE,
      event_payload: record
    }
  })
}

/** Map a Mattermost `FileInfo` object to the shared attachment contract. */
export function toMattermostAttachment(
  file: MattermostFileInfo | null | undefined,
  serverUrl?: string
): PlatformAttachment | null {
  if (!file || typeof file !== 'object') return null
  const id = str(file.id)
  if (!id || !SAFE_ID_RE.test(id)) return null
  if (typeof file.delete_at === 'number' && file.delete_at > 0) return null
  const safeExt = trimmedStr(file.extension)?.replace(/[^A-Za-z0-9]/g, '')
  const name = safeAttachmentName(trimmedStr(file.name)) ?? (safeExt ? `${id}.${safeExt}` : id)
  const mimeType = trimmedStr(file.mime_type) ?? mimeTypeFromFileName(name)
  const base = normalizeServerUrl(serverUrl)
  const sourceUrl = base ? `${base}/api/v4/files/${id}` : id
  const thumbnailUrl =
    base && file.has_preview_image === true && mimeType.startsWith('image/')
      ? `${base}/api/v4/files/${id}/thumbnail`
      : undefined
  return {
    id,
    name,
    mimeType,
    ...(typeof file.size === 'number' && Number.isFinite(file.size) && file.size >= 0 ? { size: file.size } : {}),
    sourceUrl,
    ...(thumbnailUrl ? { thumbnailUrl } : {})
  }
}

function collectAttachments(post: MattermostPost, serverUrl?: string): PlatformAttachment[] {
  const out: PlatformAttachment[] = []
  const seen = new Set<string>()
  const files = Array.isArray(post.metadata?.files) ? post.metadata.files : []
  for (const file of files) {
    const att = toMattermostAttachment(file, serverUrl)
    if (!att || seen.has(att.id)) continue
    seen.add(att.id)
    out.push(att)
  }
  const base = normalizeServerUrl(serverUrl)
  const fileIds = Array.isArray(post.file_ids) ? post.file_ids : []
  for (const rawId of fileIds) {
    const id = str(rawId)
    if (!id || !SAFE_ID_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: id,
      mimeType: 'application/octet-stream',
      sourceUrl: base ? `${base}/api/v4/files/${id}` : id
    })
  }
  return out
}

function normalizePostEvent(
  event: MattermostPostedEvent,
  context: MattermostNormalizeContext
): NormalizedPlatformMessage | null {
  const data = obj(event.data) as MattermostPostedEventData | undefined
  if (!data) return null
  const post = parseMattermostPost(data.post)
  if (!post) return null
  if (typeof post.delete_at === 'number' && post.delete_at > 0) return null
  if (typeof post.type === 'string' && post.type.startsWith('system_')) return null

  const postId = str(post.id)
  const channelId = str(post.channel_id) ?? str(obj(event.broadcast)?.channel_id)
  const userId = str(post.user_id)
  if (!postId || !COLON_FREE_ID_RE.test(postId)) return null
  if (!channelId || !COLON_FREE_ID_RE.test(channelId)) return null
  if (!userId) return null

  const channelType = trimmedStr(data.channel_type) ?? trimmedStr(context.channelType)
  const isDm = channelType === 'D'
  const isGroupDm = channelType === 'G'

  const text = extractMattermostPostText(post)
  const attachments = collectAttachments(post, context.serverUrl)
  if (!text.trim() && attachments.length === 0) return null

  const mentionIds = parseMattermostMentions(data.mentions)
  const textMentionsBot = Boolean(context.botUsername && mattermostMentionsBot(text, context.botUsername))
  const mentionedBots = [
    ...new Set([...mentionIds, ...(textMentionsBot && context.botUserId ? [context.botUserId] : [])])
  ]
  const mentionedUsers = [...new Set(mentionedBots)].slice(0, 100)

  const leading =
    context.botUserId && context.botUsername
      ? leadingMentions(
          text,
          leadingBotMentionLiterals(text, context.botUsername).map((literal) => ({
            id: context.botUserId,
            text: literal
          }))
        )
      : undefined

  const rootId = str(post.root_id)
  const thread = rootId || postId

  const props = obj(post.props)
  const isWebhook = props?.from_webhook === 'true' || props?.from_webhook === true
  const isBot = props?.from_bot === 'true' || props?.from_bot === true || isWebhook || context.senderIsBot === true

  // Prefer verified WS/profile identity over spoofable post.props.override_username for non-webhook posts.
  const rawSenderName = isWebhook
    ? (trimmedStr(data.sender_name) ?? trimmedStr(props?.override_username) ?? trimmedStr(context.senderName))
    : (trimmedStr(data.sender_name) ??
      trimmedStr(context.senderName) ??
      (isBot ? trimmedStr(props?.override_username) : undefined))
  const senderName = rawSenderName?.replace(/^@/, '').trim() || undefined

  const agentAuthorship = readMattermostAgentAuthorshipClaim(post)
  const createAt = post.create_at
  const msgId = `${MATTERMOST_PLATFORM}:${channelId}:${postId}`

  return {
    msgId,
    traceId: context.traceId,
    source: 'user',
    platform: MATTERMOST_PLATFORM,
    channel: channelId,
    thread,
    ...(rootId && rootId !== postId ? { replyThread: rootId } : {}),
    sender: {
      id: userId,
      isBot,
      ...(senderName ? { name: senderName } : {}),
      ...(context.appId ? { appId: context.appId } : {})
    },
    text,
    mentionedBots,
    mentionedUsers,
    ...(leading ? { leadingMentions: leading } : {}),
    ...(attachments.length ? { attachments } : {}),
    isDm,
    ...(isGroupDm ? { isGroupDm: true } : {}),
    ...(typeof createAt === 'number' && Number.isSafeInteger(createAt) && createAt > 0
      ? { platformTimeMs: createAt }
      : {}),
    ...(agentAuthorship ? { agentAuthorship } : {})
  }
}

/**
 * Normalize a Mattermost WebSocket `posted` event into a {@link NormalizedPlatformMessage}.
 * Returns `null` for non-`posted` frames, deleted/system posts, malformed payloads, or empty posts.
 */
export function normalizeMattermostMessage(
  event: MattermostPostedEvent,
  context: MattermostNormalizeContext
): NormalizedPlatformMessage | null {
  if (!event || typeof event !== 'object') return null
  if (event.event !== undefined && event.event !== 'posted') return null
  return normalizePostEvent(event, context)
}

/**
 * Unwrap a Mattermost `post_edited` event ONLY when it closes an AgentConnect response
 * (`props.agentconnect_thread_event.delivery_state === 'final'`), mirroring Slack's
 * response-finalization event tag so streaming posts and final edits remain distinct arrivals.
 */
export function normalizeMattermostResponseFinalization(
  event: MattermostPostedEvent,
  context: Omit<MattermostNormalizeContext, 'traceId'> & { traceId?: string }
): NormalizedPlatformMessage | null {
  if (!event || typeof event !== 'object') return null
  if (event.event !== undefined && event.event !== 'post_edited') return null
  const data = obj(event.data) as MattermostPostedEventData | undefined
  const post = data ? parseMattermostPost(data.post) : null
  if (!post) return null
  const claim = readMattermostAgentAuthorshipClaim(post)
  if (claim?.deliveryState !== 'final') return null
  const normalized = normalizePostEvent(event, { ...context, traceId: context.traceId ?? 'pending' })
  if (!normalized) return null
  return {
    ...normalized,
    ingressEventTag: MATTERMOST_RESPONSE_FINAL_EVENT_TAG,
    traceId: context.traceId ?? `${normalized.msgId}#${MATTERMOST_RESPONSE_FINAL_EVENT_TAG}`
  }
}
