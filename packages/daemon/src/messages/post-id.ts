import { createHash } from 'node:crypto'
import { z } from 'zod'

const uuid = z.string().uuid()

// Webchat post ids are UUIDs, but AHP clients such as VS Code mint `request_<uuid>` turn ids, so derive a stable v8 one.
export function canonicalPostId(id: string): string {
  if (uuid.safeParse(id).success) return id
  const hex = createHash('sha256').update(`agentconnect-post:${id}`).digest('hex')
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
