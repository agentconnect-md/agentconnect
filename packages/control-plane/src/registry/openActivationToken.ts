/**
 * Shared codec for OPEN activation links — the second, email-agnostic flavor of
 * activation link (waitlist-and-login.md §6a). Same split of duties as
 * {@link ./waitlistJoinToken.ts}: the EXTERNAL admin app mints, the CP only
 * verifies on redeem, so both sides must use an identical algorithm / encoding /
 * version and the SAME pepper (`API_KEY_PEPPER`, injected via env, never stored,
 * never in this repository).
 *
 * How it differs from a `w1_` waitlist join link:
 *   • it is NOT bound to an email and needs no `waitlist_entry` row — whoever is
 *     signed in with ANY verified email may redeem it, so it can admit a person
 *     who never applied to the waitlist;
 *   • it is SINGLE-USE — the first account to redeem it consumes it (a repeat by
 *     that SAME account is idempotent; anybody else gets the opaque "unavailable").
 * Because it grants admission to an arbitrary email, the plaintext is bearer
 * material with no second factor: mint one link per invitee, keep the expiry
 * short (the minter writes `expiresAt`; 7 days is the intended default), and
 * revoke rather than reuse.
 *
 * Token shape: `oa1_<43 base62 chars>`. The `oa1_` prefix is an explicit VERSION
 * so the scheme can be rotated later; the CP treats any other/absent version as
 * an invalid token. The version prefix is part of the hashed material, so a token
 * cannot be replayed under a different version, and the HMAC domain differs from
 * both the waitlist-join and org-invite domains — the same plaintext can never
 * validate against a link of another kind under the same pepper.
 */
import { createHmac, randomBytes } from 'node:crypto'

const VERSION = 'oa1'
const BODY_LENGTH = 43 // ~256 bits of base62 entropy
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const TOKEN_RE = new RegExp(`^${VERSION}_[0-9A-Za-z]{${BODY_LENGTH}}$`)
const HASH_DOMAIN = `agentconnect:open-activation:${VERSION}\0`

export interface MintedOpenActivationToken {
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

export class OpenActivationTokenCodec {
  constructor(private readonly pepper: string) {}

  /** Exists so tests can round-trip and so this file documents the exact algorithm
   *  the external minter must replicate; the CP itself only ever needs {@link hash}. */
  mint(): MintedOpenActivationToken {
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
