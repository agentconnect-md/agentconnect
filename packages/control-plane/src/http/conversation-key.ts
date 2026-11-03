import type { ConversationKey } from '../persistence/ports.js'

// Conversation key codec (merged-conversation-view.md §5.1): a bare id for an ordinary webchat thread, else base64url of the four NUL-joined parts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEP = '\u0000'

export function encodeConversationKey(key: ConversationKey): string | null {
  if (key.channel === null || key.thread === null) return null
  // Only the thread `decode` restores may collapse: a coordinator's `append:` thread on the same channel would resolve to nothing.
  if (key.platform === 'webchat' && UUID_RE.test(key.channel) && key.thread === `webchat:${key.channel}`) {
    return key.channel
  }
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
