import type { ConversationKey } from '../persistence/ports.js'

/**
 * Conversation key codec (merged-conversation-view.md §5.1).
 *
 * - Webchat: the bare conversation id (a CP-minted UUID; the session row's
 *   `channel` == `thread` == the conversation id).
 * - Everything else: base64url of `platform NUL tenantScope NUL channel NUL
 *   thread` — NUL can appear in none of the parts, and base64url keeps the key
 *   path/query safe.
 *
 * Singleton conversations (NULL channel or thread) are not key-addressable;
 * `encode` returns null for them and callers use the ordinary session routes.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEP = '\u0000'

export function encodeConversationKey(key: ConversationKey): string | null {
  if (key.channel === null || key.thread === null) return null
  if (key.platform === 'webchat') return key.channel
  return Buffer.from([key.platform, key.tenantScope ?? '', key.channel, key.thread].join(SEP), 'utf8').toString(
    'base64url'
  )
}

export function decodeConversationKey(raw: string): ConversationKey | null {
  // The webchat session key's thread segment is the PREFIXED msgId form the
  // daemon records (`webchat:<conversationId>`), not the bare id — the
  // resolver must match rows as they are actually reported.
  if (UUID_RE.test(raw)) return { platform: 'webchat', tenantScope: null, channel: raw, thread: `webchat:${raw}` }
  const decoded = Buffer.from(raw, 'base64url').toString('utf8')
  const parts = decoded.split(SEP)
  if (parts.length !== 4 || !parts[0] || !parts[2] || !parts[3]) return null
  return { platform: parts[0]!, tenantScope: parts[1]! || null, channel: parts[2]!, thread: parts[3]! }
}
