// The Computer channel's short-lived key (computer-use.md §8.2): derived, never stored, renewed only over a live channel.
import { createHmac } from 'node:crypto'
import type { ComputerChannelCredential } from '@agentconnect.md/protocol'

/** Derives each Computer's channel key per window, so any replica mints the same key without storing it. */
export class ComputerChannelKeys {
  private readonly base: Buffer
  readonly ttlMs: number

  constructor(pepper: string, ttlSec: number) {
    // Domain-separated from every other use of the pepper.
    this.base = createHmac('sha256', pepper).update('agentconnect/computer-channel-key/v1').digest()
    this.ttlMs = ttlSec * 1000
  }

  /** A new key every half lifetime, each valid a full lifetime from its window start, so a renewal always overlaps. */
  current(computerId: string, apiKeyId: string, nowMs: number): ComputerChannelCredential {
    const windowMs = this.ttlMs / 2
    const start = Math.floor(nowMs / windowMs) * windowMs
    return {
      keyId: String(start),
      key: this.derive(computerId, apiKeyId, start).toString('base64url'),
      issuedAt: new Date(start).toISOString(),
      expiresAt: new Date(start + this.ttlMs).toISOString()
    }
  }

  /** The key a channel token names by id, or null once it expired or for an id this deriver never issues. */
  keyFor(computerId: string, apiKeyId: string, keyId: string, nowMs: number): Buffer | null {
    const start = Number(keyId)
    const windowMs = this.ttlMs / 2
    if (!Number.isSafeInteger(start) || start % windowMs !== 0) return null
    if (start > nowMs || start + this.ttlMs <= nowMs) return null
    return this.derive(computerId, apiKeyId, start)
  }

  private derive(computerId: string, apiKeyId: string, start: number): Buffer {
    return createHmac('sha256', this.base).update(`${computerId}\n${apiKeyId}\n${start}`).digest()
  }
}
