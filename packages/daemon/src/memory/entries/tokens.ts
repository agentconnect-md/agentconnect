import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { MemoryEntriesError, type EntryCoordinate } from './contract.js'

// A persisted daemon key keeps entry references valid across worker restarts without exposing backend IDs.
export class MemoryEntryTokens {
  constructor(private readonly key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error('memory entry token key must be 32 bytes')
  }

  ref(view: string, coordinate: EntryCoordinate): string {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from('agentconnect.memory.entries/v1'))
    const body = Buffer.concat([cipher.update(JSON.stringify({ view, ...coordinate }), 'utf8'), cipher.final()])
    const token = Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64url')
    if (token.length > 4096) throw new MemoryEntriesError('TOO_LARGE', 'memory reference exceeds its byte budget')
    return token
  }

  coordinate(view: string, token: string): EntryCoordinate {
    try {
      const bytes = Buffer.from(token, 'base64url')
      if (token.length > 4096 || bytes.toString('base64url') !== token) throw new Error('invalid encoding')
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12))
      decipher.setAAD(Buffer.from('agentconnect.memory.entries/v1'))
      decipher.setAuthTag(bytes.subarray(12, 28))
      const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'))
      if (value.view !== view || typeof value.id !== 'string' || typeof value.partition !== 'string')
        throw new Error('invalid view')
      return { id: value.id, partition: value.partition }
    } catch {
      throw new MemoryEntriesError('STALE_BINDING', 'memory reference does not belong to the current view')
    }
  }
}
