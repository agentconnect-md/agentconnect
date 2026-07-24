/**
 * Shared codec for waitlist join (activation) links — the ONE algorithm both the
 * external admin app (which MINTS) and the CP (which VERIFIES on redeem) must agree
 * on. Because the hash is written by the
 * admin app and compared by the CP, the two sides must use an identical
 * algorithm / encoding / version and the SAME pepper (injected via env, never
 * stored, never in this repository — same discipline as API_KEY_PEPPER).
 *
 * Token shape: `w1_<43 base62 chars>`. The `w1_` prefix is an explicit VERSION so
 * the scheme can be rotated later; the CP treats any other/absent version as an
 * invalid token (§6). The version prefix is part of the hashed material, so a
 * token cannot be replayed under a different version. base62 (not base64url) keeps
 * the plaintext URL- and copy-paste-safe with no special characters.
 *
 * The CP only ever needs {@link hash} + validation on redeem; {@link mint} exists
 * so tests can round-trip and so this file documents the exact algorithm the
 * external minter must replicate.
 */
import { createHmac, randomBytes } from 'node:crypto'

const VERSION = 'w1'
const BODY_LENGTH = 43 // ~256 bits of base62 entropy
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const TOKEN_RE = new RegExp(`^${VERSION}_[0-9A-Za-z]{${BODY_LENGTH}}$`)
// Domain separation + version binding, so this HMAC can never collide with the
// org-invite HMAC (different domain string) even under the same pepper.
const HASH_DOMAIN = `agentconnect:waitlist-join:${VERSION}\0`

export interface MintedJoinToken {
  token: string
  hash: string
  displayTail: string
}

/** Unbiased base62 string of the given length via rejection sampling. */
function base62(length: number): string {
  const out: string[] = []
  while (out.length < length) {
    for (const b of randomBytes(length)) {
      if (b >= 248) continue // 248 = 4*62 — reject the biased tail
      out.push(BASE62.charAt(b % 62))
      if (out.length === length) break
    }
  }
  return out.join('')
}

export class WaitlistJoinTokenCodec {
  constructor(private readonly pepper: string) {}

  mint(): MintedJoinToken {
    const body = base62(BODY_LENGTH)
    const token = `${VERSION}_${body}`
    return { token, hash: this.hashUnchecked(token), displayTail: `…${body.slice(-6)}` }
  }

  /** Peppered hash of a well-formed, current-version token; null for anything else
   *  (malformed OR a different version — a version mismatch is treated as invalid). */
  hash(token: string): string | null {
    return TOKEN_RE.test(token) ? this.hashUnchecked(token) : null
  }

  private hashUnchecked(token: string): string {
    return createHmac('sha256', this.pepper).update(HASH_DOMAIN).update(token).digest('hex')
  }
}
