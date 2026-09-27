// Per-instance cache of `rc/verify(webchat-token)` verdicts, keyed by the token's hash until its `exp` (shared-bot-relay.md §10.4).
import { createHash } from 'node:crypto'
import type { RcVerifyResult } from '@agentconnect.md/protocol'

// Bounds memory under a flood of distinct valid tokens; each lives at most five minutes anyway.
const MAX_ENTRIES = 10_000

interface Entry {
  verdict: RcVerifyResult
  expiresAtMs: number
  verifiedAtMs: number
}

/** A verdict plus the moment the CP produced it, so a cached one can never outrank a fresher roster. */
export type WebchatVerdict = RcVerifyResult & { verifiedAtMs?: number }

/** The token's `exp` in epoch ms, read without verification (the CP verified the signature), or undefined. */
export function webchatTokenExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

export class WebchatVerdictCache {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly verifyWithCp: (token: string) => Promise<RcVerifyResult>,
    private readonly now: () => number = Date.now
  ) {}

  /** The cached verdict while the token is live, else the CP's; failures and throws are never cached. */
  async verify(token: string): Promise<WebchatVerdict> {
    const key = createHash('sha256').update(token).digest('hex')
    const hit = this.entries.get(key)
    if (hit) {
      if (hit.expiresAtMs > this.now()) return { ...structuredClone(hit.verdict), verifiedAtMs: hit.verifiedAtMs }
      this.entries.delete(key)
    }
    const verdict = await this.verifyWithCp(token)
    const verifiedAtMs = this.now()
    const expiresAtMs = webchatTokenExpiryMs(token)
    if (verdict.ok && expiresAtMs !== undefined && expiresAtMs > verifiedAtMs) {
      this.sweep()
      this.entries.set(key, { verdict: structuredClone(verdict), expiresAtMs, verifiedAtMs })
    }
    return { ...verdict, verifiedAtMs }
  }

  size(): number {
    return this.entries.size
  }

  private sweep(): void {
    const now = this.now()
    // Every token has the same TTL, so insertion order is close to expiry order: drop from the front until one is live.
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs > now) break
      this.entries.delete(key)
    }
    while (this.entries.size >= MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }
}
