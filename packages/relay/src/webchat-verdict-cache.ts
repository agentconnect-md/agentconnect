// Per-instance cache of `rc/verify` verdicts for webchat tokens and agent chat keys, each kept until its own expiry (shared-bot-relay.md §10.4).
import { createHash } from 'node:crypto'
import type { RcVerifyResult } from '@agentconnect.md/protocol'

// Bounds memory under a flood of distinct valid credentials; each entry lives minutes at most anyway.
const MAX_ENTRIES = 10_000

/** How long a verified credential keeps working without asking the CP again, so a revoked member or share stops within it (shared-bot-relay.md §10.4). */
export const VERDICT_TTL_MS = 60_000

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

/** Keyed by the hash of the verified arguments; `expiresAt` dates each verdict, and every entry of one cache shares a lifetime. */
export class WebchatVerdictCache<A extends string[] = [token: string]> {
  private readonly entries = new Map<string, Entry>()

  constructor(
    private readonly verifyWithCp: (...args: A) => Promise<RcVerifyResult>,
    private readonly now: () => number = Date.now,
    private readonly expiresAt: (args: A, verifiedAtMs: number) => number | undefined = (args, verifiedAtMs) => {
      const exp = webchatTokenExpiryMs(args[0]!)
      return exp === undefined ? undefined : Math.min(exp, verifiedAtMs + VERDICT_TTL_MS)
    }
  ) {}

  /** The cached verdict while it is live, else the CP's; failures and throws are never cached. */
  async verify(...args: A): Promise<WebchatVerdict> {
    const key = createHash('sha256').update(args.join('\0')).digest('hex')
    const hit = this.entries.get(key)
    if (hit) {
      if (hit.expiresAtMs > this.now()) return { ...structuredClone(hit.verdict), verifiedAtMs: hit.verifiedAtMs }
      this.entries.delete(key)
    }
    // Dated before the round trip: the CP reads the roster before its own awaits, so completion order must not rank verdicts.
    const verifiedAtMs = this.now()
    const verdict = await this.verifyWithCp(...args)
    const expiresAtMs = this.expiresAt(args, verifiedAtMs)
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
    // Entries share a lifetime, so insertion order is close to expiry order: drop from the front until one is live.
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
