/**
 * API-key mint / parse / hash (design: docs/designs/daemon-api-key-auth.md §3).
 *
 * The daemon credential is a long-lived, opaque API key
 *   `<secret><crc>`
 * — a bare base62 string (no prefix, no role): `<secret>` is 256 bits of CSPRNG
 * entropy and `<crc>` is a 6-char base62 CRC32 typo-guard over the secret. The CP
 * stores ONLY `hash = HMAC-SHA256(secret, API_KEY_PEPPER)` (hex), unique-indexed, and
 * looks a key up by that hash. The plaintext is shown once at mint and never
 * persisted. There is no keyId and no role in the token: the peppered hash IS the
 * lookup key (an attacker can't grind the index, and a stolen hash isn't invertible),
 * and the principal kind (daemon | user) lives only in the `api_key` row.
 *
 * `node:crypto` is the only dependency; the pepper is injected via config so tests
 * construct a codec with a fixed pepper.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Result of a successful {@link ApiKeyCodec.parse}. */
export interface ParsedKey {
  /** The secret segment (token minus the trailing CRC) — feed to {@link ApiKeyCodec.hash}. */
  secret: string
}

/** A freshly minted key: the one-time plaintext plus what the DB stores. */
export interface MintedKey {
  /** Full plaintext `<secret><crc>` — returned to the operator exactly once. */
  token: string
  /** `HMAC-SHA256(secret, pepper)` hex — the unique lookup key persisted in `api_key.hash`. */
  hash: string
  /** Non-secret console label, e.g. `…a2b1`. */
  displayTail: string
}

/** Config slice the codec needs (a subset of `AppConfig`). */
export interface ApiKeyConfig {
  /** HMAC pepper; required, ≥32 chars. Effectively immutable (rotating it invalidates every hash). */
  API_KEY_PEPPER: string
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SECRET_LEN = 43 // 62^43 > 2^256 — ≥256 bits of entropy
const CRC_LEN = 6 // 62^6 > 2^32 — holds a full CRC32

/** `n` base62 chars from the CSPRNG, rejection-sampled to avoid modulo bias. */
function randomBase62(n: number): string {
  let out = ''
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < 248) {
        // 248 = 62*4: bytes 0..247 map uniformly onto 0..61
        out += BASE62[b % 62]
        if (out.length === n) break
      }
    }
  }
  return out
}

/** CRC32 (IEEE 802.3, poly 0xEDB88320) of an ASCII string → uint32. */
function crc32(s: string): number {
  let crc = 0xffffffff
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) & 0xff
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Encode the CRC32 of `input` as exactly `CRC_LEN` base62 chars (zero-padded). */
function base62Crc(input: string): string {
  let n = crc32(input)
  let out = ''
  for (let i = 0; i < CRC_LEN; i++) {
    out = BASE62[n % 62] + out
    n = Math.floor(n / 62)
  }
  return out
}

export class ApiKeyCodec {
  private readonly pepper: string

  constructor(config: ApiKeyConfig) {
    this.pepper = config.API_KEY_PEPPER
  }

  /** Mint a new key. The plaintext `token` is the only place the secret exists. The
   *  principal kind is set on the `api_key` row, not encoded in the token. */
  mint(): MintedKey {
    const secret = randomBase62(SECRET_LEN)
    const token = `${secret}${base62Crc(secret)}`
    return {
      token,
      hash: this.hash(secret),
      displayTail: `…${secret.slice(-4)}`
    }
  }

  /**
   * Parse + validate a presented token offline (no DB). Returns the secret, or `null`
   * on any charset/length/CRC failure (→ caller closes `4401`). The CRC is a non-secret
   * typo guard, so a plain (non-constant-time) compare is fine here.
   */
  parse(raw: string): ParsedKey | null {
    if (!/^[0-9A-Za-z]+$/.test(raw)) return null
    if (raw.length <= CRC_LEN) return null
    const crc = raw.slice(-CRC_LEN)
    const secret = raw.slice(0, -CRC_LEN)
    if (crc !== base62Crc(secret)) return null
    return { secret }
  }

  /** `HMAC-SHA256(secret, pepper)` as hex — the value stored/looked-up in `api_key.hash`. */
  hash(secret: string): string {
    return createHmac('sha256', this.pepper).update(secret).digest('hex')
  }

  /** Constant-time hex-hash comparison (defensive; the DB lookup already gates this). */
  static hashEquals(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    return timingSafeEqual(Buffer.from(a), Buffer.from(b))
  }
}
