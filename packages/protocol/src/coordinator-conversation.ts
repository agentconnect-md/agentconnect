import { createHash } from 'node:crypto'

// auto-session-mode.md §10: the namespace of a member's private coordinator conversations, fixed so every host derives the same ids.
const COORDINATOR_CONVERSATION_NAMESPACE = '6f0c8a52-3d1e-4b7a-9c25-8e41d7a0b3f6'

/** A name-based (version 5) UUID of `name` in `namespace`, per RFC 9562 §5.5. */
export function uuidV5(namespace: string, name: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The webchat conversation a member has with an agent's coordinator: derived, so the Control Plane mints it and the daemon recognizes it with nothing stored. */
export function coordinatorConversationId(orgId: string, userId: string, agentId: string): string {
  return uuidV5(COORDINATOR_CONVERSATION_NAMESPACE, `${orgId}\u001f${userId}\u001f${agentId}`)
}
