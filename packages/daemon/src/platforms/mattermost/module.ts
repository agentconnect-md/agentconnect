// Mattermost daemon platform module (§7.4): channel sessions thread off `root_id || postId`, while 1:1 DMs collapse to a single continuous session (`PlatformManifest.appendKinds` = `['channel', 'mpim']`).
import { createHash } from 'node:crypto'
import { nativeMessageId } from '@agentconnect.md/message'
import {
  MATTERMOST_CARD_NOTE_MAX,
  MATTERMOST_PLATFORM,
  WireMattermostCardAction,
  type RdMsgPlatformAction,
  type WireMattermostCardActionResponse
} from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { ChatCardClick, DaemonPlatformModule, InteractionActor, RelayCardClicks } from '../contract.js'

/** Canonical session thread for 1:1 Mattermost DMs. */
export const MATTERMOST_DM_THREAD = 'dm'

const MATTERMOST_POST_ID_RE = /^[a-z0-9]{26}$/
const MATTERMOST_BROADCAST_MENTION_RE = /@(channel|all|here)\b/gi
const MATTERMOST_CONTROL_CHARS_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const MATTERMOST_BARE_URL_RE = /(?:https?:\/\/|www\.)[^\s<>()[\]]+/gi

function clampSliceBeforeSurrogate(text: string, end: number): number {
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    return end - 1
  }
  return end
}

/** Trim and clamp text to `max` UTF-16 code units with `…` without splitting a UTF-16 surrogate pair. */
export function clampMattermostText(raw: string, max: number): string {
  if (max <= 0) return ''
  const t = raw.trim()
  if (t.length <= max) return t
  if (max === 1) return '…'
  return `${t.slice(0, clampSliceBeforeSurrogate(t, max - 1))}…`
}

/** Validate an `http://` or `https://` link URL for Mattermost card interpolation, escaping `(`/`)`. */
export function safeMattermostCardUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    const normalized = url.toString()
    if (normalized.length > 2_048) return undefined
    return normalized.replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return undefined
  }
}

/** Render a safe `[label](url)` link if `rawUrl` is `http(s)`, or plain `label` otherwise. */
export function safeMattermostCardLink(label: string, rawUrl: string | undefined): string {
  const safeUrl = safeMattermostCardUrl(rawUrl)
  return safeUrl ? `[${label}](${safeUrl})` : label
}

function sanitizeCardProseSegment(segment: string): string {
  return segment.replace(/`/g, 'ˋ').replace(MATTERMOST_BARE_URL_RE, (m) => `\`${m}\``)
}

/** Defuse Mattermost `@channel`/`@all`/`@here` pings, control chars, Markdown link syntax, and bare URLs without splitting balanced inline code spans. */
export function sanitizeMattermostCardText(raw: string): string {
  const cleaned = raw.replace(MATTERMOST_CONTROL_CHARS_RE, '').replace(/[\\[\]]/g, (c) => `\\${c}`)
  if (!cleaned.includes('`')) {
    return sanitizeCardProseSegment(cleaned).replace(MATTERMOST_BROADCAST_MENTION_RE, '@\u200b$1')
  }

  const runs: Array<{ start: number; len: number }> = []
  const byLen = new Map<number, number[]>()
  for (let i = 0; i < cleaned.length;) {
    if (cleaned[i] === '`') {
      const start = i
      while (i < cleaned.length && cleaned[i] === '`') i++
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

  const cursors = new Map<number, number>()
  const out: string[] = []
  let emitted = 0
  for (let r = 0; r < runs.length; r++) {
    const open = runs[r]!
    if (open.start < emitted) continue
    const list = byLen.get(open.len)!
    let cursor = cursors.get(open.len) ?? 0
    while (cursor < list.length && list[cursor]! <= r) cursor++
    if (cursor < list.length) {
      const closeIdx = list[cursor]!
      const close = runs[closeIdx]!
      if (open.start > emitted) out.push(sanitizeCardProseSegment(cleaned.slice(emitted, open.start)))
      // Keep balanced inline code spans verbatim so embedded URLs/backticks stay inside `<code>` rather than breaking out.
      out.push(cleaned.slice(open.start, close.start + close.len))
      emitted = close.start + close.len
      cursors.set(open.len, cursor + 1)
      r = closeIdx
    } else {
      cursors.set(open.len, cursor)
    }
  }
  if (emitted < cleaned.length) {
    out.push(sanitizeCardProseSegment(cleaned.slice(emitted)))
  }
  return out.join('').replace(MATTERMOST_BROADCAST_MENTION_RE, '@\u200b$1')
}

/** Sanitize control characters and broadcast mentions for attachment button labels and fallback summaries. */
export function sanitizeMattermostPlainText(raw: string): string {
  return raw
    .replace(MATTERMOST_CONTROL_CHARS_RE, ' ')
    .replace(MATTERMOST_BROADCAST_MENTION_RE, '@\u200b$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Normalize a Mattermost base URL (`http|https`, no userinfo/query/fragment, no trailing slash, subpath preserved). */
export function normalizeMattermostServerUrl(serverUrl: string): string | undefined {
  const trimmed = serverUrl.trim()
  if (!trimmed || /[\s\u0000-\u001f\u007f]/.test(trimmed) || trimmed.includes('?') || trimmed.includes('#')) {
    return undefined
  }
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    const authority = trimmed.slice(url.protocol.length + 2).split('/')[0] ?? ''
    if (url.username || url.password || authority.includes('@') || !url.hostname) return undefined
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${path}`
  } catch {
    return undefined
  }
}

/** D6 server-realm external app ID (`mm-<16 hex>`): colon-free because ownerIdentity and approvalRoute split on `:`. */
export function mattermostExternalAppId(serverUrl: string): string | undefined {
  const normalized = normalizeMattermostServerUrl(serverUrl)
  if (!normalized) return undefined
  return `mm-${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`
}

/** Mattermost post permalink `<serverUrl>/_redirect/pl/<postId>`; undefined when missing or synthetic (`dm`, channel id). */
export function mattermostThreadUrl(
  serverUrl: string | undefined,
  channel: string,
  thread: string
): string | undefined {
  if (!serverUrl || !channel || !thread || thread === MATTERMOST_DM_THREAD || thread === channel) return undefined
  if (!MATTERMOST_POST_ID_RE.test(thread)) return undefined
  const base = normalizeMattermostServerUrl(serverUrl) ?? serverUrl.replace(/\/+$/, '')
  return `${base}/_redirect/pl/${thread}`
}

/** Decode one relayed Mattermost interactive attachment click into a core card answer. Pure. */
export function decodeMattermostCardClick(msg: Pick<RdMsgPlatformAction, 'payload'>): ChatCardClick | null {
  const parsed = WireMattermostCardAction.safeParse(msg.payload)
  if (!parsed.success) return null
  const click = parsed.data
  const name = click.userName?.trim()
  const actor: InteractionActor = {
    userId: click.userId,
    ...(name ? { name } : {})
  }
  const at = { ts: click.postId, actor }
  if (click.kind === 'approval') {
    return typeof click.option === 'number'
      ? { answer: { kind: 'approval', requestId: click.requestId, option: click.option }, ...at }
      : null
  }
  if (click.kind === 'elicit') {
    return click.token !== undefined
      ? { answer: { kind: 'choice', requestId: click.requestId, token: click.token }, ...at }
      : null
  }
  if (click.kind === 'capability') {
    return click.cardId && click.generation !== undefined
      ? { answer: { kind: 'capabilityDecline', cardId: click.cardId, generation: click.generation }, ...at }
      : null
  }
  if (click.kind === 'draft') {
    return click.token === 'approve' || click.token === 'discard'
      ? { answer: { kind: 'draft', draftId: click.requestId, optionId: click.token }, ...at }
      : null
  }
  return null
}

/** What a relayed click needs of the bot's connection to vouch for the user id the callback names. */
interface CardActorLookup {
  getUserProfile(userId: string): Promise<{ isBot?: boolean }>
  hasChannelMember(channelId: string, userId: string): Promise<boolean>
}

/** A callback's `user_id` is unsigned, so the clicker counts as a person only when the server says they are one and a member of the card's channel. */
export async function verifyMattermostCardActor(
  click: ChatCardClick,
  msg: Pick<RdMsgPlatformAction, 'payload'>,
  conn: unknown
): Promise<ChatCardClick> {
  if (!click.actor || click.actor.isBot !== undefined) return click
  const lookup = conn as Partial<CardActorLookup> | undefined
  const channelId = WireMattermostCardAction.safeParse(msg.payload).data?.channelId
  const userId = click.actor.userId
  let person = false
  if (channelId && typeof lookup?.getUserProfile === 'function' && typeof lookup.hasChannelMember === 'function') {
    const [profile, member] = await Promise.all([
      lookup.getUserProfile(userId).catch(() => undefined),
      lookup.hasChannelMember(channelId, userId).catch(() => false)
    ])
    person = profile?.isBot === false && member
  }
  return { ...click, actor: { ...click.actor, isBot: !person } }
}

export const mattermostCardClicks: RelayCardClicks = {
  decode: decodeMattermostCardClick,
  verifyActor: verifyMattermostCardActor,
  response: (privateText) =>
    ({
      ephemeralText: privateText.slice(0, clampSliceBeforeSurrogate(privateText, MATTERMOST_CARD_NOTE_MAX))
    }) satisfies WireMattermostCardActionResponse
}

export const mattermostPlatformModule: DaemonPlatformModule = {
  platformId: MATTERMOST_PLATFORM,
  cardClicks: mattermostCardClicks,
  canonicalizeThread: async (_host, msg: NormalizedMessage) => {
    if (msg.platform !== MATTERMOST_PLATFORM) return
    if (msg.isDm) {
      msg.thread = MATTERMOST_DM_THREAD
      return
    }
    msg.thread = msg.thread || nativeMessageId(msg.msgId)
  }
}
