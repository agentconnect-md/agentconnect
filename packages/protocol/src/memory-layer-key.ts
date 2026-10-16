import { createHash } from 'node:crypto'

// The folder names of a managed store's layers: the daemon writes them and a Control-Plane home's console reads resolve them, so both derive them here.

/** A place layer's folder: a readable prefix plus a short digest, so distinct (transportScope, channel) pairs never collide after sanitization. */
export function memoryChannelKey(channel: string, transportScope?: string): string {
  return memoryFolderKey(transportScope ? `${transportScope}::${channel}` : channel)
}

/** The folder name of one person's layer, from their identity (`user:<id>` or `<platform>:<scope>:<uid>`). */
export function memoryPersonKey(identity: string): string {
  return memoryFolderKey(identity)
}

function memoryFolderKey(raw: string): string {
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12)
  const prefix = raw
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
  return prefix ? `${prefix}-${digest}` : digest
}
