import type { Attachment, NormalizedMessage } from '../messages/normalized.js'

/**
 * Feishu inbound normalization. Mirrors discord/normalize.ts: a pure function over
 * a minimal, plain-object view of an `im.message.receive_v1` event so it is
 * unit-testable without a live SDK event. `feishu/connection.ts` adapts the real
 * WSClient event body into `FeishuMessageLike` before calling in.
 *
 * Channel/thread model: Feishu groups DO have topic threads — replying to a
 * message opens/continues one. `channel` is always the `chat_id`; `thread` is the
 * topic root: a group turn keys on the thread's root message id (`root_id` on replies,
 * else the triggering message's own id when it opens the thread), so the whole thread is
 * one session AND the key doubles as the reply anchor (see `FeishuConnection.postMessage`)
 * so the agent's replies land in the thread rather than flat in the chat. A p2p DM has no
 * threads, so it keys on `chat_id` — the whole DM is one continuous session.
 *
 * ATTACHMENTS: unlike Discord's public CDN url, Feishu ships an opaque
 * `image_key`/`file_key` (not a URL) that needs the message_id + a tenant token to
 * fetch (like Slack). We encode the compound download key into `sourceUrl` as
 * `<messageId>:<type>:<fileKey>` so the single-arg generic downloadAttachment path
 * round-trips it back to `FeishuConnection.downloadFile`, which needs both ids.
 *
 * MENTIONS: `mentionedBots` carries the `open_id` of every mentioned party (from
 * `message.mentions[].id.open_id`), so the daemon can match the bot's own open_id
 * for routing (Feishu routes on open_id, where Discord routes on numeric user id).
 */

/** A mention entry from `event.message.mentions[]`: `key` is the in-text placeholder
 *  (`@_user_1`), `id.open_id` the mentioned party, `name` the display name. */
export interface FeishuMention {
  key: string
  id?: { open_id?: string }
  name?: string
}

/** Attachment view for image/file messages. Feishu ships an opaque `file_key`/`image_key`
 *  (not a URL) that needs message_id + tenant token to fetch (like Slack, unlike Discord). */
export interface FeishuAttachmentLike {
  fileKey: string // image_key (image) or file_key (file)
  type: 'image' | 'file' // → messageResource.get params.type
  name?: string
  mimeType?: string
  size?: number
}

/** Plain-object view of an `im.message.receive_v1` event body — the connection adapts the
 *  SDK event into this so the normalizer is pure/unit-testable without a live WSClient. */
export interface FeishuMessageLike {
  messageId: string // message.message_id
  chatId: string // message.chat_id
  chatType: 'p2p' | 'group' | string // message.chat_type
  messageType: string // message.message_type ('text'|'post'|'image'|'file'|…)
  content: string // message.content — a JSON string
  rootId?: string // message.root_id — the topic thread's root message id (thread replies only)
  senderOpenId: string // sender.sender_id.open_id
  senderIsBot?: boolean // best-effort (sender.sender_type); default false
  mentions?: FeishuMention[] // message.mentions
  attachments?: FeishuAttachmentLike[] // derived by the connection from content by type
}

/** The `sourceUrl` field separator for the compound Feishu download key. A Feishu
 *  message_id (`om_…`) / image_key / file_key never contains a colon, so a plain
 *  `:` join round-trips unambiguously (the connection splits messageId + type off
 *  the front and rejoins the remainder as the file key, colon-safe by construction). */
const DOWNLOAD_KEY_SEP = ':'

/** Map a Feishu attachment to a NormalizedMessage Attachment. `sourceUrl` encodes the
 *  compound download key `<messageId>:<type>:<fileKey>` so the single-arg generic
 *  downloadAttachment path (`replyConnFor(id).downloadFile(att.sourceUrl)`) round-trips
 *  it to `FeishuConnection.downloadFile`, which needs BOTH ids. Null when unusable. */
export function toAttachment(a: FeishuAttachmentLike | null | undefined, messageId: string): Attachment | null {
  if (!a || typeof a !== 'object' || !a.fileKey || !messageId) return null
  if (a.type !== 'image' && a.type !== 'file') return null
  const sourceUrl = [messageId, a.type, a.fileKey].join(DOWNLOAD_KEY_SEP)
  return {
    id: a.fileKey,
    name: a.name ?? a.fileKey,
    mimeType: a.mimeType ?? 'application/octet-stream',
    ...(typeof a.size === 'number' ? { size: a.size } : {}),
    sourceUrl
  }
}

/**
 * Replace Feishu @-placeholders (`@_user_1`) with a readable `@name` drawn from the
 * `mentions[]` map — the analog of humanizeDiscordText / Telegram entity handling, so
 * the agent sees names not raw tokens. Each mention's `key` (e.g. `@_user_1`) is the
 * literal placeholder that appears in the text; we swap it for `@<name>` (falling back
 * to `@<open_id>` when the display name is missing, and leaving the placeholder as-is
 * when neither is known). Pure — no name cache.
 */
export function humanizeFeishuText(text: string, mentions?: FeishuMention[]): string {
  if (!text || !mentions?.length) return text
  let out = text
  // Longest key first: `@_user_1` is a prefix of `@_user_10`, so replacing the
  // short key first would corrupt the longer placeholder (→ `@name0`).
  const ordered = [...mentions].sort((a, b) => (b?.key?.length ?? 0) - (a?.key?.length ?? 0))
  for (const m of ordered) {
    if (!m?.key) continue
    const label = m.name ?? m.id?.open_id
    if (!label) continue
    out = out.split(m.key).join(`@${label}`)
  }
  return out
}

/** Flatten a Feishu `post` rich-text body to plain text. The content is either a
 *  language-keyed object (`{ zh_cn: { title, content } }`) or a bare
 *  `{ title, content }`; `content` is an array of lines, each an array of tag
 *  segments (`text`/`a` carry `.text`, `at` carries a user name/id). */
function flattenPost(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object') return ''
  const obj = parsed as Record<string, unknown>
  // Bare {title, content} or language-keyed {zh_cn: {…}} — pick the first node
  // that carries a `content` array.
  let node: Record<string, unknown> | undefined
  if (Array.isArray(obj.content)) node = obj
  else {
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).content)) {
        node = v as Record<string, unknown>
        break
      }
    }
  }
  if (!node) return ''
  const lines = node.content as unknown[]
  const title = typeof node.title === 'string' ? node.title : ''
  const body = lines
    .map((line) => {
      if (!Array.isArray(line)) return ''
      return line
        .map((seg) => {
          if (!seg || typeof seg !== 'object') return ''
          const s = seg as Record<string, unknown>
          if (s.tag === 'at') {
            const name = (s.user_name ?? s.user_id) as string | undefined
            return name ? `@${name}` : ''
          }
          return typeof s.text === 'string' ? s.text : ''
        })
        .join('')
    })
    .join('\n')
  return [title, body].filter(Boolean).join('\n')
}

/** Extract the readable text of a Feishu message by its type: `text` → the `.text`
 *  field of the JSON body; `post` → flattened rich text; everything else (image, file,
 *  audio, …) → '' (the content is carried as an attachment, not text). Never throws —
 *  malformed JSON yields ''. */
function extractText(messageType: string, content: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return ''
  }
  if (messageType === 'text') {
    const t = (parsed as Record<string, unknown>)?.text
    return typeof t === 'string' ? t : ''
  }
  if (messageType === 'post') return flattenPost(parsed)
  return ''
}

/** Normalize a Feishu event into the platform-agnostic contract. */
export function normalizeFeishuMessage(msg: FeishuMessageLike, ctx: { traceId: string }): NormalizedMessage {
  const attachments = (msg.attachments ?? [])
    .map((a) => toAttachment(a, msg.messageId))
    .filter((a): a is Attachment => a !== null)
  const isDm = msg.chatType === 'p2p'
  const text = humanizeFeishuText(extractText(msg.messageType, msg.content), msg.mentions)
  const mentionedBots = (msg.mentions ?? [])
    .map((m) => m?.id?.open_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  // Session/thread key: a GROUP conversation happens in a Feishu topic thread rooted at
  // the triggering @mention, so key on that root message id (`root_id` on thread replies,
  // else this message's own id when it starts the thread) — stable across the whole thread,
  // and it doubles as the reply anchor so the agent's replies land IN the thread. A p2p DM
  // has no threads: key on the chat id so the whole DM is one continuous session.
  const thread = isDm ? msg.chatId : (msg.rootId ?? msg.messageId)
  return {
    msgId: `feishu:${msg.chatId}:${msg.messageId}`,
    traceId: ctx.traceId,
    source: 'user',
    platform: 'feishu',
    channel: msg.chatId,
    thread,
    sender: { id: msg.senderOpenId, isBot: msg.senderIsBot ?? false },
    text,
    mentionedBots,
    ...(attachments.length ? { attachments } : {}),
    isDm
  }
}
