// Browser port of the CP conversation-key codec
// (packages/control-plane/src/http/conversation-key.ts,
// merged-conversation-view.md §5.1). Keep the two in byte-for-byte agreement —
// the CP decodes what this encodes.

export interface ConversationKeyParts {
  platform: string
  tenantScope: string | null
  channel: string | null
  thread: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SEP = '\u0000'

export function encodeConversationKey(key: ConversationKeyParts): string | null {
  if (key.channel === null || key.thread === null) return null
  if (key.platform === 'webchat') return key.channel
  const raw = [key.platform, key.tenantScope ?? '', key.channel, key.thread].join(SEP)
  const bytes = new TextEncoder().encode(raw)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function isWebchatConversationKey(key: string): boolean {
  return UUID_RE.test(key)
}
